#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { initConnection, closeAll } from "./connection.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

async function main() {
  const config = loadConfig();

  const server = new McpServer({
    name: "mysql-mcp",
    version: "1.0.0",
  });

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  // Initialize all database connections (with SSH tunnels if configured)
  const errors: string[] = [];
  for (const conn of config.connections) {
    try {
      await initConnection(conn);
      console.error(`[mysql-mcp] Connected: ${conn.name}`);
    } catch (err) {
      const msg = `Failed to connect "${conn.name}": ${err instanceof Error ? err.message : err}`;
      console.error(`[mysql-mcp] ${msg}`);
      errors.push(msg);
    }
  }

  if (errors.length === config.connections.length && config.connections.length > 0) {
    console.error("[mysql-mcp] All connections failed. Server will start but no queries will work.");
  }

  // Graceful shutdown
  const shutdown = async () => {
    await closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mysql-mcp] Server running on stdio");
}

main().catch((err) => {
  console.error("[mysql-mcp] Fatal:", err);
  process.exit(1);
});
