# MCP File Server

A local MCP server built with Node.js and TypeScript that connects to Claude Desktop. It allows Claude to manage files in a workspace and inspect Git project information through dedicated tools.

## Author

**Name:** Jet Justnie D. Espanola  
**Section:** BSCS-3B

## Features

The server provides tools for file management, searching, and Git inspection.

### Available Tools

- `list_files`  
  Lists files in the workspace.

- `read_file`  
  Reads the contents of a file.

- `write_file`  
  Creates or writes a file.

- `str_replace`  
  Replaces specific text in a file.

- `delete_file`  
  Deletes a file.

- `search_files`  
  Searches workspace files for matching text.

- `git_status`  
  Shows the current Git working tree status.

- `git_diff`  
  Displays changes in the Git working tree.

- `git_log`  
  Shows recent Git commits.

- `get_project_state`  
  Retrieves the project's saved state information.

## Technologies Used

- Node.js
- TypeScript
- Model Context Protocol (MCP) SDK
- Zod
- tsx

## Project Structure

```text
mcp-file-server/
    src/
        index.ts
    dist/
        index.js
    workspace/
        hello.txt
        PROJECT_STATE.md
    package.json
    tsconfig.json
    README.md
```

## Installation

Make sure Node.js and npm are installed on your computer.

Open PowerShell and navigate to the project folder:

```powershell
cd "C:\Users\Jet Justine\Documents\mcp-file-server"
```

Install the dependencies:

```powershell
npm install
```

## Build and Run

Compile the TypeScript source code:

```powershell
npm run build
```

To run the server directly in development mode:

```powershell
npm run dev
```

To run the compiled version:

```powershell
npm start
```

Claude Desktop is configured to launch the compiled server using the standard input/output transport.

## Claude Desktop Setup

Add the following entry to your Claude Desktop configuration file under `mcpServers`:

```json
{
  "mcp-file-server": {
    "command": "C:\\Program Files\\nodejs\\node.exe",
    "args": [
      "C:\\Users\\Jet Justine\\Documents\\mcp-file-server\\dist\\index.js"
    ],
    "env": {
      "MCP_TRANSPORT": "stdio"
    }
  }
}
```

Restart Claude Desktop after saving the configuration. Make sure the paths match your local installation.

## Testing

Use Claude Desktop to test the available tools.

1. List the files in the workspace.
2. Read `hello.txt`.
3. Create a temporary test file.
4. Replace a specific line in the test file.
5. Search for a unique phrase.
6. Delete the temporary test file.
7. Check the Git status, diff, and commit history.
8. Retrieve the project state.

Always use temporary files when testing operations that modify or delete files.

## Troubleshooting

If the server cannot find the `workspace` directory, check how the project path is resolved in `src/index.ts`.

The workspace path should be based on the server's module location rather than the current working directory. After fixing the path, rebuild the project and restart Claude Desktop.

If the server does not appear in Claude Desktop, verify the configuration file, Node.js path, compiled JavaScript path, and server logs.

## License

This project is intended for educational and development purposes.
