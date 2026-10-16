import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdir, readFile, writeFile, unlink, realpath, } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const workspace = path.resolve(process.cwd(), "workspace");
const projectRoot = process.cwd();
const server = new McpServer({
    name: "mcp-file-server",
    version: "1.0.0",
});
// Resolve a path and reject paths outside the workspace.
// This is an initial safeguard. We will harden file operations later.
async function safePath(relativePath, allowMissing = false) {
    const root = await realpath(workspace);
    const target = path.resolve(root, relativePath);
    const relative = path.relative(root, target);
    if (relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
        throw new Error("Path is outside the workspace.");
    }
    try {
        const resolved = await realpath(target);
        const resolvedRelative = path.relative(root, resolved);
        if (resolvedRelative === ".." ||
            resolvedRelative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(resolvedRelative)) {
            throw new Error("Path is outside the workspace.");
        }
        return resolved;
    }
    catch (error) {
        if (!allowMissing)
            throw error;
        const parent = await realpath(path.dirname(target));
        const parentRelative = path.relative(root, parent);
        if (parentRelative === ".." ||
            parentRelative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(parentRelative)) {
            throw new Error("Parent directory is outside the workspace.");
        }
        return path.join(parent, path.basename(target));
    }
}
function result(message) {
    return { content: [{ type: "text", text: message }] };
}
function failure(error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
        ...result(`Error: ${message}`),
        isError: true,
    };
}
// 1. LIST FILES
server.registerTool("list_files", {
    description: "List files and directories inside the workspace.",
    inputSchema: {
        directory: z.string().optional(),
    },
}, async ({ directory }) => {
    try {
        const target = await safePath(directory ?? ".");
        const entries = await readdir(target, { withFileTypes: true });
        return result(JSON.stringify(entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
        })), null, 2));
    }
    catch (error) {
        return failure(error);
    }
});
// 2. READ FILE
server.registerTool("read_file", {
    description: "Read a UTF-8 text file inside the workspace.",
    inputSchema: {
        filePath: z.string().min(1),
    },
}, async ({ filePath }) => {
    try {
        const target = await safePath(filePath);
        return result(await readFile(target, "utf8"));
    }
    catch (error) {
        return failure(error);
    }
});
// 3. WRITE FILE
server.registerTool("write_file", {
    description: "Create or overwrite a text file inside the workspace.",
    inputSchema: {
        filePath: z.string().min(1),
        content: z.string(),
    },
}, async ({ filePath, content }) => {
    try {
        const target = await safePath(filePath, true);
        await writeFile(target, content, "utf8");
        return result(`File saved: ${filePath}`);
    }
    catch (error) {
        return failure(error);
    }
});
// 4. REPLACE TEXT
server.registerTool("str_replace", {
    description: "Replace the first occurrence of text in a workspace file.",
    inputSchema: {
        filePath: z.string().min(1),
        oldText: z.string().min(1),
        newText: z.string(),
    },
}, async ({ filePath, oldText, newText }) => {
    try {
        const target = await safePath(filePath);
        const content = await readFile(target, "utf8");
        if (!content.includes(oldText)) {
            return failure(new Error("The requested text was not found."));
        }
        const updated = content.replace(oldText, newText);
        await writeFile(target, updated, "utf8");
        return result(`Text replaced in: ${filePath}`);
    }
    catch (error) {
        return failure(error);
    }
});
// 5. DELETE FILE
server.registerTool("delete_file", {
    description: "Delete a file inside the workspace.",
    inputSchema: {
        filePath: z.string().min(1),
    },
}, async ({ filePath }) => {
    try {
        const target = await safePath(filePath);
        await unlink(target);
        return result(`File deleted: ${filePath}`);
    }
    catch (error) {
        return failure(error);
    }
});
// 6. SEARCH FILES
server.registerTool("search_files", {
    description: "Search text files in the workspace for a phrase.",
    inputSchema: {
        query: z.string().min(1),
    },
}, async ({ query }) => {
    try {
        const matches = [];
        const ignored = new Set(["node_modules", ".git", "dist"]);
        async function searchDirectory(directory) {
            const entries = await readdir(directory, {
                withFileTypes: true,
            });
            for (const entry of entries) {
                if (entry.isSymbolicLink())
                    continue;
                const fullPath = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    if (!ignored.has(entry.name)) {
                        await searchDirectory(fullPath);
                    }
                }
                else if (entry.isFile()) {
                    try {
                        const content = await readFile(fullPath, "utf8");
                        if (content.includes(query)) {
                            matches.push(path.relative(workspace, fullPath));
                        }
                    }
                    catch {
                        // Skip files that cannot be read as text.
                    }
                }
            }
        }
        await searchDirectory(await realpath(workspace));
        return result(matches.length ? matches.join("\n") : "No matching files found.");
    }
    catch (error) {
        return failure(error);
    }
});
// Run fixed Git commands without invoking a shell.
async function runGit(args) {
    const { stdout } = await execFileAsync("git", ["-C", projectRoot, ...args], {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
    });
    return stdout || "(No output)";
}
// 7. GIT STATUS
server.registerTool("git_status", {
    description: "Show the Git working-tree status of the project.",
    inputSchema: {},
}, async () => {
    try {
        return result(await runGit(["status", "--short"]));
    }
    catch (error) {
        return failure(error);
    }
});
// 8. GIT DIFF
server.registerTool("git_diff", {
    description: "Show unstaged Git changes.",
    inputSchema: {},
}, async () => {
    try {
        return result(await runGit(["diff", "--"]));
    }
    catch (error) {
        return failure(error);
    }
});
// 9. GIT LOG
server.registerTool("git_log", {
    description: "Show the latest five Git commits.",
    inputSchema: {},
}, async () => {
    try {
        return result(await runGit(["log", "-5", "--oneline", "--decorate"]));
    }
    catch (error) {
        return failure(error);
    }
});
// 10. GET PROJECT STATE
server.registerTool("get_project_state", {
    description: "Read the shared PROJECT_STATE.md file.",
    inputSchema: {},
}, async () => {
    try {
        const target = await safePath("PROJECT_STATE.md");
        return result(await readFile(target, "utf8"));
    }
    catch (error) {
        return failure(error);
    }
});
// Start the MCP server
const transport = new StdioServerTransport();
await server.connect(transport);
