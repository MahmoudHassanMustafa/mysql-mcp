import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPool, getConnectionConfig, getQueryTimeout } from "../connection.js";
import {
  escapeId,
  formatAsTable,
  toolOk,
  toolError,
  toolHandler,
  isReadOnlyQuery,
  isExplainSafe,
  stripSQLComments,
} from "../helpers.js";

const MAX_RESULT_ROWS = 1000;

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
    toolHandler("execute_query", async ({ connection, query, params }) => {
      const config = getConnectionConfig(connection);

      // Whitelist approach: on read-only connections, only allow safe statements
      if (config.readonly !== false && !isReadOnlyQuery(query)) {
        return toolError(
          `Connection "${connection}" is read-only. Only SELECT, SHOW, DESCRIBE, EXPLAIN, and USE are allowed.`,
          'Set "readonly": false in the connection config to enable writes.'
        );
      }

      const pool = getPool(connection);
      const db = config.database;
      const timeout = getQueryTimeout(connection);
      let conn;

      try {
        conn = await pool.getConnection();

        if (db) {
          await conn.query(`USE ${escapeId(db)}`);
        }

        // Auto-append LIMIT to unbounded SELECT to prevent OOM. Strip a
        // trailing ';' first — appending "LIMIT 1000" after a terminator
        // produces invalid SQL when multipleStatements is off.
        let boundedQuery = query;
        const normalized = stripSQLComments(query);
        if (/^\s*SELECT\b/i.test(normalized) && !/\bLIMIT\b/i.test(normalized)) {
          boundedQuery = `${query.replace(/;\s*$/, "")} LIMIT ${MAX_RESULT_ROWS}`;
        }

        const startTime = Date.now();
        const [rows, fields] = await conn.execute({
          sql: boundedQuery,
          timeout,
        }, params ?? []);
        const elapsed = Date.now() - startTime;

        if (Array.isArray(rows) && rows.length > 0 && fields) {
          // formatAsTable enforces a byte cap on output and reports any
          // rows it dropped — no need for a second manual slice here.
          const text = [
            formatAsTable(rows as Record<string, unknown>[]),
            "",
            `${(rows as unknown[]).length} row(s) returned in ${elapsed}ms`,
          ].join("\n");
          return toolOk(text);
        }

        const result = rows as unknown as Record<string, unknown>;
        const text = [
          `Query executed in ${elapsed}ms`,
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
      } finally {
        conn?.release();
      }
    })
  );

  // ── explain_query ─────────────────────────────────────────────────
  server.tool(
    "explain_query",
    "Run EXPLAIN on a SELECT query to show the execution plan",
    {
      connection: z.string().describe("Connection name"),
      query: z.string().describe("SELECT query to analyze"),
      format: z
        .enum(["TRADITIONAL", "JSON", "TREE"])
        .optional()
        .describe("Output format (default: JSON for richest detail)"),
    },
    toolHandler("explain_query", async ({ connection, query, format }) => {
      // Only allow EXPLAIN on safe SELECT queries (no INTO OUTFILE, no WITH...INSERT)
      if (!isExplainSafe(query)) {
        return toolError(
          "EXPLAIN is restricted to SELECT queries for safety.",
          "Provide a SELECT statement (no write operations, no INTO OUTFILE/DUMPFILE)."
        );
      }

      const pool = getPool(connection);
      const fmt = format ?? "JSON";
      const timeout = getQueryTimeout(connection);
      const db = getConnectionConfig(connection).database;
      let conn;

      try {
        conn = await pool.getConnection();

        if (db) await conn.query(`USE ${escapeId(db)}`);

        const explainSql =
          fmt === "TRADITIONAL"
            ? `EXPLAIN ${query}`
            : `EXPLAIN FORMAT=${fmt} ${query}`;

        const [rows] = await conn.execute({ sql: explainSql, timeout });
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
        conn?.release();
      }
    })
  );
}
