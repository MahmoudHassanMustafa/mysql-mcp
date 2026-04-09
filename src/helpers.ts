import { homedir } from "node:os";
import { getConnectionConfig } from "./connection.js";

// ── Path utilities ──────────────────────────────────────────────────

export function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace("~", homedir());
  }
  return p;
}

// ── SQL identifier escaping ─────────────────────────────────────────

export function escapeId(name: string): string {
  if (name.includes("\0") || name.length > 64 || name.length === 0) {
    throw new Error(`Invalid identifier: "${name.substring(0, 20)}"`);
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

export function qualifiedTable(db: string, table: string): string {
  return `${escapeId(db)}.${escapeId(table)}`;
}

// ── Database resolution ─────────────────────────────────────────────

export function resolveDb(
  connection: string,
  database?: string
): { db: string } | { error: ReturnType<typeof toolError> } {
  const db = database || getConnectionConfig(connection).database;
  if (!db) {
    return {
      error: toolError(
        "No database selected.",
        "Specify a database parameter or use use_database first."
      ),
    };
  }
  return { db };
}


// ── Tool response helpers ───────────────────────────────────────────

export function toolOk(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function toolError(message: string, hint?: string) {
  const parts = [message];
  if (hint) parts.push(`Hint: ${hint}`);
  return {
    content: [{ type: "text" as const, text: parts.join("\n") }],
    isError: true as const,
  };
}

// ── Table formatting ────────────────────────────────────────────────

const MAX_COL_WIDTH = 60;

export function formatAsTable(
  rows: Record<string, unknown>[],
  opts?: { maxWidth?: number }
): string {
  if (rows.length === 0) return "(empty)";

  const maxW = opts?.maxWidth ?? MAX_COL_WIDTH;
  const keys = Object.keys(rows[0]);

  const truncate = (val: unknown): string => {
    const s = String(val ?? "NULL");
    if (s.length <= maxW) return s;
    return s.slice(0, maxW - 3) + "...";
  };

  const widths = keys.map((k) =>
    Math.min(
      maxW,
      Math.max(k.length, ...rows.map((r) => truncate(r[k]).length))
    )
  );

  const header = keys.map((k, i) => k.padEnd(widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = rows.map((row) =>
    keys
      .map((k, i) => truncate(row[k]).padEnd(widths[i]))
      .join(" | ")
  );

  return [header, separator, ...body].join("\n");
}

// ── Human-readable sizes ────────────────────────────────────────────

export function humanSize(bytes: number | null | undefined): string {
  if (bytes == null) return "N/A";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Read-only query safety ───────────────────────────────────────────

/**
 * Strip SQL comments so they can't be used to bypass read-only checks.
 * Handles block comments, line comments (-- and #).
 */
export function stripSQLComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")  // block comments
    .replace(/--[^\n]*/g, " ")           // -- line comments
    .replace(/#[^\n]*/g, " ")            // # line comments
    .trim();
}

/**
 * Keywords that indicate a write/mutating operation.
 * Used to reject dangerous queries even when they start with an allowed keyword.
 */
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|RENAME|GRANT|REVOKE|LOCK|UNLOCK|CALL|SET|LOAD|DO|HANDLER|IMPORT|INSTALL|UNINSTALL|RESET|PURGE|PREPARE|EXECUTE|DEALLOCATE)\b/i;

/**
 * Block SELECT INTO OUTFILE/DUMPFILE — these are SELECTs that write files
 * to the server filesystem.
 */
const INTO_FILE_PATTERN = /\bINTO\s+(OUTFILE|DUMPFILE)\b/i;

/**
 * Whitelist approach: only allow known safe read-only statements.
 * Returns true if the query is safe for read-only connections.
 *
 * Rules:
 * - SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, USE are allowed
 * - SELECT INTO OUTFILE/DUMPFILE is blocked (writes files)
 * - WITH queries are allowed ONLY if they contain no write keywords
 *   (blocks WITH...INSERT, WITH...UPDATE, WITH...DELETE, etc.)
 */
export function isReadOnlyQuery(sql: string): boolean {
  const normalized = stripSQLComments(sql);

  // Block SELECT INTO OUTFILE/DUMPFILE regardless of context
  if (INTO_FILE_PATTERN.test(normalized)) {
    return false;
  }

  // Simple read-only statements
  if (/^(SHOW|DESCRIBE|DESC|EXPLAIN|USE)\b/i.test(normalized)) {
    return true;
  }

  // SELECT: allowed as long as it doesn't write files (already checked above)
  if (/^SELECT\b/i.test(normalized)) {
    return true;
  }

  // WITH ... SELECT: must not contain any write keywords anywhere in the query.
  // This blocks: WITH cte AS (SELECT 1) INSERT INTO ...
  // False positive edge case: WITH cte AS (SELECT * FROM t WHERE col = 'DELETE')
  //   -> user can use parameterized queries to avoid: WHERE col = ? with param 'DELETE'
  if (/^WITH\b/i.test(normalized)) {
    return !WRITE_KEYWORDS.test(normalized);
  }

  // Everything else is blocked
  return false;
}

/**
 * Validate that a query is safe for EXPLAIN (SELECT only, no write side-effects).
 */
export function isExplainSafe(sql: string): boolean {
  const normalized = stripSQLComments(sql);

  if (INTO_FILE_PATTERN.test(normalized)) {
    return false;
  }

  // Only allow plain SELECT or WITH...SELECT (no write keywords)
  if (/^SELECT\b/i.test(normalized)) {
    return true;
  }

  if (/^WITH\b/i.test(normalized)) {
    return !WRITE_KEYWORDS.test(normalized);
  }

  return false;
}
