export interface SSHConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /**
   * Optional SHA256 host key fingerprint for MITM prevention.
   * Format: "SHA256:abc123..." (the output of `ssh-keygen -lf <pubkey>`).
   * When set, the SSH connection rejects servers whose host key fingerprint
   * does not match. When omitted, the connection proceeds without
   * verification and a warning is logged.
   */
  hostFingerprint?: string;
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
