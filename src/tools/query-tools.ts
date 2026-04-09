import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPool, getConnectionConfig } from "../connection.js";
import {
  escapeId,
  formatAsTable,
  toolOk,
  toolError,
  WRITE_PATTERN,
  queryWithDb,
} from "../helpers.js";

export function registerQueryTools(server: McpServer) {
  // ── execute_query ─────────────────────────────────────────────────
  server.tool(
    "execute_query",
    "Execute a SQL query. Write operations require the connection to be configured with readonly: false.",
    {
      connection: z.string().describe("Connection name"),
      query: z.string().describe("SQL query to execute"),
      params: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Parameterized query values (use ? placeholders in query)"),
    },
    async ({ connection, query, params }) => {
      const config = getConnectionConfig(connection);

      if (config.readonly !== false && WRITE_PATTERN.test(query)) {
        return toolError(
          `Connection "${connection}" is read-only. Write operations are not allowed.`,
          'Set "readonly": false in the connection config to enable writes.'
        );
      }

      const pool = getPool(connection);
      const [rows, fields] = await queryWithDb(
        pool,
        connection,
        query,
        params ?? []
      );
      const startTime = Date.now();
      const elapsed = Date.now() - startTime;

      if (Array.isArray(rows) && rows.length > 0 && fields) {
        const limited = (rows as Record<string, unknown>[]).slice(0, 500);
        const text = [
          formatAsTable(limited),
          "",
          `${(rows as unknown[]).length} row(s) returned${(rows as unknown[]).length > 500 ? " (showing first 500)" : ""}`,
        ].join("\n");
        return toolOk(text);
      }

      const result = rows as any;
      const text = [
        "Query executed successfully",
        result.affectedRows !== undefined
          ? `Affected rows: ${result.affectedRows}`
          : null,
        result.insertId ? `Insert ID: ${result.insertId}` : null,
        result.changedRows !== undefined
          ? `Changed rows: ${result.changedRows}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      return toolOk(text);
    }
  );

  // ── explain_query ─────────────────────────────────────────────────
  server.tool(
    "explain_query",
    "Run EXPLAIN on a query to show the execution plan",
    {
      connection: z.string().describe("Connection name"),
      query: z.string().describe("SQL query to analyze"),
      format: z
        .enum(["TRADITIONAL", "JSON", "TREE"])
        .optional()
        .describe("Output format (default: JSON for richest detail)"),
    },
    async ({ connection, query, format }) => {
      const pool = getPool(connection);
      const fmt = format ?? "JSON";
      const explainSql =
        fmt === "TRADITIONAL"
          ? `EXPLAIN ${query}`
          : `EXPLAIN FORMAT=${fmt} ${query}`;

      const db = getConnectionConfig(connection).database;
      const conn = await pool.getConnection();
      try {
        if (db) await conn.query(`USE ${escapeId(db)}`);
        const [rows] = await conn.execute(explainSql);
        const resultRows = rows as Array<Record<string, unknown>>;

        if (fmt === "JSON" && resultRows[0]?.EXPLAIN) {
          return toolOk(
            "```json\n" +
              JSON.stringify(JSON.parse(resultRows[0].EXPLAIN as string), null, 2) +
              "\n```"
          );
        }

        if (fmt === "TREE" && resultRows[0]?.EXPLAIN) {
          return toolOk("```\n" + resultRows[0].EXPLAIN + "\n```");
        }

        return toolOk(formatAsTable(resultRows));
      } finally {
        conn.release();
      }
    }
  );
}
