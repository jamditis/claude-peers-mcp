import { readFileSync } from "fs";
import { homedir } from "os";

export interface SiblingConfig {
  machine: string;
  url: string;
}

export interface PeersConfig {
  machine: string;
  tailscale_ip: string;
  port: number;
  id_prefix: string;
  siblings: SiblingConfig[];
  allowed_ips: string[];
  db_path: string;
}

const REQUIRED_FIELDS = ["machine", "tailscale_ip", "port", "id_prefix", "siblings", "allowed_ips"] as const;

const HOME = homedir();
const DEFAULT_CONFIG_PATH = `${HOME}/.claude-peers.json`;
const DEFAULT_DB_PATH = `${HOME}/.claude-peers.db`;

export function loadConfig(path?: string): PeersConfig {
  const configPath = path ?? process.env.CLAUDE_PEERS_CONFIG ?? DEFAULT_CONFIG_PATH;
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`Config file not found: ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config JSON at ${configPath}: ${message}`);
  }

  const obj = parsed as Record<string, unknown>;

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) {
      throw new Error(`Missing required config field: ${field}`);
    }
  }

  // db_path from: env var > config file > default
  const db_path = process.env.CLAUDE_PEERS_DB ?? (obj.db_path as string | undefined) ?? DEFAULT_DB_PATH;

  return { ...obj, db_path } as PeersConfig;
}
