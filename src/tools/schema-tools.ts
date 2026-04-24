import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryWithTimeout } from "../connection.js";
import {
  qualifiedTable,
  resolveDb,
  formatAsTable,
  toolOk,
  toolError,
  toolHandler,
} from "../helpers.js";

export function registerSchemaTools(server: McpServer) {
  // ── list_tables ───────────────────────────────────────────────────
  server.tool(
    "list_tables",
    "List all tables in the current (or specified) database with row counts",
    {
      connection: z.string().describe("Connection name"),
      database: z.string().optional().describe("Database name (uses connection default if omitted)"),
    },
    toolHandler("list_tables", async ({ connection, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      const tables = await queryWithTimeout<Array<Record<string, unknown>>>(
        connection,
        `SELECT TABLE_NAME, TABLE_ROWS, ENGINE, TABLE_COMMENT
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`,
        [r.db]
      );
      if (tables.length === 0) return toolOk("No tables found");

      return toolOk(
        formatAsTable(tables) + `\n\n${tables.length} table(s) in ${r.db}`
      );
    })
  );

  // ── describe_table ────────────────────────────────────────────────
  server.tool(
    "describe_table",
    "Show the schema of a table: columns, types, keys, indexes",
    {
      connection: z.string().describe("Connection name"),
      table: z.string().describe("Table name"),
      database: z.string().optional().describe("Database name"),
    },
    toolHandler("describe_table", async ({ connection, table, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const qt = qualifiedTable(r.db, table);

      const columns = await queryWithTimeout(connection, `DESCRIBE ${qt}`);
      const createResult = await queryWithTimeout<Array<Record<string, string>>>(
        connection,
        `SHOW CREATE TABLE ${qt}`
      );
      // SHOW CREATE TABLE also succeeds on views, but returns a "Create
      // View" key instead of "Create Table". Detect that and redirect the
      // caller at the dedicated view tools.
      const createRow = createResult[0];
      if (createRow && !createRow["Create Table"] && createRow["Create View"]) {
        return toolError(
          `"${table}" is a view, not a table.`,
          "Use describe_view or get_view_ddl instead."
        );
      }
      const createStatement = createRow?.["Create Table"] ?? "";
      const indexes = await queryWithTimeout(connection, `SHOW INDEX FROM ${qt}`);

      const output = [
        "## Columns",
        formatAsTable(columns as Record<string, unknown>[]),
        "",
        "## Indexes",
        formatAsTable(indexes as Record<string, unknown>[]),
        "",
        "## Create Statement",
        "```sql",
        createStatement,
        "```",
      ].join("\n");

      return toolOk(output);
    })
  );

  // ── get_ddl ───────────────────────────────────────────────────────
  server.tool(
    "get_ddl",
    "Get the CREATE TABLE DDL statement for a table",
    {
      connection: z.string().describe("Connection name"),
      table: z.string().describe("Table name"),
      database: z.string().optional().describe("Database name"),
    },
    toolHandler("get_ddl", async ({ connection, table, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const qt = qualifiedTable(r.db, table);

      const rows = await queryWithTimeout<Array<Record<string, string>>>(
        connection,
        `SHOW CREATE TABLE ${qt}`
      );
      const ddl = rows[0]?.["Create Table"] ?? "";
      return toolOk(ddl);
    })
  );

  // ── get_foreign_keys ──────────────────────────────────────────────
  server.tool(
    "get_foreign_keys",
    "Show foreign key relationships for a table or entire database",
    {
      connection: z.string().describe("Connection name"),
      table: z.string().optional().describe("Table name (omit for all FKs in database)"),
      database: z.string().optional().describe("Database name"),
    },
    toolHandler("get_foreign_keys", async ({ connection, table, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      let sql = `
        SELECT
          kcu.TABLE_NAME,
          kcu.COLUMN_NAME,
          kcu.REFERENCED_TABLE_SCHEMA,
          kcu.REFERENCED_TABLE_NAME,
          kcu.REFERENCED_COLUMN_NAME,
          rc.UPDATE_RULE,
          rc.DELETE_RULE
        FROM information_schema.KEY_COLUMN_USAGE kcu
        JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
          ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
          AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
        WHERE kcu.TABLE_SCHEMA = ?
          AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`;

      const params: string[] = [r.db];
      if (table) {
        sql += ` AND kcu.TABLE_NAME = ?`;
        params.push(table);
      }
      sql += ` ORDER BY kcu.TABLE_NAME, kcu.ORDINAL_POSITION`;

      const fks = await queryWithTimeout<Array<Record<string, string>>>(
        connection,
        sql,
        params
      );

      if (fks.length === 0) {
        return toolOk(table ? `No foreign keys on ${table}` : `No foreign keys in ${r.db}`);
      }

      const lines = fks.map(
        (fk) =>
          `${fk.TABLE_NAME}.${fk.COLUMN_NAME} -> ${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME} (ON UPDATE ${fk.UPDATE_RULE}, ON DELETE ${fk.DELETE_RULE})`
      );

      return toolOk(lines.join("\n") + `\n\n${fks.length} foreign key(s)`);
    })
  );

  // ── get_indexes ───────────────────────────────────────────────────
  server.tool(
    "get_indexes",
    "Show indexes for a table or entire database, with duplicate detection",
    {
      connection: z.string().describe("Connection name"),
      table: z.string().optional().describe("Table name (omit for all indexes in database)"),
      database: z.string().optional().describe("Database name"),
    },
    toolHandler("get_indexes", async ({ connection, table, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      let sql = `
        SELECT
          TABLE_NAME,
          INDEX_NAME,
          NON_UNIQUE,
          SEQ_IN_INDEX,
          COLUMN_NAME,
          CARDINALITY,
          INDEX_TYPE
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?`;

      const params: string[] = [r.db];
      if (table) {
        sql += ` AND TABLE_NAME = ?`;
        params.push(table);
      }
      sql += ` ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;

      const stats = await queryWithTimeout<Array<Record<string, unknown>>>(
        connection,
        sql,
        params
      );
      if (stats.length === 0) return toolOk("No indexes found");

      // Group by table + index name
      const grouped = new Map<string, { cols: string[]; unique: boolean; type: string; cardinality: unknown }>();
      for (const row of stats) {
        const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            cols: [],
            unique: row.NON_UNIQUE === 0,
            type: row.INDEX_TYPE as string,
            cardinality: row.CARDINALITY,
          });
        }
        grouped.get(key)!.cols.push(row.COLUMN_NAME as string);
      }

      const lines: string[] = [];
      for (const [key, info] of grouped) {
        const uniqueTag = info.unique ? "UNIQUE " : "";
        lines.push(
          `${key}: ${uniqueTag}${info.type} (${info.cols.join(", ")}) cardinality: ${info.cardinality ?? "N/A"}`
        );
      }

      // Detect duplicates: indexes with same leading column(s) on same table
      const byTable = new Map<string, Array<{ name: string; cols: string[] }>>();
      for (const [key, info] of grouped) {
        const [tbl, idx] = key.split(".");
        if (!byTable.has(tbl)) byTable.set(tbl, []);
        byTable.get(tbl)!.push({ name: idx, cols: info.cols });
      }

      const dupes: string[] = [];
      for (const [tbl, idxs] of byTable) {
        for (let i = 0; i < idxs.length; i++) {
          for (let j = i + 1; j < idxs.length; j++) {
            const a = idxs[i], b = idxs[j];
            const prefix = Math.min(a.cols.length, b.cols.length);
            const shared = a.cols.slice(0, prefix).join(",") === b.cols.slice(0, prefix).join(",");
            if (shared) {
              dupes.push(`  ${tbl}: ${a.name}(${a.cols.join(",")}) overlaps with ${b.name}(${b.cols.join(",")})`);
            }
          }
        }
      }

      let output = lines.join("\n") + `\n\n${grouped.size} index(es)`;
      if (dupes.length > 0) {
        output += `\n\n## Potential Duplicates\n${dupes.join("\n")}`;
      }

      return toolOk(output);
    })
  );

  // ── search_columns ────────────────────────────────────────────────
  server.tool(
    "search_columns",
    "Find columns by name pattern across all tables (supports SQL LIKE wildcards: %email%)",
    {
      connection: z.string().describe("Connection name"),
      pattern: z.string().describe("Column name pattern (SQL LIKE syntax, e.g. %email%)"),
      database: z.string().optional().describe("Database name"),
    },
    toolHandler("search_columns", async ({ connection, pattern, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      const cols = await queryWithTimeout<Array<Record<string, unknown>>>(
        connection,
        `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND COLUMN_NAME LIKE ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [r.db, pattern]
      );
      if (cols.length === 0) return toolOk(`No columns matching "${pattern}"`);

      return toolOk(
        formatAsTable(cols) + `\n\n${cols.length} column(s) matching "${pattern}"`
      );
    })
  );

  // ── list_views ────────────────────────────────────────────────────
  server.tool(
    "list_views",
    "List all views in the current (or specified) database",
    {
      connection: z.string().describe("Connection name"),
      database: z
        .string()
        .optional()
        .describe("Database name (uses connection default if omitted)"),
    },
    toolHandler("list_views", async ({ connection, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      const views = await queryWithTimeout<Array<Record<string, unknown>>>(
        connection,
        `SELECT TABLE_NAME, IS_UPDATABLE, DEFINER, SECURITY_TYPE, CHECK_OPTION
         FROM information_schema.VIEWS
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME`,
        [r.db]
      );
      if (views.length === 0) return toolOk(`No views found in ${r.db}`);

      return toolOk(
        formatAsTable(views) + `\n\n${views.length} view(s) in ${r.db}`
      );
    })
  );

  // ── describe_view ─────────────────────────────────────────────────
  server.tool(
    "describe_view",
    "Show the columns and CREATE VIEW DDL of a view",
    {
      connection: z.string().describe("Connection name"),
      view: z.string().describe("View name"),
      database: z.string().optional().describe("Database name"),
    },
    toolHandler("describe_view", async ({ connection, view, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const qv = qualifiedTable(r.db, view);

      const columns = await queryWithTimeout(connection, `DESCRIBE ${qv}`);
      const createResult = await queryWithTimeout<Array<Record<string, string>>>(
        connection,
        `SHOW CREATE VIEW ${qv}`
      );
      const createStatement = createResult[0]?.["Create View"] ?? "";

      const output = [
        "## Columns",
        formatAsTable(columns as Record<string, unknown>[]),
        "",
        "## Create Statement",
        "```sql",
        createStatement,
        "```",
      ].join("\n");

      return toolOk(output);
    })
  );

  // ── get_view_ddl ──────────────────────────────────────────────────
  server.tool(
    "get_view_ddl",
    "Get the CREATE VIEW DDL statement for a view",
    {
      connection: z.string().describe("Connection name"),
      view: z.string().describe("View name"),
      database: z.string().optional().describe("Database name"),
    },
    toolHandler("get_view_ddl", async ({ connection, view, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const qv = qualifiedTable(r.db, view);

      const rows = await queryWithTimeout<Array<Record<string, string>>>(
        connection,
        `SHOW CREATE VIEW ${qv}`
      );
      const ddl = rows[0]?.["Create View"] ?? "";
      return toolOk(ddl);
    })
  );
}
