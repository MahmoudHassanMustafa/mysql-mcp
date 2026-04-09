# mysql-mcp

A Model Context Protocol (MCP) server that connects Claude Code to MySQL databases. Supports SSH tunnels, SSL/TLS, and multiple simultaneous connections.

## Features

- **20 tools** for schema introspection, querying, ERD generation, and programmability
- **2 MCP resources** for browsable schema access
- **4 MCP prompts** for guided database workflows
- **SSH tunnel support** with password or private key authentication
- **SSL/TLS support** for direct encrypted connections
- **Multi-database** connections with independent configs
- **Read-only by default** with per-connection write control
- **CLI** for managing connections without editing JSON

## Installation

```bash
cd mysql-mcp
pnpm install
pnpm build
```

### Register with Claude Code

```bash
claude mcp add mysql-mcp -e MYSQL_MCP_CONFIG=/path/to/config.json -- node /path/to/mysql-mcp/dist/index.js
```

Or manually in `~/.claude.json`:

```json
{
  "mcpServers": {
    "mysql-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mysql-mcp/dist/index.js"],
      "env": {
        "MYSQL_MCP_CONFIG": "/path/to/config.json"
      }
    }
  }
}
```

## CLI

The CLI manages your `config.json` without editing it by hand.

```bash
# Link globally (once)
pnpm link --global

# Or run directly
node dist/cli.js <command>
```

### Commands

| Command | Description |
|---------|-------------|
| `mysql-mcp list` | List all configured connections |
| `mysql-mcp add [name]` | Add a new connection (interactive) |
| `mysql-mcp remove <name>` | Remove a connection |
| `mysql-mcp test [name]` | Test one or all connections |
| `mysql-mcp init` | Create an empty config file |

### Examples

```bash
# Create config and add first connection interactively
mysql-mcp init
mysql-mcp add production

# Test all connections
mysql-mcp test

# Test a specific connection
mysql-mcp test production

# Remove a connection
mysql-mcp remove staging
```

Set `MYSQL_MCP_CONFIG` in your shell profile so the CLI always finds your config:

```bash
export MYSQL_MCP_CONFIG=~/.config/mysql-mcp/config.json
```

## Configuration

Three ways to configure, in order of precedence:

### 1. Config file (recommended)

Set `MYSQL_MCP_CONFIG` to a JSON file path, or use the CLI to build one.

```json
{
  "connections": [
    {
      "name": "local",
      "host": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "secret",
      "database": "myapp",
      "readonly": true,
      "queryTimeout": 30000
    }
  ]
}
```

### 2. Inline JSON

Set `MYSQL_MCP_CONFIG_JSON` to a JSON string:

```bash
MYSQL_MCP_CONFIG_JSON='{"connections":[{"name":"dev","host":"localhost","user":"root","password":"secret","database":"myapp"}]}'
```

### 3. Environment variables (single connection)

```bash
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=secret
MYSQL_DATABASE=myapp
MYSQL_READONLY=true
MYSQL_QUERY_TIMEOUT=30000
MYSQL_CONNECTION_NAME=default
```

### Connection options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Unique connection identifier |
| `host` | string | required | MySQL hostname or IP |
| `port` | number | `3306` | MySQL port |
| `user` | string | required | MySQL username |
| `password` | string | | MySQL password |
| `database` | string | | Default database/schema |
| `readonly` | boolean | `true` | Block write operations |
| `queryTimeout` | number | `30000` | Query timeout in milliseconds |
| `ssh` | object | | SSH tunnel configuration |
| `ssl` | object or `true` | | SSL/TLS configuration |

### SSH tunnel

Tunnel MySQL traffic through an SSH bastion host. Supports password and private key authentication.

```json
{
  "name": "production",
  "host": "rds-internal.example.com",
  "port": 3306,
  "user": "app",
  "password": "secret",
  "database": "prod",
  "readonly": true,
  "ssh": {
    "host": "bastion.example.com",
    "port": 22,
    "username": "deploy",
    "privateKeyPath": "~/.ssh/id_rsa",
    "passphrase": "optional"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | string | required | SSH server hostname |
| `port` | number | `22` | SSH port |
| `username` | string | required | SSH username |
| `password` | string | | SSH password |
| `privateKeyPath` | string | | Path to private key (supports `~/`) |
| `passphrase` | string | | Private key passphrase |

### SSL/TLS

For direct encrypted connections (without SSH):

```json
{
  "ssl": true
}
```

Or with custom certificates:

```json
{
  "ssl": {
    "ca": "~/.ssl/ca.pem",
    "cert": "~/.ssl/client-cert.pem",
    "key": "~/.ssl/client-key.pem",
    "rejectUnauthorized": true
  }
}
```

## Tools

### Connection management

| Tool | Description |
|------|-------------|
| `list_connections` | List all connections with status, host, SSH/SSL indicators |
| `list_databases` | List all databases accessible on a connection |
| `use_database` | Switch the active database/schema for a connection |

### Schema introspection

| Tool | Description |
|------|-------------|
| `list_tables` | List tables with row counts and engine info |
| `describe_table` | Show columns, indexes, and CREATE TABLE statement |
| `get_ddl` | Get clean CREATE TABLE DDL |
| `get_foreign_keys` | Show FK relationships with cascade rules |
| `get_indexes` | Show all indexes with duplicate detection |
| `search_columns` | Find columns by name pattern across all tables |

### Query execution

| Tool | Description |
|------|-------------|
| `execute_query` | Run SQL with parameterized values. Writes blocked on read-only connections |
| `explain_query` | Run EXPLAIN in TRADITIONAL, JSON, or TREE format |

### Data inspection

| Tool | Description |
|------|-------------|
| `get_table_stats` | Row counts, data/index sizes, timestamps |
| `sample_data` | Preview rows from a table (default: 5 rows) |

### Stored routines and programmability

| Tool | Description |
|------|-------------|
| `list_routines` | List stored procedures and functions |
| `get_routine_ddl` | Get full DDL for a procedure or function |
| `list_triggers` | List triggers, optionally filtered by table |
| `get_trigger_ddl` | Get full trigger definition |
| `list_events` | List scheduled events with status and timing |
| `get_event_ddl` | Get full event definition |

### Visualization

| Tool | Description |
|------|-------------|
| `generate_erd` | Generate a Mermaid ER diagram with tables, columns, PKs, FKs, and relationships |

## Resources

MCP resources let Claude browse schema information without explicit tool calls.

| URI Pattern | Description |
|-------------|-------------|
| `mysql://{connection}/{database}/{table}/schema` | Table schema with columns and DDL |
| `mysql://{connection}/{database}/overview` | Database overview with all tables and row counts |

## Prompts

Pre-built prompt templates that guide Claude through multi-step database workflows.

| Prompt | Description |
|--------|-------------|
| `explore_database` | Discover tables, schemas, FKs, routines, triggers, events, and generate an ERD |
| `optimize_query` | Analyze a query with EXPLAIN, check indexes, suggest improvements |
| `find_data` | Search columns by pattern, sample tables, build a query |
| `audit_schema` | Check for missing PKs, redundant indexes, empty tables, catalog routines and triggers |

### Using prompts in Claude Code

Prompts appear in the MCP prompt list. Select one and provide the required arguments (connection name, database, etc.) to start a guided workflow.

## Safety

- **Read-only by default.** Write queries (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE) are blocked unless `"readonly": false` is set on the connection.
- **Parameterized queries.** The `execute_query` tool uses prepared statements with `?` placeholders to prevent SQL injection.
- **Result limits.** Query results are capped at 500 rows. Column values are truncated at 60 characters in table output.
- **Config file in .gitignore.** The `config.json` file containing credentials is excluded from version control.

## Project structure

```
mysql-mcp/
  src/
    index.ts              Server entry point (MCP stdio transport)
    cli.ts                CLI entry point
    types.ts              TypeScript interfaces
    config.ts             Config loading (file, inline JSON, env vars)
    connection.ts         MySQL pool management + SSH tunneling
    helpers.ts            Shared utilities (formatting, escaping, errors)
    resources.ts          MCP resource templates
    prompts.ts            MCP prompt templates
    tools/
      index.ts            Tool registration barrel
      connection-tools.ts list_connections, list_databases, use_database
      schema-tools.ts     list_tables, describe_table, get_ddl, get_foreign_keys, get_indexes, search_columns
      query-tools.ts      execute_query, explain_query
      data-tools.ts       sample_data, get_table_stats
      routines-tools.ts   list_routines, get_routine_ddl, list_triggers, get_trigger_ddl, list_events, get_event_ddl
      erd-tool.ts         generate_erd
  dist/                   Compiled output
  config.json             Your connections (gitignored)
  config.example.json     Example configuration
```

## License

MIT
