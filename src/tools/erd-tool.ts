import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPool } from "../connection.js";
import { resolveDb, toolOk, toolHandler } from "../helpers.js";

export function registerErdTool(server: McpServer) {
  server.tool(
    "generate_erd",
    "Generate a Mermaid ER diagram from the database schema",
    {
      connection: z.string().describe("Connection name"),
      database: z.string().optional().describe("Database name"),
      tables: z
        .array(z.string())
        .optional()
        .describe("Specific tables to include (omit for all tables)"),
    },
    toolHandler("generate_erd", async ({ connection, database, tables }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const pool = getPool(connection);

      // Get columns
      let colSql = `
        SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?`;
      const colParams: string[] = [r.db];

      if (tables && tables.length > 0) {
        colSql += ` AND TABLE_NAME IN (${tables.map(() => "?").join(",")})`;
        colParams.push(...tables);
      }
      colSql += ` ORDER BY TABLE_NAME, ORDINAL_POSITION`;

      const [colRows] = await pool.query(colSql, colParams);
      const columns = colRows as Array<{
        TABLE_NAME: string;
        COLUMN_NAME: string;
        COLUMN_TYPE: string;
        COLUMN_KEY: string;
      }>;

      if (columns.length === 0) return toolOk("No tables found");

      // Get foreign keys
      let fkSql = `
        SELECT
          TABLE_NAME,
          COLUMN_NAME,
          REFERENCED_TABLE_NAME,
          REFERENCED_COLUMN_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL`;
      const fkParams: string[] = [r.db];

      if (tables && tables.length > 0) {
        fkSql += ` AND TABLE_NAME IN (${tables.map(() => "?").join(",")})`;
        fkParams.push(...tables);
      }

      const [fkRows] = await pool.query(fkSql, fkParams);
      const foreignKeys = fkRows as Array<{
        TABLE_NAME: string;
        COLUMN_NAME: string;
        REFERENCED_TABLE_NAME: string;
        REFERENCED_COLUMN_NAME: string;
      }>;

      // Build set of FK columns for marking
      const fkColSet = new Set(
        foreignKeys.map((fk) => `${fk.TABLE_NAME}.${fk.COLUMN_NAME}`)
      );

      // Group columns by table
      const tableMap = new Map<
        string,
        Array<{ name: string; type: string; key: string }>
      >();
      for (const col of columns) {
        if (!tableMap.has(col.TABLE_NAME)) {
          tableMap.set(col.TABLE_NAME, []);
        }
        tableMap.get(col.TABLE_NAME)!.push({
          name: col.COLUMN_NAME,
          type: simplifyType(col.COLUMN_TYPE),
          key: col.COLUMN_KEY,
        });
      }

      // Generate Mermaid
      const lines: string[] = ["erDiagram"];

      for (const [tableName, cols] of tableMap) {
        lines.push(`    ${sanitizeName(tableName)} {`);
        for (const col of cols) {
          const marker =
            col.key === "PRI"
              ? " PK"
              : fkColSet.has(`${tableName}.${col.name}`)
                ? " FK"
                : "";
          lines.push(
            `        ${col.type} ${sanitizeName(col.name)}${marker}`
          );
        }
        lines.push(`    }`);
      }

      // Add relationships
      for (const fk of foreignKeys) {
        // Only draw relationship if both tables are in our diagram
        if (
          tableMap.has(fk.TABLE_NAME) &&
          tableMap.has(fk.REFERENCED_TABLE_NAME)
        ) {
          lines.push(
            `    ${sanitizeName(fk.REFERENCED_TABLE_NAME)} ||--o{ ${sanitizeName(fk.TABLE_NAME)} : "${fk.COLUMN_NAME}"`
          );
        }
      }

      const mermaid = lines.join("\n");
      return toolOk("```mermaid\n" + mermaid + "\n```");
    })
  );
}

function simplifyType(mysqlType: string): string {
  const base = mysqlType.split("(")[0].toLowerCase();
  const map: Record<string, string> = {
    int: "int",
    bigint: "bigint",
    smallint: "smallint",
    tinyint: "tinyint",
    mediumint: "mediumint",
    decimal: "decimal",
    float: "float",
    double: "double",
    varchar: "varchar",
    char: "char",
    text: "text",
    mediumtext: "text",
    longtext: "text",
    tinytext: "text",
    blob: "blob",
    mediumblob: "blob",
    longblob: "blob",
    datetime: "datetime",
    timestamp: "timestamp",
    date: "date",
    time: "time",
    year: "year",
    json: "json",
    enum: "enum",
    set: "set",
    boolean: "boolean",
    bit: "bit",
  };
  return map[base] ?? base;
}

function sanitizeName(name: string): string {
  // Mermaid doesn't like special chars in names
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
