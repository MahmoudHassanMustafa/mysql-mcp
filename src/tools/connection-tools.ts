import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getPool,
  getConnectionConfig,
  listConnectionNames,
  setActiveDatabase,
} from "../connection.js";
import { toolOk, toolError, toolHandler } from "../helpers.js";

export function registerConnectionTools(server: McpServer) {
  server.tool(
    "list_connections",
    "List all configured database connections and their status",
    {},
    toolHandler("list_connections", async () => {
      const names = listConnectionNames();
      const lines = names.map((name) => {
        const cfg = getConnectionConfig(name);
        const db = cfg.database ? ` (db: ${cfg.database})` : "";
        const tunnel = cfg.ssh ? ` [SSH: ${cfg.ssh.host}]` : "";
        const ssl = cfg.ssl ? " [SSL]" : "";
        const mode = cfg.readonly !== false ? " [read-only]" : " [read-write]";
        return `- ${name}: ${cfg.host}:${cfg.port ?? 3306}${db}${tunnel}${ssl}${mode}`;
      });
      return toolOk(lines.join("\n") || "No connections configured");
    })
  );

  server.tool(
    "list_databases",
    "List all databases on a connection",
    { connection: z.string().describe("Connection name") },
    toolHandler("list_databases", async ({ connection }) => {
      const pool = getPool(connection);
      const [rows] = await pool.query("SHOW DATABASES");
      const databases = (rows as Array<Record<string, string>>).map(
        (r) => Object.values(r)[0]
      );
      return toolOk(`${databases.join("\n")}\n\n${databases.length} database(s)`);
    })
  );

  server.tool(
    "use_database",
    "Switch the active database/schema for a connection",
    {
      connection: z.string().describe("Connection name"),
      database: z.string().describe("Database name to switch to"),
    },
    toolHandler("use_database", async ({ connection, database }) => {
      const pool = getPool(connection);
      const [rows] = await pool.query("SHOW DATABASES LIKE ?", [database]);
      if ((rows as unknown[]).length === 0) {
        return toolError(`Database "${database}" not found`);
      }
      setActiveDatabase(connection, database);
      return toolOk(`Switched to database "${database}" on ${connection}`);
    })
  );
}
