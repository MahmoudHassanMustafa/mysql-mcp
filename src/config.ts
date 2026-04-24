import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expandTilde, log } from "./helpers.js";
import type { AppConfig, DatabaseConfig, SSLConfig } from "./types.js";

/**
 * Load configuration from either:
 *  1. QUERYBRIDGE_MCP_CONFIG env var pointing to a JSON file
 *  2. QUERYBRIDGE_MCP_CONFIG_JSON env var containing inline JSON
 *  3. Individual env vars for a single connection (MYSQL_HOST, etc.)
 *
 * The legacy MYSQL_MCP_CONFIG / MYSQL_MCP_CONFIG_JSON names are still
 * accepted as a fallback and will log a deprecation warning.
 */
export function loadConfig(): AppConfig {
  // Option 1: Config file path
  const configPath = readEnvWithFallback(
    "QUERYBRIDGE_MCP_CONFIG",
    "MYSQL_MCP_CONFIG",
  );
  if (configPath) {
    const raw = readFileSync(resolve(expandTilde(configPath)), "utf-8");
    return parseConfig(JSON.parse(raw));
  }

  // Option 2: Inline JSON
  const configJson = readEnvWithFallback(
    "QUERYBRIDGE_MCP_CONFIG_JSON",
    "MYSQL_MCP_CONFIG_JSON",
  );
  if (configJson) {
    return parseConfig(JSON.parse(configJson));
  }

  // Option 3: Single connection from env vars
  const host = process.env.MYSQL_HOST;
  if (!host) {
    throw new Error(
      "No configuration found. Set QUERYBRIDGE_MCP_CONFIG (file path), " +
        "QUERYBRIDGE_MCP_CONFIG_JSON (inline JSON), or MYSQL_HOST + related env vars.",
    );
  }

  const conn: DatabaseConfig = {
    name: process.env.MYSQL_CONNECTION_NAME || "default",
    host,
    port: process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT, 10) : 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    readonly:
      process.env.MYSQL_READONLY !== undefined
        ? process.env.MYSQL_READONLY !== "false"
        : true,
    queryTimeout: process.env.MYSQL_QUERY_TIMEOUT
      ? parseInt(process.env.MYSQL_QUERY_TIMEOUT, 10)
      : undefined,
  };

  // SSH from env vars
  if (process.env.SSH_HOST) {
    conn.ssh = {
      host: process.env.SSH_HOST,
      port: process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22,
      username: process.env.SSH_USER || process.env.SSH_USERNAME || "root",
      password: process.env.SSH_PASSWORD,
      privateKeyPath: process.env.SSH_PRIVATE_KEY_PATH
        ? expandTilde(process.env.SSH_PRIVATE_KEY_PATH)
        : undefined,
      passphrase: process.env.SSH_PASSPHRASE,
      hostFingerprint: process.env.SSH_HOST_FINGERPRINT,
    };
  }

  return { connections: [conn] };
}

function readEnvWithFallback(
  current: string,
  legacy: string,
): string | undefined {
  const fromCurrent = process.env[current];
  if (fromCurrent) return fromCurrent;
  const fromLegacy = process.env[legacy];
  if (fromLegacy) {
    log(
      "warn",
      `${legacy} is deprecated, rename it to ${current}. Support will be removed in a future release.`,
    );
    return fromLegacy;
  }
  return undefined;
}

function parseConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid config: expected an object");
  }

  const obj = raw as Record<string, unknown>;

  // Accept either { connections: [...] } or a bare array
  const arr = Array.isArray(obj.connections)
    ? obj.connections
    : Array.isArray(raw)
      ? (raw as unknown[])
      : null;

  if (!arr) {
    throw new Error(
      'Invalid config: expected { "connections": [...] } or an array',
    );
  }

  const connections: DatabaseConfig[] = arr.map((entry: unknown, i: number) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid connection at index ${i}`);
    }
    const e = entry as Record<string, unknown>;
    if (!e.host || !e.user) {
      throw new Error(
        `Connection at index ${i} requires at least "host" and "user"`,
      );
    }
    return {
      name: (e.name as string) || `connection-${i}`,
      host: e.host as string,
      port: (e.port as number) ?? 3306,
      user: e.user as string,
      password: e.password as string | undefined,
      database: e.database as string | undefined,
      readonly: e.readonly !== false,
      queryTimeout: (e.queryTimeout as number) ?? undefined,
      ssh: e.ssh ? parseSSH(e.ssh, i) : undefined,
      ssl: e.ssl ? parseSSL(e.ssl, i) : undefined,
    };
  });

  return { connections };
}

function parseSSH(raw: unknown, connIndex: number) {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid SSH config for connection ${connIndex}`);
  }
  const s = raw as Record<string, unknown>;
  if (!s.host || !s.username) {
    throw new Error(
      `SSH config for connection ${connIndex} requires "host" and "username"`,
    );
  }
  return {
    host: s.host as string,
    port: (s.port as number) ?? 22,
    username: s.username as string,
    password: s.password as string | undefined,
    privateKeyPath: s.privateKeyPath
      ? expandTilde(s.privateKeyPath as string)
      : undefined,
    passphrase: s.passphrase as string | undefined,
    hostFingerprint: s.hostFingerprint as string | undefined,
    keepaliveInterval: s.keepaliveInterval as number | undefined,
    keepaliveCountMax: s.keepaliveCountMax as number | undefined,
  };
}

function parseSSL(raw: unknown, connIndex: number): SSLConfig | boolean {
  if (raw === true) return true;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid SSL config for connection ${connIndex}`);
  }
  const s = raw as Record<string, unknown>;
  return {
    ca: s.ca ? expandTilde(s.ca as string) : undefined,
    cert: s.cert ? expandTilde(s.cert as string) : undefined,
    key: s.key ? expandTilde(s.key as string) : undefined,
    rejectUnauthorized: (s.rejectUnauthorized as boolean) ?? true,
  };
}
