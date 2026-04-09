#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import { Client as SSHClient } from "ssh2";
import mysql from "mysql2/promise";
import net from "node:net";
import { expandTilde } from "./helpers.js";
import type { AppConfig, DatabaseConfig, SSHConfig } from "./types.js";

// ── Config file resolution ──────────────────────────────────────────

function getConfigPath(): string {
  if (process.env.MYSQL_MCP_CONFIG) {
    return resolve(expandTilde(process.env.MYSQL_MCP_CONFIG));
  }
  return resolve(dirname(new URL(import.meta.url).pathname), "..", "config.json");
}

function loadConfig(path: string): AppConfig {
  if (!existsSync(path)) {
    return { connections: [] };
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveConfig(path: string, config: AppConfig): void {
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ── Readline helper ─────────────────────────────────────────────────

function createRL() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: ReturnType<typeof createRL>, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function askYesNo(rl: ReturnType<typeof createRL>, question: string, defaultVal = false): Promise<boolean> {
  const hint = defaultVal ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    rl.question(`${question} ${hint}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a) return resolve(defaultVal);
      resolve(a === "y" || a === "yes");
    });
  });
}

// ── Commands ────────────────────────────────────────────────────────

async function cmdList() {
  const configPath = getConfigPath();
  const config = loadConfig(configPath);

  if (config.connections.length === 0) {
    console.log("No connections configured.");
    console.log(`Config: ${configPath}`);
    return;
  }

  console.log(`\n  Connections (${configPath}):\n`);
  for (const conn of config.connections) {
    const db = conn.database ? ` db=${conn.database}` : "";
    const ssh = conn.ssh ? ` [SSH: ${conn.ssh.host}:${conn.ssh.port ?? 22}]` : "";
    const ssl = conn.ssl ? " [SSL]" : "";
    const mode = conn.readonly !== false ? " (read-only)" : " (read-write)";
    console.log(`  ${bold(conn.name)}: ${conn.host}:${conn.port ?? 3306}${db}${ssh}${ssl}${mode}`);
  }
  console.log();
}

async function cmdAdd(name?: string) {
  const configPath = getConfigPath();
  const config = loadConfig(configPath);
  const rl = createRL();

  try {
    console.log("\n  Add a new MySQL connection\n");

    const connName = name || await ask(rl, "  Connection name");
    if (!connName) {
      console.log("  Name is required.");
      return;
    }
    if (config.connections.find((c) => c.name === connName)) {
      console.log(`  Connection "${connName}" already exists. Use 'mysql-mcp remove ${connName}' first.`);
      return;
    }

    const host = await ask(rl, "  MySQL host", "127.0.0.1");
    const port = parseInt(await ask(rl, "  MySQL port", "3306"), 10);
    const user = await ask(rl, "  MySQL user", "root");
    const password = await ask(rl, "  MySQL password");
    const database = await ask(rl, "  Default database (optional)");
    const readonly = await askYesNo(rl, "  Read-only?", true);

    const conn: DatabaseConfig = {
      name: connName,
      host,
      port,
      user,
      password: password || undefined,
      database: database || undefined,
      readonly,
    };

    // SSH tunnel
    const useSSH = await askYesNo(rl, "\n  Use SSH tunnel?");
    if (useSSH) {
      const sshHost = await ask(rl, "  SSH host");
      const sshPort = parseInt(await ask(rl, "  SSH port", "22"), 10);
      const sshUsername = await ask(rl, "  SSH username");
      const useKey = await askYesNo(rl, "  Use private key?", true);

      const ssh: SSHConfig = {
        host: sshHost,
        port: sshPort,
        username: sshUsername,
      };

      if (useKey) {
        ssh.privateKeyPath = expandTilde(
          await ask(rl, "  Private key path", "~/.ssh/id_rsa")
        );
        const passphrase = await ask(rl, "  Key passphrase (optional)");
        if (passphrase) ssh.passphrase = passphrase;
      } else {
        ssh.password = await ask(rl, "  SSH password");
      }

      conn.ssh = ssh;
    }

    // SSL
    const useSSL = await askYesNo(rl, "\n  Use SSL/TLS?");
    if (useSSL) {
      const useCustomCerts = await askYesNo(rl, "  Use custom certificates?");
      if (useCustomCerts) {
        const ca = await ask(rl, "  CA cert path (optional)");
        const cert = await ask(rl, "  Client cert path (optional)");
        const key = await ask(rl, "  Client key path (optional)");
        conn.ssl = {
          ca: ca ? expandTilde(ca) : undefined,
          cert: cert ? expandTilde(cert) : undefined,
          key: key ? expandTilde(key) : undefined,
          rejectUnauthorized: true,
        };
      } else {
        conn.ssl = true;
      }
    }

    // Test before saving?
    const shouldTest = await askYesNo(rl, "\n  Test connection before saving?", true);
    rl.close();

    if (shouldTest) {
      const ok = await testConnection(conn);
      if (!ok) {
        console.log("\n  Connection failed. Save anyway? Run: mysql-mcp add");
        return;
      }
    }

    config.connections.push(conn);
    saveConfig(configPath, config);
    console.log(`\n  ${green("+")} Connection "${connName}" saved to ${configPath}`);
  } finally {
    rl.close();
  }
}

async function cmdRemove(name?: string) {
  const configPath = getConfigPath();
  const config = loadConfig(configPath);

  if (!name) {
    console.log("Usage: mysql-mcp remove <connection-name>");
    return;
  }

  const idx = config.connections.findIndex((c) => c.name === name);
  if (idx === -1) {
    console.log(`Connection "${name}" not found.`);
    return;
  }

  config.connections.splice(idx, 1);
  saveConfig(configPath, config);
  console.log(`${green("-")} Removed "${name}" from ${configPath}`);
}

async function cmdTest(name?: string) {
  const configPath = getConfigPath();
  const config = loadConfig(configPath);

  if (config.connections.length === 0) {
    console.log("No connections configured.");
    return;
  }

  const targets = name
    ? config.connections.filter((c) => c.name === name)
    : config.connections;

  if (targets.length === 0) {
    console.log(`Connection "${name}" not found.`);
    return;
  }

  console.log();
  for (const conn of targets) {
    process.stdout.write(`  Testing ${bold(conn.name)}... `);
    await testConnection(conn, true);
  }
  console.log();
}

async function cmdInit() {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    console.log(`Config already exists at ${configPath}`);
    console.log('Use "mysql-mcp add" to add connections.');
    return;
  }

  saveConfig(configPath, { connections: [] });
  console.log(`Created empty config at ${configPath}`);
  console.log('Run "mysql-mcp add" to add your first connection.');
}

// ── Connection tester ───────────────────────────────────────────────

async function testConnection(conn: DatabaseConfig, inline = false): Promise<boolean> {
  let mysqlHost = conn.host;
  let mysqlPort = conn.port ?? 3306;
  let sshClient: SSHClient | undefined;
  let localServer: net.Server | undefined;

  try {
    // SSH tunnel if needed
    if (conn.ssh) {
      const tunnel = await setupTestTunnel(conn);
      mysqlHost = "127.0.0.1";
      mysqlPort = tunnel.port;
      sshClient = tunnel.sshClient;
      localServer = tunnel.localServer;
      if (!inline) process.stdout.write("  SSH tunnel established... ");
    }

    const poolOpts: mysql.PoolOptions = {
      host: mysqlHost,
      port: mysqlPort,
      user: conn.user,
      password: conn.password,
      database: conn.database || undefined,
      connectTimeout: 10000,
      connectionLimit: 1,
    };

    if (conn.ssl) {
      if (conn.ssl === true) {
        poolOpts.ssl = {};
      } else {
        poolOpts.ssl = {
          ca: conn.ssl.ca ? readFileSync(conn.ssl.ca) : undefined,
          cert: conn.ssl.cert ? readFileSync(conn.ssl.cert) : undefined,
          key: conn.ssl.key ? readFileSync(conn.ssl.key) : undefined,
          rejectUnauthorized: conn.ssl.rejectUnauthorized ?? true,
        };
      }
    }

    const pool = mysql.createPool(poolOpts);
    const connection = await pool.getConnection();

    // Get version info
    const [rows] = await connection.query("SELECT VERSION() AS version");
    const version = (rows as Array<Record<string, string>>)[0]?.version ?? "unknown";

    // Count databases accessible
    const [dbs] = await connection.query("SHOW DATABASES");
    const dbCount = (dbs as unknown[]).length;

    connection.release();
    await pool.end();

    const msg = `${green("OK")} MySQL ${version}, ${dbCount} database(s) accessible`;
    if (inline) {
      console.log(msg);
    } else {
      console.log(`\n  ${msg}`);
    }
    return true;
  } catch (err) {
    const msg = `${red("FAIL")} ${err instanceof Error ? err.message : err}`;
    if (inline) {
      console.log(msg);
    } else {
      console.log(`\n  ${msg}`);
    }
    return false;
  } finally {
    if (localServer) localServer.close();
    if (sshClient) sshClient.end();
  }
}

function setupTestTunnel(
  conn: DatabaseConfig
): Promise<{ port: number; sshClient: SSHClient; localServer: net.Server }> {
  return new Promise((resolve, reject) => {
    const ssh = conn.ssh!;
    const client = new SSHClient();

    const config: Record<string, unknown> = {
      host: ssh.host,
      port: ssh.port ?? 22,
      username: ssh.username,
      readyTimeout: 10000,
    };

    if (ssh.privateKeyPath) {
      config.privateKey = readFileSync(ssh.privateKeyPath);
      if (ssh.passphrase) config.passphrase = ssh.passphrase;
    } else if (ssh.password) {
      config.password = ssh.password;
    }

    client.on("error", reject);
    client.on("ready", () => {
      const server = net.createServer((sock) => {
        client.forwardOut("127.0.0.1", 0, conn.host, conn.port ?? 3306, (err, stream) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(stream).pipe(sock);
          sock.on("error", () => stream.destroy());
          stream.on("error", () => sock.destroy());
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        resolve({ port: addr.port, sshClient: client, localServer: server });
      });
      server.on("error", reject);
    });

    client.connect(config as any);
  });
}

// ── Terminal colors ─────────────────────────────────────────────────

function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }

// ── Usage ───────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
  ${bold("mysql-mcp")} — MySQL MCP Server CLI

  ${bold("Usage:")}
    mysql-mcp <command> [options]

  ${bold("Commands:")}
    list                  List all configured connections
    add [name]            Add a new connection (interactive)
    remove <name>         Remove a connection
    test [name]           Test connection(s)
    init                  Create an empty config file
    serve                 Start the MCP server (default)

  ${bold("Environment:")}
    MYSQL_MCP_CONFIG      Path to config.json (default: ./config.json)

  ${bold("Examples:")}
    mysql-mcp init
    mysql-mcp add production
    mysql-mcp test
    mysql-mcp test production
    mysql-mcp list
    mysql-mcp remove staging
`);
}

// ── Main ────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "list":
  case "ls":
    cmdList();
    break;
  case "add":
    cmdAdd(args[0]);
    break;
  case "remove":
  case "rm":
    cmdRemove(args[0]);
    break;
  case "test":
    cmdTest(args[0]);
    break;
  case "init":
    cmdInit();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  default:
    console.log(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
