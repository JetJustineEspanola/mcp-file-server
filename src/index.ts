import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  readdir,
  readFile,
  writeFile,
  unlink,
  realpath,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const projectRoot = path.resolve(process.cwd());
const workspace = path.join(projectRoot, "workspace");

const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_QUERY_LENGTH = 500;
const MAX_WRITE_BYTES = 1 * 1024 * 1024;

function createMcpServer() {
  const server = new McpServer({
    name: "mcp-file-server",
    version: "1.1.0",
  });

  function result(message: string) {
    return {
      content: [{ type: "text" as const, text: message }],
    };
  }

  function failure(error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return {
      ...result(`Error: ${message}`),
      isError: true,
    };
  }

  function isInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);

    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
  }

  // Reject symbolic links in every existing path component.
  async function safePath(
    relativePath: string,
    allowMissing = false,
  ): Promise<string> {
    if (!relativePath.trim()) {
      throw new Error("A file or directory path is required.");
    }

    if (relativePath.includes("\0")) {
      throw new Error("Invalid path.");
    }

    const root = await realpath(workspace);
    const target = path.resolve(root, relativePath);

    if (!isInside(root, target)) {
      throw new Error("Path is outside the workspace.");
    }

    const relative = path.relative(root, target);
    const parts = relative ? relative.split(path.sep) : [];
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);

      try {
        const info = await lstat(current);

        if (info.isSymbolicLink()) {
          throw new Error("Symbolic links are not allowed.");
        }

        if (i < parts.length - 1 && !info.isDirectory()) {
          throw new Error("A parent path is not a directory.");
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "Symbolic links are not allowed." ||
            error.message === "A parent path is not a directory.")
        ) {
          throw error;
        }

        if (!allowMissing || i !== parts.length - 1) {
          throw error;
        }

        // The final item may be missing for a new file.
        // Its parent must already exist and have been checked.
        break;
      }
    }

    return target;
  }

  async function readLimited(filePath: string): Promise<string> {
    const info = await lstat(filePath);

    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Only regular files can be read.");
    }

    if (info.size > MAX_FILE_BYTES) {
      throw new Error("File exceeds the 1 MB read limit.");
    }

    const content = await readFile(filePath);

    if (content.length > MAX_FILE_BYTES) {
      throw new Error("File exceeds the 1 MB read limit.");
    }

    return content.toString("utf8");
  }

  async function writeLimited(
    filePath: string,
    content: string,
  ): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      throw new Error("Content exceeds the 1 MB write limit.");
    }

    // Recheck the destination immediately before writing.
    try {
      const info = await lstat(filePath);

      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("Destination must be a regular file.");
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }

    await writeFile(filePath, content, {
      encoding: "utf8",
      flag: "w",
    });
  }

  // 1. LIST FILES
  server.registerTool(
    "list_files",
    {
      description: "List files and directories inside the workspace.",
      inputSchema: {
        directory: z.string().max(500).optional(),
      },
    },
    async ({ directory }) => {
      try {
        const target = await safePath(directory ?? ".");
        const entries = await readdir(target, { withFileTypes: true });

        return result(
          JSON.stringify(
            entries.map((entry) => ({
              name: entry.name,
              type: entry.isDirectory()
                ? "directory"
                : entry.isSymbolicLink()
                  ? "symlink"
                  : "file",
            })),
            null,
            2,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  // 2. READ FILE
  server.registerTool(
    "read_file",
    {
      description: "Read a UTF-8 text file inside the workspace.",
      inputSchema: {
        filePath: z.string().min(1).max(500),
      },
    },
    async ({ filePath }) => {
      try {
        const target = await safePath(filePath);
        return result(await readLimited(target));
      } catch (error) {
        return failure(error);
      }
    },
  );

  // 3. WRITE FILE
  server.registerTool(
    "write_file",
    {
      description: "Create or overwrite a text file inside the workspace.",
      inputSchema: {
        filePath: z.string().min(1).max(500),
        content: z.string().max(MAX_WRITE_BYTES),
      },
    },
    async ({ filePath, content }) => {
      try {
        const target = await safePath(filePath, true);
        await writeLimited(target, content);
        return result(`File saved: ${filePath}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  // 4. REPLACE TEXT
  server.registerTool(
    "str_replace",
    {
      description: "Replace the first occurrence of text in a workspace file.",
      inputSchema: {
        filePath: z.string().min(1).max(500),
        oldText: z.string().min(1).max(MAX_FILE_BYTES),
        newText: z.string().max(MAX_FILE_BYTES),
      },
    },
    async ({ filePath, oldText, newText }) => {
      try {
        const target = await safePath(filePath);
        const content = await readLimited(target);

        if (!content.includes(oldText)) {
          return failure(new Error("The requested text was not found."));
        }

        await writeLimited(target, content.replace(oldText, newText));

        return result(`Text replaced in: ${filePath}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  // 5. DELETE FILE
  server.registerTool(
    "delete_file",
    {
      description: "Delete a regular file inside the workspace.",
      inputSchema: {
        filePath: z.string().min(1).max(500),
      },
    },
    async ({ filePath }) => {
      try {
        const target = await safePath(filePath);
        const info = await lstat(target);

        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error("Only regular files can be deleted.");
        }

        await unlink(target);
        return result(`File deleted: ${filePath}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  // 6. SEARCH FILES
  server.registerTool(
    "search_files",
    {
      description: "Search text files in the workspace for a phrase.",
      inputSchema: {
        query: z.string().min(1).max(MAX_SEARCH_QUERY_LENGTH),
      },
    },
    async ({ query }) => {
      try {
        const root = await realpath(workspace);
        const matches: string[] = [];
        const ignored = new Set(["node_modules", ".git", "dist"]);
        let scanned = 0;

        async function searchDirectory(directory: string): Promise<void> {
          const entries = await readdir(directory, { withFileTypes: true });

          for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;

            if (scanned >= MAX_SEARCH_FILES) return;
            if (matches.length >= MAX_SEARCH_MATCHES) return;

            if (ignored.has(entry.name)) continue;

            const fullPath = path.join(directory, entry.name);

            if (!isInside(root, fullPath)) continue;

            if (entry.isDirectory()) {
              await searchDirectory(fullPath);
            } else if (entry.isFile()) {
              scanned++;

              try {
                const info = await lstat(fullPath);

                if (info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
                  continue;
                }

                const content = await readFile(fullPath, "utf8");

                if (content.includes(query)) {
                  matches.push(path.relative(root, fullPath));
                }
              } catch {
                // Skip files that cannot be read.
              }
            }
          }
        }

        await searchDirectory(root);

        const summary =
          `Files scanned: ${scanned}` +
          (scanned >= MAX_SEARCH_FILES ? " (scan limit reached)" : "") +
          `\nMatches:\n`;

        return result(
          summary +
            (matches.length ? matches.join("\n") : "No matching files found."),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  // Run fixed Git commands without invoking a shell.
  async function runGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectRoot, ...args],
      {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );

    return stdout || "(No output)";
  }

  // 7. GIT STATUS
  server.registerTool(
    "git_status",
    {
      description: "Show the Git working-tree status of the project.",
      inputSchema: {},
    },
    async () => {
      try {
        return result(await runGit(["status", "--short"]));
      } catch (error) {
        return failure(error);
      }
    },
  );

  // 8. GIT DIFF
  server.registerTool(
    "git_diff",
    {
      description: "Show unstaged Git changes.",
      inputSchema: {},
    },
    async () => {
      try {
        return result(await runGit(["diff", "--"]));
      } catch (error) {
        return failure(error);
      }
    },
  );

  // 9. GIT LOG
  server.registerTool(
    "git_log",
    {
      description: "Show the latest five Git commits.",
      inputSchema: {},
    },
    async () => {
      try {
        return result(await runGit(["log", "-5", "--oneline", "--decorate"]));
      } catch (error) {
        return failure(error);
      }
    },
  );

  // 10. GET PROJECT STATE
  server.registerTool(
    "get_project_state",
    {
      description: "Read the shared PROJECT_STATE.md file.",
      inputSchema: {},
    },
    async () => {
      try {
        const target = await safePath("PROJECT_STATE.md");
        return result(await readLimited(target));
      } catch (error) {
        return failure(error);
      }
    },
  );
  return server;
}

const mode = process.env.MCP_TRANSPORT ?? "stdio";

if (mode === "stdio") {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
} else if (mode === "http") {
  const app = express();
  const port = Number(process.env.PORT ?? "3000");
  const token = process.env.MCP_AUTH_TOKEN;

  if (!token || token.length < 32) {
    throw new Error(
      "Set MCP_AUTH_TOKEN to a secret of at least 32 characters.",
    );
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }

  function authenticated(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    const header = req.header("authorization") ?? "";
    const supplied = header.startsWith("Bearer ")
      ? Buffer.from(header.slice(7))
      : Buffer.alloc(0);
    const expected = Buffer.from(token ?? "");

    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(
        supplied.length === expected.length ? supplied : expected,
        expected,
      ) ||
      !header.startsWith("Bearer ")
    ) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  }

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Each connected MCP client gets its own transport/session.
  // All sessions still use the same shared workspace directory.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.all("/mcp", authenticated, async (req, res) => {
    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader)
        ? sessionIdHeader[0]
        : sessionIdHeader;

      if (sessionId) {
        const transport = transports.get(sessionId);

        if (!transport) {
          res.status(404).json({ error: "Unknown MCP session." });
          return;
        }

        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Only initialization requests may create a new session.
      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        res.status(400).json({
          error:
            "A valid MCP initialize request is required to start a session.",
        });
        return;
      }

      const server = createMcpServer();
      let transport!: StreamableHTTPServerTransport;
      let newSessionId: string | undefined;

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(24).toString("hex"),
        onsessioninitialized: (id) => {
          newSessionId = id;
          transports.set(id, transport);
        },
        onsessionclosed: (id) => {
          transports.delete(id);
        },
      });

      transport.onclose = () => {
        if (newSessionId) {
          transports.delete(newSessionId);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  app.listen(port, "127.0.0.1", () => {
    console.log(`MCP HTTP endpoint listening at http://127.0.0.1:${port}/mcp`);
  });
} else {
  throw new Error('MCP_TRANSPORT must be "stdio" or "http".');
}
