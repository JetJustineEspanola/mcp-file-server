import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdir } from "node:fs/promises";
import path from "node:path";
const workspace = path.resolve(process.cwd(), "workspace");
const server = new McpServer({
    name: "mcp-file-server",
    version: "1.0.0",
});
server.registerTool("list_files", {
    description: "List files inside the shared workspace.",
    inputSchema: {
        directory: z
            .string()
            .optional()
            .describe("Relative directory inside the workspace. Defaults to the workspace root."),
    },
}, async ({ directory }) => {
    const target = path.resolve(workspace, directory ?? ".");
    const relative = path.relative(workspace, target);
    if (relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
        return {
            content: [
                { type: "text", text: "Error: Path is outside the workspace." },
            ],
            isError: true,
        };
    }
    try {
        const entries = await readdir(target, { withFileTypes: true });
        const files = entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
        }));
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(files, null, 2),
                },
            ],
        };
    }
    catch {
        return {
            content: [
                {
                    type: "text",
                    text: "Error: Directory not found or could not be read.",
                },
            ],
            isError: true,
        };
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
