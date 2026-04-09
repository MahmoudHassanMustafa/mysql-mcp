import { readFileSync } from "node:fs";
import { Client as SSHClient } from "ssh2";
import mysql from "mysql2/promise";
import type { Pool, PoolConnection } from "mysql2/promise";
import type { DatabaseConfig, SSLConfig } from "./types.js";
import type { ConnectConfig } from "ssh2";
import net from "node:net";

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
  };

  // SSL/TLS support
  if (config.ssl) {
    if (config.ssl === true) {
      poolOpts.ssl = {};
    } else {
      const sslCfg = config.ssl as SSLConfig;
      poolOpts.ssl = {
        ca: sslCfg.ca ? readFileSync(sslCfg.ca) : undefined,
        cert: sslCfg.cert ? readFileSync(sslCfg.cert) : undefined,
        key: sslCfg.key ? readFileSync(sslCfg.key) : undefined,
        rejectUnauthorized: sslCfg.rejectUnauthorized ?? true,
      };
    }
  }

  const pool = mysql.createPool(poolOpts);

  // Verify the connection works
  const conn = await pool.getConnection();
  conn.release();

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

export async function closeAll(): Promise<void> {
  for (const [name, managed] of connections) {
    try {
      await managed.pool.end();
    } catch {
      // ignore pool close errors
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
  return new Promise((resolve, reject) => {
    const ssh = config.ssh!;
    const client = new SSHClient();

    const sshConfig: ConnectConfig = {
      host: ssh.host,
      port: ssh.port ?? 22,
      username: ssh.username,
      readyTimeout: 10000,
    };

    if (ssh.privateKeyPath) {
      sshConfig.privateKey = readFileSync(ssh.privateKeyPath);
      if (ssh.passphrase) {
        sshConfig.passphrase = ssh.passphrase;
      }
    } else if (ssh.password) {
      sshConfig.password = ssh.password;
    }

    client.on("error", reject);

    client.on("ready", () => {
      const localServer = net.createServer((sock) => {
        client.forwardOut(
          "127.0.0.1",
          0,
          config.host,
          config.port ?? 3306,
          (err, stream) => {
            if (err) {
              sock.destroy();
              return;
            }
            sock.pipe(stream).pipe(sock);
            sock.on("error", () => stream.destroy());
            stream.on("error", () => sock.destroy());
          }
        );
      });

      localServer.listen(0, "127.0.0.1", () => {
        const addr = localServer.address() as net.AddressInfo;
        resolve({
          host: "127.0.0.1",
          port: addr.port,
          sshClient: client,
          localServer,
        });
      });

      localServer.on("error", reject);
    });

    client.connect(sshConfig);
  });
}
