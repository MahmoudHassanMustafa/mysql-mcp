import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPool } from "../connection.js";
import {
  escapeId,
  resolveDb,
  formatAsTable,
  toolOk,
  toolHandler,
} from "../helpers.js";

export function registerRoutinesTools(server: McpServer) {
  // ── list_routines ─────────────────────────────────────────────────
  server.tool(
    "list_routines",
    "List stored procedures and/or functions in a database",
    {
      connection: z.string().describe("Connection name"),
      database: z.string().optional().describe("Database name"),
      type: z
        .enum(["PROCEDURE", "FUNCTION", "ALL"])
        .optional()
        .describe("Filter by routine type (default: ALL)"),
    },
    toolHandler("list_routines", async ({ connection, database, type }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const pool = getPool(connection);
      const routineType = type ?? "ALL";

      let sql = `
        SELECT
          ROUTINE_NAME,
          ROUTINE_TYPE,
          DTD_IDENTIFIER AS RETURN_TYPE,
          ROUTINE_COMMENT,
          DEFINER,
          CREATED,
          LAST_ALTERED,
          SECURITY_TYPE
        FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA = ?`;

      const params: string[] = [r.db];
      if (routineType !== "ALL") {
        sql += ` AND ROUTINE_TYPE = ?`;
        params.push(routineType);
      }
      sql += ` ORDER BY ROUTINE_TYPE, ROUTINE_NAME`;

      const [rows] = await pool.query(sql, params);
      const routines = rows as Array<Record<string, unknown>>;

      if (routines.length === 0) {
        return toolOk(`No ${routineType === "ALL" ? "routines" : routineType.toLowerCase() + "s"} found in ${r.db}`);
      }

      return toolOk(
        formatAsTable(routines) +
          `\n\n${routines.length} routine(s) in ${r.db}`
      );
    })
  );

  // ── get_routine_ddl ───────────────────────────────────────────────
  server.tool(
    "get_routine_ddl",
    "Get the full DDL of a stored procedure or function",
    {
      connection: z.string().describe("Connection name"),
      name: z.string().describe("Routine name"),
      database: z.string().optional().describe("Database name"),
      type: z
        .enum(["PROCEDURE", "FUNCTION"])
        .optional()
        .describe("Routine type (auto-detected if omitted)"),
    },
    toolHandler("get_routine_ddl", async ({ connection, name, database, type }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const pool = getPool(connection);

      // Auto-detect type if not provided
      let routineType = type;
      if (!routineType) {
        const [check] = await pool.query(
          `SELECT ROUTINE_TYPE FROM information_schema.ROUTINES
           WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?`,
          [r.db, name]
        );
        const found = (check as Array<Record<string, string>>)[0];
        if (!found) return toolOk(`Routine "${name}" not found in ${r.db}`);
        routineType = found.ROUTINE_TYPE as "PROCEDURE" | "FUNCTION";
      }

      const qualifiedName = `${escapeId(r.db)}.${escapeId(name)}`;
      const [rows] = await pool.query(
        `SHOW CREATE ${routineType} ${qualifiedName}`
      );
      const row = (rows as Array<Record<string, string>>)[0];
      const ddlKey =
        routineType === "PROCEDURE"
          ? "Create Procedure"
          : "Create Function";
      const ddl = row?.[ddlKey] ?? "";

      return toolOk(`-- ${routineType}: ${name}\n${ddl}`);
    })
  );

  // ── list_triggers ─────────────────────────────────────────────────
  server.tool(
    "list_triggers",
    "List triggers in a database, optionally filtered by table",
    {
      connection: z.string().describe("Connection name"),
      table: z.string().optional().describe("Table name (omit for all triggers)"),
      database: z.string().optional().describe("Database name"),
    },
    toolHandler("list_triggers", async ({ connection, table, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const pool = getPool(connection);

      let sql = `
        SELECT
          TRIGGER_NAME,
          EVENT_MANIPULATION AS EVENT,
          ACTION_TIMING AS TIMING,
          EVENT_OBJECT_TABLE AS TABLE_NAME,
          ACTION_ORIENTATION,
          DEFINER,
          CREATED
        FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = ?`;

      const params: string[] = [r.db];
      if (table) {
        sql += ` AND EVENT_OBJECT_TABLE = ?`;
        params.push(table);
      }
      sql += ` ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION`;

      const [rows] = await pool.query(sql, params);
      const triggers = rows as Array<Record<string, unknown>>;

      if (triggers.length === 0) {
        return toolOk(
          table
            ? `No triggers on table ${table}`
            : `No triggers in ${r.db}`
        );
      }

      return toolOk(
        formatAsTable(triggers) + `\n\n${triggers.length} trigger(s)`
      );
    })
  );

  // ── get_trigger_ddl ───────────────────────────────────────────────
  server.tool(
    "get_trigger_ddl",
    "Get the full DDL of a trigger",
    {
      connection: z.string().describe("Connection name"),
      name: z.string().describe("Trigger name"),
      database: z.string().optional().describe("Database name"),
    },
    toolHandler("get_trigger_ddl", async ({ connection, name, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const pool = getPool(connection);

      const qualifiedName = `${escapeId(r.db)}.${escapeId(name)}`;
      const [rows] = await pool.query(`SHOW CREATE TRIGGER ${qualifiedName}`);
      const row = (rows as Array<Record<string, string>>)[0];
      const ddl = row?.["SQL Original Statement"] ?? "";

      return toolOk(`-- TRIGGER: ${name}\n${ddl}`);
    })
  );

  // ── list_events ───────────────────────────────────────────────────
  server.tool(
    "list_events",
    "List scheduled events in a database",
    {
      connection: z.string().describe("Connection name"),
      database: z.string().optional().describe("Database name"),
    },
    toolHandler("list_events", async ({ connection, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const pool = getPool(connection);

      const [rows] = await pool.query(
        `SELECT
          EVENT_NAME,
          EVENT_TYPE,
          INTERVAL_VALUE,
          INTERVAL_FIELD,
          STATUS,
          STARTS,
          ENDS,
          LAST_EXECUTED,
          DEFINER
        FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = ?
        ORDER BY EVENT_NAME`,
        [r.db]
      );
      const events = rows as Array<Record<string, unknown>>;

      if (events.length === 0) return toolOk(`No events in ${r.db}`);

      return toolOk(
        formatAsTable(events) + `\n\n${events.length} event(s)`
      );
    })
  );

  // ── get_event_ddl ─────────────────────────────────────────────────
  server.tool(
    "get_event_ddl",
    "Get the full DDL of a scheduled event",
    {
      connection: z.string().describe("Connection name"),
      name: z.string().describe("Event name"),
      database: z.string().optional().describe("Database name"),
    },
    toolHandler("get_event_ddl", async ({ connection, name, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const pool = getPool(connection);

      const qualifiedName = `${escapeId(r.db)}.${escapeId(name)}`;
      const [rows] = await pool.query(`SHOW CREATE EVENT ${qualifiedName}`);
      const row = (rows as Array<Record<string, string>>)[0];
      const ddl = row?.["Create Event"] ?? "";

      return toolOk(`-- EVENT: ${name}\n${ddl}`);
    })
  );
}
