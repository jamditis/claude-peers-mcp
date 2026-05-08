#!/usr/bin/env bun
/**
 * claude-peers broker daemon (federated)
 *
 * A singleton HTTP server backed by SQLite.
 * Tracks local peers, syncs with sibling brokers via gossip,
 * and routes messages between local and remote peers.
 */

import { Database } from "bun:sqlite";
import { loadConfig, type SiblingConfig } from "./shared/config.ts";
import type {
  RegisterRequest, RegisterResponse, HeartbeatRequest,
  SetSummaryRequest, ListPeersRequest, SendMessageRequest,
  PollMessagesRequest, PollMessagesResponse, Peer, Message,
  GossipRequest, ForwardMessageRequest,
} from "./shared/types.ts";

const PROTOCOL_VERSION = 1;
const GOSSIP_INTERVAL_MS = 5_000;
const CLEANUP_INTERVAL_MS = 15_000;
const REMOTE_TTL_MS = 30_000;
const GOSSIP_SUMMARY_INTERVAL_MS = 5 * 60_000;

// --- Exported testable functions (no side effects) ---

export function generatePeerId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = prefix + "-";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function isAllowedIp(ip: string, allowList: string[]): boolean {
  const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return allowList.includes(normalized);
}

export function mergeGossipPeers(
  db: Database, peers: Peer[], machine: string, tailscaleIp: string
): void {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO remote_peers
      (id, machine, tailscale_ip, pid, cwd, git_root, tty, summary, registered_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const p of peers) {
    upsert.run(p.id, machine, tailscaleIp, p.pid, p.cwd,
      p.git_root, p.tty, p.summary, p.registered_at, now);
  }
}

export function pruneRemotePeers(db: Database, ttlMs: number): number {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const result = db.run("DELETE FROM remote_peers WHERE last_seen < ?", [cutoff]);
  return result.changes;
}

export function resolveTargetBroker(
  db: Database, toId: string, siblings: SiblingConfig[]
): string | null {
  const remote = db.query("SELECT machine FROM remote_peers WHERE id = ?").get(toId) as
    { machine: string } | null;
  if (!remote) return null;
  const sibling = siblings.find(s => s.machine === remote.machine);
  return sibling?.url ?? null;
}

export interface GossipFailureState {
  firstFailureAt: number;
  lastSummaryAt: number;
  failureCount: number;
}

export interface GossipLogResult {
  state: GossipFailureState | null;
  logLine: string | null;
}

function formatGossipDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function recordGossipResult(
  prev: GossipFailureState | null,
  succeeded: boolean,
  errorMessage: string,
  machine: string,
  now: number,
  summaryIntervalMs: number,
): GossipLogResult {
  if (succeeded) {
    if (prev === null) return { state: null, logLine: null };
    const duration = formatGossipDuration(now - prev.firstFailureAt);
    const noun = prev.failureCount === 1 ? "failure" : "failures";
    return {
      state: null,
      logLine: `Gossip to ${machine} recovered after ${prev.failureCount} ${noun} over ${duration}`,
    };
  }
  if (prev === null) {
    return {
      state: { firstFailureAt: now, lastSummaryAt: now, failureCount: 1 },
      logLine: `Gossip to ${machine} failed: ${errorMessage}`,
    };
  }
  const newCount = prev.failureCount + 1;
  if (now - prev.lastSummaryAt >= summaryIntervalMs) {
    const duration = formatGossipDuration(now - prev.firstFailureAt);
    return {
      state: { ...prev, failureCount: newCount, lastSummaryAt: now },
      logLine: `Gossip to ${machine} still failing: ${newCount} failures over ${duration} (latest: ${errorMessage})`,
    };
  }
  return {
    state: { ...prev, failureCount: newCount },
    logLine: null,
  };
}

// --- Main: only runs when executed directly (not imported by tests) ---

if (import.meta.main) {
  const config = loadConfig();
  const PORT = config.port;
  const DB_PATH = config.db_path;

  // --- Database setup ---
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");

  db.run(`CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY, pid INTEGER NOT NULL, machine TEXT NOT NULL,
    tailscale_ip TEXT NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
    summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS remote_peers (
    id TEXT PRIMARY KEY, machine TEXT NOT NULL, tailscale_ip TEXT NOT NULL,
    pid INTEGER NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
    summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    text TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
  )`);

  // --- Prepared statements ---
  const insertPeer = db.prepare(`
    INSERT INTO peers (id, pid, machine, tailscale_ip, cwd, git_root, tty, summary, registered_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateLastSeen = db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?");
  const updateSummary = db.prepare("UPDATE peers SET summary = ? WHERE id = ?");
  const deletePeer = db.prepare("DELETE FROM peers WHERE id = ?");
  const selectAllPeers = db.prepare("SELECT * FROM peers");
  const selectPeersByDirectory = db.prepare("SELECT * FROM peers WHERE cwd = ?");
  const selectPeersByGitRoot = db.prepare("SELECT * FROM peers WHERE git_root = ?");
  const selectAllRemotePeers = db.prepare("SELECT * FROM remote_peers");
  const insertMessage = db.prepare(
    "INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?, ?, ?, ?, 0)"
  );
  const selectUndelivered = db.prepare(
    "SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC"
  );
  const markDelivered = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?");
  const deleteUndeliveredForPeer = db.prepare(
    "DELETE FROM messages WHERE to_id = ? AND delivered = 0"
  );

  // --- Clean stale peers ---
  function cleanStalePeers() {
    const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
    for (const peer of peers) {
      try { process.kill(peer.pid, 0); } catch { deleteUndeliveredForPeer.run(peer.id); deletePeer.run(peer.id); }
    }
    pruneRemotePeers(db, REMOTE_TTL_MS);
  }
  cleanStalePeers();

  // --- Request handlers ---
  function handleRegister(body: RegisterRequest): RegisterResponse {
    const id = generatePeerId(config.id_prefix);
    const now = new Date().toISOString();
    const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
    if (existing) { deleteUndeliveredForPeer.run(existing.id); deletePeer.run(existing.id); }
    insertPeer.run(id, body.pid, config.machine, config.tailscale_ip,
      body.cwd, body.git_root, body.tty, body.summary, now, now);
    return { id };
  }

  function handleListPeers(body: ListPeersRequest): Peer[] {
    let localPeers: Peer[];
    switch (body.scope) {
      case "directory":
        localPeers = selectPeersByDirectory.all(body.cwd) as Peer[];
        break;
      case "repo":
        localPeers = body.git_root
          ? selectPeersByGitRoot.all(body.git_root) as Peer[]
          : selectPeersByDirectory.all(body.cwd) as Peer[];
        break;
      default:
        localPeers = selectAllPeers.all() as Peer[];
    }
    localPeers = localPeers
      .filter(p => {
        try { process.kill(p.pid, 0); return true; } catch { deleteUndeliveredForPeer.run(p.id); deletePeer.run(p.id); return false; }
      })
      .map(p => ({ ...p, is_remote: false }));

    let allPeers: Peer[];
    if (body.scope === "machine") {
      const remotePeers = (selectAllRemotePeers.all() as any[]).map(p => ({ ...p, is_remote: true }));
      allPeers = [...localPeers, ...remotePeers];
    } else {
      allPeers = localPeers;
    }
    if (body.exclude_id) allPeers = allPeers.filter(p => p.id !== body.exclude_id);
    return allPeers;
  }

  async function handleSendMessage(body: SendMessageRequest): Promise<{ ok: boolean; error?: string; routed?: string }> {
    const localTarget = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id);
    if (localTarget) {
      insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
      return { ok: true, routed: "local" };
    }
    const siblingUrl = resolveTargetBroker(db, body.to_id, config.siblings);
    if (!siblingUrl) return { ok: false, error: `Peer ${body.to_id} not found` };
    try {
      const res = await fetch(`${siblingUrl}/forward-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: PROTOCOL_VERSION, from_id: body.from_id,
          to_id: body.to_id, text: body.text, from_machine: config.machine,
        } satisfies ForwardMessageRequest),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { ok: false, error: `Remote broker error: ${res.status}` };
      const result = await res.json() as { ok: boolean };
      if (!result.ok) return { ok: false, error: "Remote broker rejected message (target peer not found)" };
      return { ok: true, routed: "remote" };
    } catch {
      return { ok: false, error: "Remote broker unreachable" };
    }
  }

  function handleForwardMessage(body: ForwardMessageRequest): { ok: boolean } {
    if (body.protocol_version !== PROTOCOL_VERSION) {
      console.error(`[claude-peers broker] Warning: received protocol_version ${body.protocol_version}, expected ${PROTOCOL_VERSION}`);
    }
    const localTarget = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id);
    if (!localTarget) {
      console.error(`[claude-peers broker] Dropping forwarded message: unknown local peer ${body.to_id}`);
      return { ok: false };
    }
    insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
    return { ok: true };
  }

  function handleGossip(body: GossipRequest): { ok: boolean } {
    if (body.protocol_version !== PROTOCOL_VERSION) {
      console.error(`[claude-peers broker] Warning: gossip protocol_version ${body.protocol_version}, expected ${PROTOCOL_VERSION}`);
    }
    mergeGossipPeers(db, body.peers, body.machine, body.tailscale_ip);
    // Remove remote peers from this machine that are no longer in the payload
    // (handles graceful shutdown sending empty list, and mid-session deregistrations)
    if (body.peers.length === 0) {
      db.run("DELETE FROM remote_peers WHERE machine = ?", [body.machine]);
    } else {
      const incomingIds = body.peers.map(p => p.id);
      const placeholders = incomingIds.map(() => "?").join(", ");
      db.run(
        `DELETE FROM remote_peers WHERE machine = ? AND id NOT IN (${placeholders})`,
        [body.machine, ...incomingIds]
      );
    }
    return { ok: true };
  }

  function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
    const messages = selectUndelivered.all(body.id) as Message[];
    for (const msg of messages) markDelivered.run(msg.id);
    return { messages };
  }

  // Peek: return undelivered messages WITHOUT marking them delivered
  function handlePeekMessages(body: PollMessagesRequest): PollMessagesResponse {
    const messages = selectUndelivered.all(body.id) as Message[];
    return { messages };
  }

  // Ack: mark specific message IDs as delivered
  function handleAckMessages(body: { ids: number[] }): { ok: boolean } {
    for (const id of body.ids) markDelivered.run(id);
    return { ok: true };
  }

  // --- Gossip loop ---
  const gossipFailureStates = new Map<string, GossipFailureState>();

  async function gossipToSiblings(peerList?: Peer[]) {
    const peers = peerList ?? (selectAllPeers.all() as Peer[]).filter(p => {
      try { process.kill(p.pid, 0); return true; } catch { return false; }
    });
    for (const sibling of config.siblings) {
      let succeeded = false;
      let errorMessage = "";
      try {
        await fetch(`${sibling.url}/gossip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol_version: PROTOCOL_VERSION, machine: config.machine,
            tailscale_ip: config.tailscale_ip, peers,
          } satisfies GossipRequest),
          signal: AbortSignal.timeout(3000),
        });
        succeeded = true;
      } catch (e) {
        errorMessage = e instanceof Error ? e.message : String(e);
      }
      const prev = gossipFailureStates.get(sibling.machine) ?? null;
      const result = recordGossipResult(prev, succeeded, errorMessage, sibling.machine, Date.now(), GOSSIP_SUMMARY_INTERVAL_MS);
      if (result.state === null) gossipFailureStates.delete(sibling.machine);
      else gossipFailureStates.set(sibling.machine, result.state);
      if (result.logLine !== null) console.error(`[claude-peers broker] ${result.logLine}`);
    }
  }

  let gossipInFlight = false;
  const gossipTimer = setInterval(async () => {
    if (gossipInFlight) return;
    gossipInFlight = true;
    try {
      await gossipToSiblings();
    } finally {
      gossipInFlight = false;
    }
  }, GOSSIP_INTERVAL_MS);
  const cleanupTimer = setInterval(cleanStalePeers, CLEANUP_INTERVAL_MS);

  // --- Graceful shutdown ---
  async function shutdown() {
    clearInterval(gossipTimer);
    clearInterval(cleanupTimer);
    await gossipToSiblings([]);
    db.close();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // --- HTTP Server ---
  Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    async fetch(req, server) {
      const socketInfo = server.requestIP(req);
      const clientIp = socketInfo?.address ?? "unknown";
      if (!isAllowedIp(clientIp, config.allowed_ips)) {
        console.error(`[claude-peers broker] Rejected connection from ${clientIp}`);
        return Response.json({ error: "forbidden" }, { status: 403 });
      }

      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method !== "POST") {
        if (path === "/health") {
          return Response.json({
            status: "ok", peers: (selectAllPeers.all() as any[]).length,
            machine: config.machine, remote_peer_count: (selectAllRemotePeers.all() as any[]).length,
          });
        }
        return new Response("claude-peers broker (federated)", { status: 200 });
      }

      try {
        const body = await req.json();
        switch (path) {
          case "/register": return Response.json(handleRegister(body));
          case "/heartbeat":
            updateLastSeen.run(new Date().toISOString(), body.id);
            return Response.json({ ok: true });
          case "/set-summary":
            updateSummary.run(body.summary, body.id);
            return Response.json({ ok: true });
          case "/list-peers": return Response.json(handleListPeers(body));
          case "/send-message": return Response.json(await handleSendMessage(body));
          case "/poll-messages": return Response.json(handlePollMessages(body));
          case "/peek-messages": return Response.json(handlePeekMessages(body));
          case "/ack-messages": return Response.json(handleAckMessages(body));
          case "/unregister":
            deleteUndeliveredForPeer.run(body.id);
            deletePeer.run(body.id);
            return Response.json({ ok: true });
          case "/gossip": return Response.json(handleGossip(body));
          case "/forward-message": return Response.json(handleForwardMessage(body));
          default: return Response.json({ error: "not found" }, { status: 404 });
        }
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    },
  });

  console.error(`[claude-peers broker] listening on 0.0.0.0:${PORT} (machine: ${config.machine}, db: ${DB_PATH})`);
}
