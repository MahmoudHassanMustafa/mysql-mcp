export interface SSHConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface SSLConfig {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

export interface DatabaseConfig {
  name: string;
  host: string;
  port?: number;
  user: string;
  password?: string;
  database?: string;
  ssh?: SSHConfig;
  ssl?: SSLConfig | boolean;
  readonly?: boolean;
  queryTimeout?: number;
}

export interface AppConfig {
  connections: DatabaseConfig[];
}
