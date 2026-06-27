import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

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
  floor_remote_forwards: boolean;
  // How long a "normal"-urgency message waits queued before the broker pushes it
  // anyway (epoch-ms window). The wait gives the recipient a chance to drain it via
  // check_messages at a task boundary — the cheap path, no inference turn spent.
  push_delay_ms: number;
  // Seed each session's summary at registration from git state (branch + recent
  // files). Summaries gossip to sibling brokers like cwd and git_root already do;
  // set false to keep new sessions' summaries empty until they call set_summary.
  auto_summary: boolean;
}

const DEFAULT_PUSH_DELAY_MS = 120_000;

const REQUIRED_FIELDS = ["machine", "tailscale_ip", "port", "id_prefix", "siblings", "allowed_ips"] as const;

const HOME = homedir();
const DEFAULT_CONFIG_PATH = `${HOME}/.claude-peers.json`;
const DEFAULT_DB_PATH = `${HOME}/.claude-peers.db`;

/**
 * Build the zero-config single-host default: a loopback-only, non-federated island
 * (port 7899, hostname-derived machine and id_prefix, no siblings, allowed_ips loopback,
 * remote forwards floored). Used only when no config was requested and the default
 * ~/.claude-peers.json is absent — a fresh single-host install.
 */
export function singleHostDefault(): PeersConfig {
  const host = hostname();
  const id_prefix = host.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 3) || "peer";
  return {
    machine: host,
    tailscale_ip: "127.0.0.1",
    port: 7899,
    id_prefix,
    siblings: [],
    allowed_ips: ["127.0.0.1"],
    db_path: process.env.CLAUDE_PEERS_DB ?? DEFAULT_DB_PATH,
    floor_remote_forwards: true,
    push_delay_ms: DEFAULT_PUSH_DELAY_MS,
    auto_summary: true,
  };
}

export function loadConfig(path?: string): PeersConfig {
  // An explicit path (arg or CLAUDE_PEERS_CONFIG) names a config the caller MEANT to load —
  // a per-host deploy config. The zero-config default is only for a fresh install that
  // requested nothing, so track whether a path was explicitly requested.
  const explicitPath = path ?? process.env.CLAUDE_PEERS_CONFIG;
  const configPath = explicitPath ?? DEFAULT_CONFIG_PATH;
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    // A present-but-unreadable config (a permission error, or a path that is a directory) is
    // an explicit misconfiguration — re-throw so it fails loudly, never silently default.
    if ((err as { code?: string }).code !== "ENOENT") throw err;
    // An explicitly-requested path that is missing is also a real misconfiguration (a typo'd
    // CLAUDE_PEERS_CONFIG, a deploy config that did not land) — fail loudly rather than boot a
    // federated node as an isolated loopback island. Only the absent DEFAULT path means a
    // fresh single-host install, which falls back to the zero-config default.
    if (explicitPath !== undefined) throw err;
    return singleHostDefault();
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

  // db_path from: env var > config file > default. Resolve a relative path against the config
  // file's directory — a stable, cwd-independent anchor — not the process cwd, so the broker,
  // the MCP server, and `cli.ts doorbell` all derive the SAME absolute db_path (and the same
  // doorbell marker directory) no matter which directory each was launched from. A cwd-relative
  // resolve would let a watcher and the broker watch different files and silently miss wakes.
  const rawDbPath = process.env.CLAUDE_PEERS_DB ?? (obj.db_path as string | undefined) ?? DEFAULT_DB_PATH;
  const db_path = isAbsolute(rawDbPath) ? rawDbPath : resolve(dirname(configPath), rawDbPath);
  // Secure-by-default: floor remote forwards unless the operator explicitly opts
  // out with `false`. An absent or non-boolean value floors (queues for
  // check_messages) so a remote machine cannot auto-paste into a live pane until
  // federation traffic is authenticated. Local same-machine peers still push.
  const floor_remote_forwards = obj.floor_remote_forwards !== false;
  // A non-numeric or negative value falls back rather than throwing: the field is an
  // optional tuning knob, and a typo should not keep a whole node's sessions from starting.
  const push_delay_ms =
    typeof obj.push_delay_ms === "number" && Number.isFinite(obj.push_delay_ms) && obj.push_delay_ms >= 0
      ? obj.push_delay_ms
      : DEFAULT_PUSH_DELAY_MS;
  // Defaults on: the seed is same-class metadata as the cwd/git_root fields that already
  // federate. Only an explicit false disables it (mirrors floor_remote_forwards parsing).
  const auto_summary = obj.auto_summary !== false;

  return { ...obj, db_path, floor_remote_forwards, push_delay_ms, auto_summary } as PeersConfig;
}
