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
  GossipRequest, ForwardMessageRequest, SendResult,
} from "./shared/types.ts";
import {
  ensureMessagesTable, migrateMessagesSchema, resetDeliveringOnStart,
  generateLeaseToken, claimForDelivery, confirmDelivered, releaseToQueued,
  reclaimIfExpired, nextDeliverable, formatPeerMessage,
  deliverViaTmux, isLoopback, isFederationRoute, isPidDead, pidProbe, pruneMessages, type TmuxSpawn,
} from "./delivery.ts";
import { PROTOCOL_VERSION } from "./shared/types.ts";

const GOSSIP_INTERVAL_MS = 5_000;
const CLEANUP_INTERVAL_MS = 15_000;
const REMOTE_TTL_MS = 30_000;
const DELIVERED_TTL_MS = 60_000;
const QUEUED_MAX_AGE_MS = 24 * 60 * 60_000; // lossy backstop
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
    summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL,
    tmux_pane TEXT, tmux_socket TEXT, delivery_kind TEXT NOT NULL DEFAULT 'none'
  )`);
  // Upgrade a legacy peers table that predates the delivery columns.
  for (const [col, type] of [["tmux_pane","TEXT"],["tmux_socket","TEXT"],["delivery_kind","TEXT NOT NULL DEFAULT 'none'"]] as const) {
    const present = (db.query("PRAGMA table_info(peers)").all() as { name: string }[]).some((c) => c.name === col);
    if (!present) db.run(`ALTER TABLE peers ADD COLUMN ${col} ${type}`);
  }

  db.run(`CREATE TABLE IF NOT EXISTS remote_peers (
    id TEXT PRIMARY KEY, machine TEXT NOT NULL, tailscale_ip TEXT NOT NULL,
    pid INTEGER NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
    summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL
  )`);

  ensureMessagesTable(db);
  migrateMessagesSchema(db);
  const requeued = resetDeliveringOnStart(db);
  if (requeued > 0) console.error(`[claude-peers broker] requeued ${requeued} orphaned delivering row(s) on start`);

  // --- Prepared statements ---
  const insertPeer = db.prepare(`
    INSERT INTO peers (id, pid, machine, tailscale_ip, cwd, git_root, tty, summary, registered_at, last_seen, tmux_pane, tmux_socket, delivery_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateLastSeen = db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?");
  const updateSummary = db.prepare("UPDATE peers SET summary = ? WHERE id = ?");
  const deletePeer = db.prepare("DELETE FROM peers WHERE id = ?");
  const selectAllPeers = db.prepare("SELECT * FROM peers");
  const selectPeersByDirectory = db.prepare("SELECT * FROM peers WHERE cwd = ?");
  const selectPeersByGitRoot = db.prepare("SELECT * FROM peers WHERE git_root = ?");
  const selectAllRemotePeers = db.prepare("SELECT * FROM remote_peers");
  const insertMessage = db.prepare(
    "INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)"
  );
  const selectQueued = db.prepare(
    "SELECT * FROM messages WHERE to_id = ? AND delivery_state = 'queued' ORDER BY id ASC"
  );
  const markPolled = db.prepare(
    "UPDATE messages SET delivery_state = 'delivered', lease_expires_at = NULL, lease_token = NULL WHERE id = ? AND delivery_state = 'queued'"
  );
  const deleteUndeliveredForPeer = db.prepare(
    "DELETE FROM messages WHERE to_id = ? AND delivery_state != 'delivered'"
  );

  // In-memory delivery guards (this process only). Declared up here, before
  // cleanStalePeers, so the sweep can skip a recipient that is mid-delivery;
  // deliverNext (further down) is what populates them.
  const activeRowIds = new Set<number>();
  const recipientsInFlight = new Set<string>();

  // --- Clean dead peers ---
  function cleanStalePeers() {
    const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
    for (const peer of peers) {
      // The pid probe is the only authoritative deadness signal (ESRCH alone — a foreign live
      // pid gives EPERM and is NOT dead). A heartbeat gap never deletes a peer: a live but
      // briefly stalled session (machine sleep, load spike, a wedged event loop) would
      // otherwise lose its queued mail permanently and vanish from listings with no way to
      // re-register. Mail for a genuinely abandoned-but-alive peer ages out via the
      // queued-max-age backstop below, not on a transient gap.
      if (!isPidDead(pidProbe(peer.pid))) continue;
      // Never delete a recipient's rows while one of its messages is mid-delivery:
      // deliverNext awaits the tmux spawn, and deleting the 'delivering' row out from
      // under it would corrupt the lease and could drop a message the pane already
      // received. Defer this peer to the next sweep, after the attempt finishes.
      if (recipientsInFlight.has(peer.id)) continue;
      deleteUndeliveredForPeer.run(peer.id);
      deletePeer.run(peer.id);
    }
    pruneRemotePeers(db, REMOTE_TTL_MS);
    const pruned = pruneMessages(db, { deliveredTtlMs: DELIVERED_TTL_MS, queuedMaxAgeMs: QUEUED_MAX_AGE_MS, nowMs: Date.now() });
    if (pruned.queuedPruned > 0) console.error(`[claude-peers broker] dropped ${pruned.queuedPruned} over-age queued message(s) (lossy backstop)`);
  }
  cleanStalePeers();

  // --- Delivery context ---
  const LEASE_MS = 5_000;        // > the 2s tmux attempt timeout
  const TMUX_TIMEOUT_MS = 2_000;
  const MAX_HEARTBEAT_DRAIN = 50; // upper bound on pushes drained per heartbeat
  // Deliveries currently being attempted. Read by the retire-drain (Task 9) and the
  // empty-broker self-exit (Task 14) so the broker never exits mid-delivery.
  let inFlightDeliveries = 0;
  let retiring = false;
  let httpServer: ReturnType<typeof Bun.serve> | null = null;

  // Idle self-exit config (see maybeIdleExit). 0 / absent / non-numeric = disabled, so a
  // systemd-supervised broker (Restart=always) never self-exits into a restart loop; the
  // server.ts auto-launcher opts in with a positive value so an unmanaged broker reaps
  // itself instead of leaking a process. lastActivityAt is bumped on every POST (real peer
  // and control traffic); /health probes deliberately do not count, so a liveness poll
  // cannot keep an otherwise-idle broker alive.
  const IDLE_EXIT_MS = (() => {
    const v = parseInt(process.env.CLAUDE_PEERS_IDLE_EXIT_MS ?? "0", 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  })();
  let lastActivityAt = Date.now();

  async function retire(): Promise<void> {
    if (retiring) return;            // idempotent: a second /retire (or signal) is a no-op
    retiring = true;                 // new register/send/forward/heartbeat now refused
    // Yield to the I/O event loop (a macrotask boundary) so Bun can flush the /retire
    // response before we stop the server. A microtask yield (Promise.resolve) would not
    // suffice — TCP writes only flush between macrotasks, not between microtasks.
    await new Promise((r) => setTimeout(r, 50));
    const deadline = Date.now() + 3_000;
    while (inFlightDeliveries > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    clearInterval(gossipTimer);
    clearInterval(cleanupTimer);
    if (idleTimer) clearInterval(idleTimer);
    try { await gossipToSiblings([]); } catch {}
    httpServer?.stop(true);
    db.close();
    process.exit(0);
  }
  let tmuxPresent: boolean | null = null;
  function tmuxAvailable(): boolean {
    if (tmuxPresent === null) {
      try { tmuxPresent = Bun.spawnSync(["tmux", "-V"]).exitCode === 0; }
      catch { tmuxPresent = false; }
    }
    return tmuxPresent;
  }

  const realTmuxSpawn: TmuxSpawn = async (args) => {
    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, TMUX_TIMEOUT_MS);
    try { const exitCode = await proc.exited; return { exitCode }; }
    finally { clearTimeout(timer); }
  };

  function peerDelivery(toId: string): { kind: string; pane: string | null; socket: string | null } | null {
    return db.query("SELECT delivery_kind AS kind, tmux_pane AS pane, tmux_socket AS socket FROM peers WHERE id = ?")
      .get(toId) as { kind: string; pane: string | null; socket: string | null } | null;
  }

  // Attempt to deliver the recipient's head-of-line row. Serial per recipient.
  // Returns the delivery disposition for an immediately-attempted send, or null
  // when nothing was attempted (blocked / no backend / already in flight).
  async function deliverNext(toId: string): Promise<"accepted" | "queued" | null> {
    if (recipientsInFlight.has(toId)) return null;
    const now = Date.now();
    const row = nextDeliverable(db, toId, now, activeRowIds);
    if (!row) return null;
    const target = peerDelivery(toId);
    if (!target || target.kind !== "tmux" || !target.pane || !tmuxAvailable()) return "queued";

    if (row.delivery_state === "delivering") {
      if (!reclaimIfExpired(db, row.id, now)) return null; // someone else owns it
    }
    const token = generateLeaseToken();
    if (!claimForDelivery(db, row.id, now, LEASE_MS, token)) return null;

    recipientsInFlight.add(toId);
    activeRowIds.add(row.id);
    inFlightDeliveries++;
    try {
      const text = formatPeerMessage(row);
      const ok = await deliverViaTmux(target.pane, target.socket, text, realTmuxSpawn);
      if (ok && confirmDelivered(db, row.id, token)) return "accepted";
      releaseToQueued(db, row.id, token);
      return "queued";
    } catch {
      releaseToQueued(db, row.id, token);
      return "queued";
    } finally {
      activeRowIds.delete(row.id);
      recipientsInFlight.delete(toId);
      inFlightDeliveries--;
    }
  }

  // After a successful inject, clear any backlog that a concurrent send deferred. While
  // deliverNext awaits the tmux spawn, a second send to the same recipient hits the
  // serial-per-recipient guard and is left queued; without this it would wait for the next
  // heartbeat (seconds) to drain. Bounded by the same cap as the heartbeat drain.
  async function drainAfterDelivery(toId: string): Promise<void> {
    for (let n = 0; n < MAX_HEARTBEAT_DRAIN && (await deliverNext(toId)) === "accepted"; n++) {}
  }

  // --- Request handlers ---
  function handleRegister(body: RegisterRequest): RegisterResponse {
    const id = generatePeerId(config.id_prefix);
    const now = new Date().toISOString();
    const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
    if (existing) { deleteUndeliveredForPeer.run(existing.id); deletePeer.run(existing.id); }
    const pane = body.tmux_pane && /^%\d+$/.test(body.tmux_pane) ? body.tmux_pane : null;
    const socket = body.tmux_socket && body.tmux_socket.startsWith("/") ? body.tmux_socket : null;
    const kind = pane ? "tmux" : "none";
    insertPeer.run(id, body.pid, config.machine, config.tailscale_ip,
      body.cwd, body.git_root, body.tty, body.summary, now, now, pane, socket, kind);
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
      .filter(p => !isPidDead(pidProbe(p.pid)))
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

  async function handleSendMessage(body: SendMessageRequest): Promise<SendResult> {
    const localTarget = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id);
    if (localTarget) {
      insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
      const disposition = (await deliverNext(body.to_id)) ?? "queued";
      if (disposition === "accepted") await drainAfterDelivery(body.to_id);
      return { ok: true, routed: "local", delivery: disposition };
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

  async function handleForwardMessage(body: ForwardMessageRequest): Promise<{ ok: boolean }> {
    if (body.protocol_version !== PROTOCOL_VERSION) {
      console.error(`[claude-peers broker] Warning: received protocol_version ${body.protocol_version}, expected ${PROTOCOL_VERSION}`);
    }
    const localTarget = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id);
    if (!localTarget) {
      console.error(`[claude-peers broker] Dropping forwarded message: unknown local peer ${body.to_id}`);
      return { ok: false };
    }
    insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
    // floor_remote_forwards leaves a forwarded message queued for pull-only retrieval;
    // by default a forward auto-injects into the recipient's backend like a local send.
    if (!config.floor_remote_forwards && (await deliverNext(body.to_id)) === "accepted") {
      await drainAfterDelivery(body.to_id);
    }
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
    const messages = selectQueued.all(body.id) as Message[];
    for (const msg of messages) markPolled.run(msg.id);
    return { messages };
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

  // --- Idle self-exit (opt-in; see IDLE_EXIT_MS) ---
  // Exits only when there are zero live peers, zero in-flight deliveries, and the idle
  // window has elapsed since the last POST. Disabled (idleTimer null) when IDLE_EXIT_MS<=0.
  // Runs on its own timer rather than piggybacking the 15s peer sweep so a short window is
  // observable and reaping is timely; the cadence is clamped so production (a multi-minute
  // window) checks coarsely while a sub-second test window checks promptly.
  function maybeIdleExit(): void {
    if (IDLE_EXIT_MS <= 0 || retiring) return;
    if (inFlightDeliveries > 0) return;
    if ((selectAllPeers.all() as unknown[]).length > 0) return;
    if (Date.now() - lastActivityAt <= IDLE_EXIT_MS) return;
    console.error("[claude-peers broker] idle with no peers; exiting");
    clearInterval(gossipTimer);
    clearInterval(cleanupTimer);
    if (idleTimer) clearInterval(idleTimer);
    try { httpServer?.stop(true); } catch {}
    db.close();
    process.exit(0);
  }
  const idleTimer = IDLE_EXIT_MS > 0
    ? setInterval(maybeIdleExit, Math.max(1_000, Math.min(IDLE_EXIT_MS, CLEANUP_INTERVAL_MS)))
    : null;

  // --- Graceful shutdown ---
  // SIGINT/SIGTERM share the retire path: it drains in-flight deliveries (up to 3s) before
  // closing the DB, so a tmux send-keys that is mid-spawn at signal time finishes and resolves
  // its lease instead of being stranded in 'delivering'. A plain close mid-spawn would leave a
  // row that only a future broker's resetDeliveringOnStart could requeue — and an unmanaged,
  // idle-exiting broker may never restart, so the message would be invisible to check_messages
  // indefinitely. retire() is idempotent, so a double signal (or a /retire already in flight)
  // is a no-op.
  process.on("SIGINT", () => { void retire(); });
  process.on("SIGTERM", () => { void retire(); });

  // --- HTTP Server ---
  httpServer = Bun.serve({
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
            protocol_version: PROTOCOL_VERSION,
          });
        }
        return new Response("claude-peers broker (federated)", { status: 200 });
      }

      // Control plane is loopback-only; the federation allowlist authorizes only /gossip and
      // /forward-message. Every other POST drives a local session (registers delivery targets,
      // injects into a tmux pane via deliverNext, drains a queue, retires the broker), so a
      // remote allowlisted sibling must not reach it directly — it reaches local peers only
      // through /forward-message, which this broker originates after resolving the target.
      // Gate before parsing the body and before bumping the idle window: an unauthorized
      // request is neither trusted input nor real traffic.
      if (!isFederationRoute(path) && !isLoopback(clientIp)) {
        console.error(`[claude-peers broker] rejected non-loopback control-plane ${path} from ${clientIp}`);
        return Response.json({ error: "forbidden" }, { status: 403 });
      }

      try {
        const body = await req.json();
        lastActivityAt = Date.now(); // any POST is real traffic; refreshes the idle window
        // While retiring, refuse every path that creates new persistent work or can
        // start a delivery — /heartbeat drives deliverNext, so it must be refused too,
        // or a heartbeat at a drain-loop yield could start a send the broker then exits under.
        if (retiring && (path === "/register" || path === "/send-message" || path === "/forward-message" || path === "/heartbeat")) {
          return Response.json({ ok: false, error: "broker retiring" }, { status: 503 });
        }
        switch (path) {
          case "/register":
            // Loopback-only (gated above), so the pane/socket coordinates are trusted here.
            return Response.json(handleRegister(body));
          case "/heartbeat": {
            updateLastSeen.run(new Date().toISOString(), body.id);
            // Drain this recipient's queued backlog in id order (serial per recipient),
            // continuing only while each attempt delivers. A non-delivery (no backend,
            // or a failed/blocked head-of-line) stops the drain: under FIFO nothing
            // behind a blocked head can go first, and stopping avoids re-spawning
            // against a failing pane on every iteration.
            let drained = 0;
            for (; drained < MAX_HEARTBEAT_DRAIN; drained++) {
              const d = await deliverNext(body.id);
              if (d !== "accepted") break; // only a successful inject continues the drain
            }
            if (drained === MAX_HEARTBEAT_DRAIN) {
              console.error(`[claude-peers broker] heartbeat drain hit the ${MAX_HEARTBEAT_DRAIN}-message cap for ${body.id}; backlog continues next heartbeat`);
            }
            return Response.json({ ok: true });
          }
          case "/set-summary":
            updateSummary.run(body.summary, body.id);
            return Response.json({ ok: true });
          case "/list-peers": return Response.json(handleListPeers(body));
          case "/send-message": return Response.json(await handleSendMessage(body));
          case "/poll-messages": return Response.json(handlePollMessages(body));
          case "/unregister":
            // A delivery in flight to this peer holds an active lease on its 'delivering' row;
            // deleting that row here would pull it out from under the lease, corrupting the
            // state machine and risking a dropped message the pane already received. Skip the
            // message sweep while mid-delivery (cleanStalePeers uses the same guard) — the
            // in-flight attempt resolves its own row, and any other queued rows for this
            // now-departed peer age out via retention prune. The peer row goes either way, so
            // the session disappears from listings immediately on a graceful exit.
            if (!recipientsInFlight.has(body.id)) deleteUndeliveredForPeer.run(body.id);
            deletePeer.run(body.id);
            return Response.json({ ok: true });
          case "/gossip": return Response.json(handleGossip(body));
          case "/forward-message": return Response.json(await handleForwardMessage(body));
          case "/retire": {
            // Loopback-gated above with the rest of the control plane: only a local caller may
            // retire the broker, so a remote allowlisted sibling cannot DoS the sessions it serves.
            void retire();
            return Response.json({ ok: true });
          }
          default: return Response.json({ error: "not found" }, { status: 404 });
        }
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    },
  });

  console.error(`[claude-peers broker] listening on 0.0.0.0:${PORT} (machine: ${config.machine}, db: ${DB_PATH})`);
}
