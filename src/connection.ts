import { readFileSync } from "node:fs";
import { Client as SSHClient } from "ssh2";
import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import type { DatabaseConfig, SSLConfig } from "./types.js";
import type { ConnectConfig } from "ssh2";
import net from "node:net";
import { log, buildHostVerifier } from "./helpers.js";

interface ManagedConnection {
  config: DatabaseConfig;
  pool: Pool;
  sshClient?: SSHClient;
  localServer?: net.Server;
}

const connections = new Map<string, ManagedConnection>();

export async function initConnection(config: DatabaseConfig): Promise<void> {
  if (connections.has(config.name)) return;

  let mysqlHost = config.host;
  let mysqlPort = config.port ?? 3306;
  let sshClient: SSHClient | undefined;
  let localServer: net.Server | undefined;

  if (config.ssh) {
    const result = await setupSSHTunnel(config);
    mysqlHost = result.host;
    mysqlPort = result.port;
    sshClient = result.sshClient;
    localServer = result.localServer;
  }

  const poolOpts: mysql.PoolOptions = {
    host: mysqlHost,
    port: mysqlPort,
    user: config.user,
    password: config.password,
    database: config.database || undefined,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 10,
    connectTimeout: 10000,
    multipleStatements: false,
  };

  // SSL/TLS support
  if (config.ssl) {
    if (config.ssl === true) {
      poolOpts.ssl = {};
    } else {
      const sslCfg = config.ssl as SSLConfig;
      if (sslCfg.rejectUnauthorized === false) {
        log(
          "warn",
          "SSL certificate validation is DISABLED; vulnerable to MITM",
          { connection: config.name }
        );
      }
      poolOpts.ssl = {
        ca: sslCfg.ca ? readFileSync(sslCfg.ca) : undefined,
        cert: sslCfg.cert ? readFileSync(sslCfg.cert) : undefined,
        key: sslCfg.key ? readFileSync(sslCfg.key) : undefined,
        rejectUnauthorized: sslCfg.rejectUnauthorized ?? true,
      };
    }
  }

  let pool: mysql.Pool;
  try {
    pool = mysql.createPool(poolOpts);
    const conn = await pool.getConnection();
    conn.release();
  } catch (err) {
    // Clean up SSH tunnel if pool creation/verification fails
    localServer?.close();
    sshClient?.end();
    throw err;
  }

  connections.set(config.name, { config, pool, sshClient, localServer });
}

export function getPool(name: string): Pool {
  const managed = connections.get(name);
  if (!managed) {
    throw new Error(`Connection "${name}" not found or not initialized`);
  }
  return managed.pool;
}

export function getConnectionConfig(name: string): DatabaseConfig {
  const managed = connections.get(name);
  if (!managed) {
    throw new Error(`Connection "${name}" not found`);
  }
  return managed.config;
}

export function setActiveDatabase(name: string, database: string): void {
  const managed = connections.get(name);
  if (!managed) {
    throw new Error(`Connection "${name}" not found`);
  }
  managed.config.database = database;
}

export function listConnectionNames(): string[] {
  return [...connections.keys()];
}

export function getQueryTimeout(name: string): number {
  return getConnectionConfig(name).queryTimeout ?? 30000;
}

/**
 * Run a query through the pool with the connection's configured timeout
 * applied as the mysql2 client-side timeout. Returns just the rows.
 *
 * Use this for information_schema reads and other schema-introspection
 * queries that can be slow on large servers — without a timeout, a slow
 * query would hang the MCP tool call past Claude Code's request deadline.
 * On timeout expiry mysql2 destroys the underlying connection; the pool
 * replaces it on the next call.
 */
export async function queryWithTimeout<T = unknown>(
  connection: string,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const pool = getPool(connection);
  const timeout = getQueryTimeout(connection);
  const [rows] = await pool.query({ sql, timeout }, params);
  return rows as T;
}

export async function closeAll(): Promise<void> {
  for (const [name, managed] of connections) {
    try {
      await managed.pool.end();
    } catch (err) {
      log("warn", "pool close failed during shutdown", {
        connection: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (managed.localServer) {
      managed.localServer.close();
    }
    if (managed.sshClient) {
      managed.sshClient.end();
    }
    connections.delete(name);
  }
}

interface TunnelResult {
  host: string;
  port: number;
  sshClient: SSHClient;
  localServer: net.Server;
}

function setupSSHTunnel(config: DatabaseConfig): Promise<TunnelResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const ssh = config.ssh!;
    const client = new SSHClient();
    const hostVerifier = buildHostVerifier(ssh.hostFingerprint);
    let settled = false;

    if (hostVerifier) {
      log("info", "SSH host fingerprint verification enabled", {
        connection: config.name,
        sshHost: ssh.host,
      });
    } else {
      log(
        "warn",
        "SSH host key verification not enforced; set ssh.hostFingerprint to prevent MITM",
        { connection: config.name, sshHost: ssh.host }
      );
    }

    const sshConfig: ConnectConfig = {
      host: ssh.host,
      port: ssh.port ?? 22,
      username: ssh.username,
      readyTimeout: 10000,
      // Defaults picked to survive 60-120s bastion idle timeouts during
      // schema scans. Users can opt out with keepaliveInterval: 0.
      keepaliveInterval: ssh.keepaliveInterval ?? 30000,
      keepaliveCountMax: ssh.keepaliveCountMax ?? 3,
      ...(hostVerifier ? { hostVerifier } : {}),
    };

    if (ssh.privateKeyPath) {
      sshConfig.privateKey = readFileSync(ssh.privateKeyPath);
      if (ssh.passphrase) {
        sshConfig.passphrase = ssh.passphrase;
      }
    } else if (ssh.password) {
      sshConfig.password = ssh.password;
    }

    // Persistent listeners — the ssh2 Client can emit 'error' at any time
    // (keepalive failure, remote disconnect). Without a live listener Node
    // would crash the process on an unhandled 'error' event after the
    // initial connect resolved.
    client.on("error", (err) => {
      log("warn", "SSH client error", {
        connection: config.name,
        error: err.message,
      });
      if (!settled) {
        settled = true;
        rejectPromise(err);
      }
    });
    client.on("end", () => {
      log("info", "SSH client disconnected (end)", {
        connection: config.name,
      });
    });
    client.on("close", () => {
      log("info", "SSH client closed", { connection: config.name });
    });

    client.on("ready", () => {
      const localServer = net.createServer((sock) => {
        client.forwardOut(
          "127.0.0.1",
          0,
          config.host,
          config.port ?? 3306,
          (err, stream) => {
            if (err) {
              log("warn", "SSH forwardOut failed", {
                connection: config.name,
                error: err.message,
              });
              sock.destroy();
              return;
            }
            sock.pipe(stream).pipe(sock);
            sock.on("error", (e: Error) => {
              log("warn", "SSH tunnel local socket error", {
                connection: config.name,
                error: e.message,
              });
              stream.destroy();
            });
            stream.on("error", (e: Error) => {
              log("warn", "SSH tunnel remote stream error", {
                connection: config.name,
                error: e.message,
              });
              sock.destroy();
            });
          }
        );
      });

      // Keep a persistent 'error' listener so late EMFILE/accept failures
      // don't crash the process.
      localServer.on("error", (err) => {
        log("warn", "SSH tunnel localServer error", {
          connection: config.name,
          error: err.message,
        });
        if (!settled) {
          settled = true;
          rejectPromise(err);
        }
      });

      localServer.listen(0, "127.0.0.1", () => {
        const addr = localServer.address() as net.AddressInfo;
        settled = true;
        resolvePromise({
          host: "127.0.0.1",
          port: addr.port,
          sshClient: client,
          localServer,
        });
      });
    });

    client.connect(sshConfig);
  });
}
