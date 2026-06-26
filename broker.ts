#!/usr/bin/env bun
/**
 * claude-peers broker daemon (federated)
 *
 * A singleton HTTP server backed by SQLite.
 * Tracks local peers, syncs with sibling brokers via gossip,
 * and routes messages between local and remote peers.
 */

import { Database } from "bun:sqlite";
import {
  claimForDelivery, confirmDelivered, DEFAULT_DEFERRAL_ESCALATION_CAP,
  decideDeferralEscalation, deliverViaTmux, ensureMessagesTable,
  formatPeerMessage, generateAuthToken, generateLeaseToken, hasDuePush,
  isFederationRoute, isLoopback, isMessageDelivered, isPidDead,
  migrateMessagesSchema, nextDeliverable, pidProbe, promoteQueuedForFlush,
  pruneMessages, pushAfterFor, reclaimIfExpired, reclaimLeaklessDelivering,
  releasableQueuedPrefix, releaseToQueued, resetDeliveringOnStart, type TmuxQuery, type TmuxSpawn,
} from "./delivery.ts";
import { loadConfig, type SiblingConfig } from "./shared/config.ts";
import type {
  ControlPlaneRequest, ForwardMessageRequest, ForwardMessageResponse,
  GossipRequest, ListPeersRequest, Message, Peer,
  PollMessagesRequest, PollMessagesResponse,
  RegisterRequest, RegisterResponse, SendMessageRequest, SendResult,
} from "./shared/types.ts";
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
  let id = `${prefix}-`;
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
  // Match case-insensitively: the sibling config and the remote's gossiped machine
  // name come from independently-edited config files, so casing can drift (e.g. a
  // sibling configured "node-d" vs a broker that broadcasts "NODE-D"). A case-sensitive
  // compare here silently drops delivery as "Peer not found" while the peer still
  // shows in list_peers. See issue #17.
  const target = remote.machine.toLowerCase();
  const sibling = siblings.find(s => s.machine.toLowerCase() === target);
  return sibling?.url ?? null;
}

// Project a peer down to the fields that may cross a machine boundary. The local-only delivery
// coordinates (tmux_pane, tmux_socket, delivery_kind) must never leave this host (see
// shared/types.ts). The federated fields are listed explicitly so a future local-only column is
// excluded by default instead of silently riding along in a gossip payload to every sibling.
export function toGossipPeer(p: Peer): Peer {
  return {
    id: p.id, pid: p.pid, machine: p.machine, tailscale_ip: p.tailscale_ip,
    cwd: p.cwd, git_root: p.git_root, tty: p.tty, summary: p.summary,
    registered_at: p.registered_at, last_seen: p.last_seen,
  };
}

// Strip the secret capability token before a peer crosses the /list-peers boundary. That route is
// token-exempt (read-only browsing), so serializing the token column `SELECT *` reads off the row
// would hand any loopback caller every peer's credential — enough to impersonate it on the gated
// routes. The local-only tmux coordinates a lister saw before stay (they are loopback data; gossip
// strips them via its own allow-list projection, toGossipPeer). token is not on the Peer type, so
// the cast names the runtime-only column the destructure removes.
export function stripToken(p: Peer): Peer {
  const { token: _token, ...rest } = p as Peer & { token?: string | null };
  return rest;
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
    tmux_pane TEXT, tmux_socket TEXT, delivery_kind TEXT NOT NULL DEFAULT 'none', token TEXT
  )`);
  // Upgrade a legacy peers table that predates the delivery columns (and the auth token).
  // A NULL token is a pre-v3 row: it can never match a presented token, so it authenticates
  // only under CLAUDE_PEERS_ALLOW_UNSIGNED until the session re-registers and is minted one.
  for (const [col, type] of [["tmux_pane","TEXT"],["tmux_socket","TEXT"],["delivery_kind","TEXT NOT NULL DEFAULT 'none'"],["token","TEXT"]] as const) {
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
    INSERT INTO peers (id, pid, machine, tailscale_ip, cwd, git_root, tty, summary, registered_at, last_seen, tmux_pane, tmux_socket, delivery_kind, token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tokenForPeer = db.prepare("SELECT token FROM peers WHERE id = ?");
  const updateLastSeen = db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?");
  const updateSummary = db.prepare("UPDATE peers SET summary = ? WHERE id = ?");
  const deletePeer = db.prepare("DELETE FROM peers WHERE id = ?");
  const selectAllPeers = db.prepare("SELECT * FROM peers");
  const selectPeersByDirectory = db.prepare("SELECT * FROM peers WHERE cwd = ?");
  const selectPeersByGitRoot = db.prepare("SELECT * FROM peers WHERE git_root = ?");
  const selectAllRemotePeers = db.prepare("SELECT * FROM remote_peers");
  const insertMessage = db.prepare(
    "INSERT INTO messages (from_id, to_id, text, sent_at, urgency, push_after) VALUES (?, ?, ?, ?, ?, ?)"
  );
  // Poll reads pending (queued OR delivering) in id order so it can stop at an in-flight head
  // and never release a younger message ahead of an older one a tmux send still owns.
  const selectPendingForPoll = db.prepare(
    "SELECT * FROM messages WHERE to_id = ? AND delivery_state IN ('queued','delivering') ORDER BY id ASC"
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
  // Consecutive not-ready deferrals per recipient, for the stuck-pane escalation (issue #42).
  // A readiness-deferred attempt increments the recipient's streak; it resets on any delivered
  // (or otherwise-not-deferred) tmux attempt, on a poll (handlePollMessages — the recipient is
  // alive and draining mail through the floor), and on peer removal (deletePeerAndMail), so the
  // map only ever holds peers currently wedged on a shell pane. deliverNext is serial per
  // recipient, so a streak is only touched by one in-flight attempt at a time.
  const deferralStreaks = new Map<string, number>();
  // delivery's lease must resolve first (see removePeerOrDefer); deliverNext's finally
  // drains this set the instant the lease frees.
  const pendingPeerDeletes = new Set<string>();

  // Delete a peer's row and all its undelivered mail. A peer id is ephemeral (a fresh
  // generatePeerId per session, never reused), so once the session is gone (unregister)
  // or replaced (same-pid re-register) its undelivered mail is addressed to an id nothing
  // will ever poll — removing it is the documented model, not message loss.
  function deletePeerAndMail(id: string): void {
    deleteUndeliveredForPeer.run(id);
    deletePeer.run(id);
    deferralStreaks.delete(id);
  }

  // Remove a peer now, or defer until its in-flight delivery's lease resolves. Deleting the
  // peer row mid-delivery strands the attempt: peerStillLive() would fail against the missing
  // row, releaseToQueued would requeue under a deleted id, and nothing could drain that row
  // before the 24h prune. Both teardown paths (graceful /unregister and same-pid re-register)
  // route through here so the active-lease invariant is total. cleanStalePeers is a backstop
  // for the dead-pid case; the deferred delete itself is drained by deliverNext's finally.
  function removePeerOrDefer(id: string): void {
    if (recipientsInFlight.has(id)) pendingPeerDeletes.add(id);
    else deletePeerAndMail(id);
  }

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
      deletePeerAndMail(peer.id);   // same two deletes, plus the deferralStreaks cleanup
    }
    pruneRemotePeers(db, REMOTE_TTL_MS);
    const pruned = pruneMessages(db, { deliveredTtlMs: DELIVERED_TTL_MS, queuedMaxAgeMs: QUEUED_MAX_AGE_MS, nowMs: Date.now() });
    if (pruned.queuedPruned > 0) console.error(`[claude-peers broker] dropped ${pruned.queuedPruned} over-age queued message(s) (lossy backstop)`);
    // Issue #10: a delivering row with no lease has no live claim and jams its recipient's
    // head-of-line. The delivery path only reclaims it for a live tmux recipient — deliverNext
    // returns "queued" at its backend gate before reaching reclaimIfExpired, and a poll stops at
    // the delivering head — so for a pull-only recipient the orphan would sit until a restart.
    // Reclaim it here (the sweep has no backend gate) and log loudly. A NULL-lease delivering row
    // has no live attempt (claimForDelivery sets state and lease atomically), so this is always
    // safe; it never throws, since a throw in the sweep would itself wedge delivery.
    const reclaimed = reclaimLeaklessDelivering(db);
    if (reclaimed > 0) console.error(`[claude-peers broker] reclaimed ${reclaimed} leaseless delivering row(s) to queued (issue #10 orphan)`);
  }
  cleanStalePeers();

  // --- Delivery context ---
  const LEASE_MS = 5_000;        // > the 2s tmux attempt timeout
  const TMUX_TIMEOUT_MS = 2_000;
  const FORWARD_TIMEOUT_MS = 5_000; // abort bound on an outbound cross-machine forward fetch
  const MAX_HEARTBEAT_DRAIN = 50; // upper bound on pushes drained per heartbeat
  const DEFERRAL_ESCALATION_CAP = DEFAULT_DEFERRAL_ESCALATION_CAP; // not-ready deferrals before a stuck pane escalates (#42)
  // Deliveries currently being attempted. Read by the retire-drain (Task 9) and the
  // empty-broker self-exit (Task 14) so the broker never exits mid-delivery.
  let inFlightDeliveries = 0;
  // Outbound cross-machine /forward-message sends in progress. A forward is delivery work
  // the same way a tmux inject is, so the shutdown predicate must count it too — otherwise
  // retire / idle self-exit would stop the server and exit while handleSendMessage is still
  // awaiting the forward fetch, dropping the message before it reaches the sibling. The retire
  // drain deadline covers the full FORWARD_TIMEOUT_MS so a slow-but-successful forward (a busy
  // sibling, a laggy link) is not cut off at the deadline while it would still have landed; a
  // forward that never completes is bounded by its own abort and frees the counter then.
  let inFlightForwards = 0;
  function hasWorkInFlight(): boolean {
    return inFlightDeliveries > 0 || inFlightForwards > 0;
  }
  let retiring = false;
  let httpServer: ReturnType<typeof Bun.serve> | null = null;

  // Idle self-exit config (see maybeIdleExit). 0 / absent / non-numeric = disabled, so a
  // systemd-supervised broker (Restart=always) never self-exits into a restart loop; the
  // server.ts auto-launcher opts in with a positive value so an unmanaged broker reaps
  // itself instead of leaking a process. lastActivityAt is bumped only on local control-plane
  // POSTs; /health probes (a GET) and sibling federation traffic (/gossip, /forward-message)
  // deliberately do not count, so neither a liveness poll nor a chatty sibling can keep an
  // otherwise locally-idle broker alive.
  const IDLE_EXIT_MS = (() => {
    const v = parseInt(process.env.CLAUDE_PEERS_IDLE_EXIT_MS ?? "0", 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  })();
  // Grace flag for the v2->v3 upgrade window: when set, the broker accepts an *unsigned*
  // (missing-token) mutating request and treats the principal as legacy-unsigned, so live
  // sessions on an old server keep working while they re-register on v3. A *wrong* token
  // still 401s under the flag — grace forgives only the absence of proof, never a forgery.
  const ALLOW_UNSIGNED = process.env.CLAUDE_PEERS_ALLOW_UNSIGNED === "1";
  let lastActivityAt = Date.now();

  async function retire(): Promise<void> {
    if (retiring) return;            // idempotent: a second /retire (or signal) is a no-op
    retiring = true;                 // new register/send/forward/heartbeat now refused
    // Yield to the I/O event loop (a macrotask boundary) so Bun can flush the /retire
    // response before we stop the server. A microtask yield (Promise.resolve) would not
    // suffice — TCP writes only flush between macrotasks, not between microtasks.
    await new Promise((r) => setTimeout(r, 50));
    // Wait out the longest in-flight attempt before tearing down: a tmux send (2s) or a
    // cross-machine forward (FORWARD_TIMEOUT_MS, the larger), plus a small margin for the
    // attempt to settle and the next poll to observe the drained counter. The loop still
    // exits early the moment hasWorkInFlight() clears, so a quiet broker retires at once.
    const deadline = Date.now() + FORWARD_TIMEOUT_MS + 1_000;
    while (hasWorkInFlight() && Date.now() < deadline) {
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

  // Same shape as realTmuxSpawn but pipes stdout so a readiness probe can read the pane's
  // foreground command. Used only for the pre-send pane check (display-message), never for
  // the inject itself. Subject to the same kill-timer so a hung probe cannot block delivery.
  const realTmuxQuery: TmuxQuery = async (args) => {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, TMUX_TIMEOUT_MS);
    try {
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { exitCode, stdout };
    } finally { clearTimeout(timer); }
  };

  function peerDelivery(toId: string): { kind: string; pane: string | null; socket: string | null } | null {
    return db.query("SELECT delivery_kind AS kind, tmux_pane AS pane, tmux_socket AS socket FROM peers WHERE id = ?")
      .get(toId) as { kind: string; pane: string | null; socket: string | null } | null;
  }

  // True only if the recipient is still registered and its pid still probes alive. Used to
  // re-verify liveness after the tmux send (the lease was claimed before the await), since a
  // 0 exit from send-keys does not prove a live peer consumed the text.
  function peerStillLive(toId: string): boolean {
    const p = db.query("SELECT pid FROM peers WHERE id = ?").get(toId) as { pid: number } | null;
    return p !== null && !isPidDead(pidProbe(p.pid));
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
    if (target?.kind !== "tmux" || !target.pane || !tmuxAvailable()) return "queued";
    // The urgency gate: interrupt the recipient only when some pending row is push-due
    // (an interrupt send, or a normal row whose push_delay window has lapsed). Until
    // then everything stays queued for their next check_messages — the cheap path.
    // Once one row is due, the turn is being paid anyway, so promote the rest of the
    // pushable backlog to ride the same flush instead of buying its own interruption.
    if (!hasDuePush(db, toId, now)) return "queued";
    promoteQueuedForFlush(db, toId, now);

    if (row.delivery_state === "delivering") {
      if (!reclaimIfExpired(db, row.id, now)) return null; // someone else owns it
    }
    const token = generateLeaseToken();
    if (!claimForDelivery(db, row.id, now, LEASE_MS, token)) return null;

    recipientsInFlight.add(toId);
    activeRowIds.add(row.id);
    inFlightDeliveries++;
    let deferredThisAttempt = false;
    try {
      const text = formatPeerMessage(row);
      // The query arg enables a pre-send readiness probe: if the pane's foreground process is
      // a bare shell rather than a live Claude session, deliverViaTmux skips the inject and
      // returns false, so the row stays queued instead of pasting into a shell. This catches
      // the outlived-pane case below before the text lands; the post-send liveness re-probe
      // still guards the narrower race where the peer dies during the await. onDefer fires on
      // exactly that not-ready skip: count it toward this recipient's streak and, once the run
      // of consecutive deferrals reaches the cap, escalate a pane that is stuck a shell louder
      // than the per-attempt defer log (#42) — a permanently shelled pid is invisible to the
      // dead-pid sweep, so its mail would otherwise stall in silence.
      const ok = await deliverViaTmux(target.pane, target.socket, text, realTmuxSpawn, realTmuxQuery,
        (reason) => {
          deferredThisAttempt = true;
          const streak = (deferralStreaks.get(toId) ?? 0) + 1;
          deferralStreaks.set(toId, streak);
          if (decideDeferralEscalation(streak, DEFERRAL_ESCALATION_CAP).escalate) {
            console.error(`[claude-peers broker] escalation: pane ${target.pane} (peer ${toId}) deferred ${streak}x in a row (${reason}); no live Claude foreground seen, so its peer mail is not being delivered — if the session exited to a shell under a still-live pid the dead-pid sweep will not reap it`);
          }
        });
      // A 0 exit from send-keys is not proof a live peer consumed the text: the recipient can
      // die after the lease is claimed (before or during the await), leaving a pane that
      // outlived the Claude process — now a bare shell — that still accepts keystrokes and exits
      // 0. Re-probe liveness before confirming so a death (or a graceful unregister) mid-send is
      // not masked as a delivery. If the peer is gone, leave the row queued; cleanStalePeers
      // drops it honestly when it reaps the dead pid, and retention prune bounds an orphan.
      if (ok && peerStillLive(toId) && confirmDelivered(db, row.id, token)) {
        deferralStreaks.delete(toId);   // delivered: the pane is healthy, clear any streak
        return "accepted";
      }
      // Any non-deferred miss (send failed, peer died mid-send) also breaks the not-ready run:
      // only an unbroken streak of shell deferrals should accrue toward the stuck-pane escalation.
      if (!deferredThisAttempt) deferralStreaks.delete(toId);
      releaseToQueued(db, row.id, token);
      return "queued";
    } catch {
      deferralStreaks.delete(toId);   // a spawn fault is not a readiness deferral
      releaseToQueued(db, row.id, token);
      return "queued";
    } finally {
      activeRowIds.delete(row.id);
      recipientsInFlight.delete(toId);
      inFlightDeliveries--;
      // The lease has resolved (confirmed or requeued above). If a teardown deferred this
      // peer's removal while we held the lease, do it now — synchronously, so no concurrent
      // handler can observe the peer between the lease freeing and the delete.
      if (pendingPeerDeletes.has(toId)) {
        pendingPeerDeletes.delete(toId);
        deletePeerAndMail(toId);
      }
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
    // A same-pid re-register supersedes the old peer row. Remove it — but defer while a
    // delivery to the old id is in flight, or deleting the row now would orphan that
    // attempt's message under a dead id (the same race the /unregister path guards; both
    // route through removePeerOrDefer). The new peer row is inserted below regardless. The
    // old id's mail is dropped, not carried over — the new session polls under its own id.
    if (existing) removePeerOrDefer(existing.id);
    const pane = body.tmux_pane && /^%\d+$/.test(body.tmux_pane) ? body.tmux_pane : null;
    const socket = body.tmux_socket?.startsWith("/") ? body.tmux_socket : null;
    const kind = pane ? "tmux" : "none";
    // Mint a per-session capability token. The peer presents it on every mutating
    // control-plane call; the gate binds the call's principal (from_id/id) to it.
    const token = generateAuthToken();
    insertPeer.run(id, body.pid, config.machine, config.tailscale_ip,
      body.cwd, body.git_root, body.tty, body.summary, now, now, pane, socket, kind, token);
    return { id, token };
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
      // A peer pending deferred deletion is logically gone: its row lingers only so an in-flight
      // lease can settle. Don't advertise it, or a peer would address a superseded/departing id.
      .filter(p => !pendingPeerDeletes.has(p.id))
      // stripToken: never serialize the capability token into this token-exempt route.
      .map(p => ({ ...stripToken(p), is_remote: false }));

    let allPeers: Peer[];
    if (body.scope === "machine") {
      const remotePeers = (selectAllRemotePeers.all() as Peer[]).map(p => ({ ...stripToken(p), is_remote: true }));
      allPeers = [...localPeers, ...remotePeers];
    } else {
      allPeers = localPeers;
    }
    if (body.exclude_id) allPeers = allPeers.filter(p => p.id !== body.exclude_id);
    return allPeers;
  }

  async function handleSendMessage(body: SendMessageRequest): Promise<SendResult> {
    const localTarget = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id);
    // Accept the local route only for a row whose process is still alive AND not pending deferred
    // deletion. A peer's row outlives its process between cleanup sweeps (deletion is decoupled
    // from listing), and a peer pending deferred deletion (pendingPeerDeletes — superseded by a
    // same-pid re-register, or mid-unregister) shares the live pid yet is logically gone. Queuing
    // under either is a false positive: no valid session polls it, and the deferred delete or next
    // sweep wipes it. Treat both as absent so the caller gets an honest result (a sibling, or "not
    // found") instead of an ok that silently drops the message.
    const urgency = body.urgency ?? "interrupt"; // absent = pre-urgency client, keep its old push-on-send
    if (localTarget && peerStillLive(body.to_id) && !pendingPeerDeletes.has(body.to_id)) {
      const inserted = insertMessage.run(
        body.from_id, body.to_id, body.text, new Date().toISOString(),
        urgency, pushAfterFor(urgency, Date.now(), config.push_delay_ms),
      );
      const ownRowId = Number(inserted.lastInsertRowid);
      if ((await deliverNext(body.to_id)) === "accepted") await drainAfterDelivery(body.to_id);
      // Report THIS message's own disposition, not the queue head's (the local edition of
      // issue #14): deliverNext works head-first, so the row just inserted may have ridden
      // out behind older backlog, still be queued (normal/fyi), or had its own push fail
      // after the head's succeeded.
      return { ok: true, routed: "local", delivery: isMessageDelivered(db, ownRowId) ? "accepted" : "queued" };
    }
    const siblingUrl = resolveTargetBroker(db, body.to_id, config.siblings);
    if (!siblingUrl) return { ok: false, error: `Peer ${body.to_id} not found` };
    // Mark the forward in flight so a concurrent retire / idle self-exit drains it before
    // exiting (see hasWorkInFlight); the finally clears it whether the fetch resolves, rejects,
    // or aborts.
    inFlightForwards++;
    try {
      const res = await fetch(`${siblingUrl}/forward-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: PROTOCOL_VERSION, from_id: body.from_id,
          to_id: body.to_id, text: body.text, from_machine: config.machine,
          urgency,
        } satisfies ForwardMessageRequest),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, error: `Remote broker error: ${res.status}` };
      const result = await res.json() as ForwardMessageResponse;
      if (!result.ok) return { ok: false, error: "Remote broker rejected message (target peer not found)" };
      return { ok: true, routed: "remote", delivery: result.delivery ?? "queued" };
    } catch {
      return { ok: false, error: "Remote broker unreachable" };
    } finally {
      inFlightForwards--;
    }
  }

  async function handleForwardMessage(body: ForwardMessageRequest): Promise<ForwardMessageResponse> {
    if (body.protocol_version !== PROTOCOL_VERSION) {
      console.error(`[claude-peers broker] Warning: received protocol_version ${body.protocol_version}, expected ${PROTOCOL_VERSION}`);
    }
    const localTarget = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id);
    // Same gate as the local send route: a stale row for a dead process, or a peer pending
    // deferred deletion (pendingPeerDeletes — logically gone, row kept only for its in-flight
    // lease), is not a valid recipient. Accepting the forward would queue a message the deferred
    // delete or next sweep deletes and hand the originating broker a false ok, so reject it and
    // let the sender learn the peer is gone.
    if (!localTarget || !peerStillLive(body.to_id) || pendingPeerDeletes.has(body.to_id)) {
      console.error(`[claude-peers broker] Dropping forwarded message: no live local peer ${body.to_id}`);
      return { ok: false };
    }
    // A floored forward is poll-only: push_after NULL keeps it out of the push channel
    // entirely, so neither the heartbeat drain nor a flush can auto-paste remote text
    // into a local pane. (Before push_after, the floor only skipped the immediate
    // inject here and the recipient's next heartbeat pushed the row anyway.)
    const urgency = body.urgency ?? "interrupt"; // absent = pre-urgency sibling broker
    const pushAfter = config.floor_remote_forwards
      ? null
      : pushAfterFor(urgency, Date.now(), config.push_delay_ms);
    const inserted = insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString(), urgency, pushAfter);
    const forwardedRowId = Number(inserted.lastInsertRowid);
    // floor_remote_forwards leaves a forwarded message queued for pull-only retrieval;
    // by default a forward auto-injects into the recipient's backend like a local send.
    // Report the honest per-message disposition so the originating broker can tell the
    // sender whether the message was pushed or left for their next check (issue #14).
    let delivery: "accepted" | "queued" = "queued";
    if (!config.floor_remote_forwards) {
      // deliverNext delivers the recipient's queue HEAD (possibly older backlog, not this
      // forward); drainAfterDelivery then works down the queue. Report THIS message's own
      // fate — it may have ridden out behind the backlog, or still be queued if the drain
      // cap was hit — not the head's disposition.
      if ((await deliverNext(body.to_id)) === "accepted") await drainAfterDelivery(body.to_id);
      delivery = isMessageDelivered(db, forwardedRowId) ? "accepted" : "queued";
    }
    return { ok: true, delivery };
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
    // A poll is proof of life that bypasses the tmux push path: check_messages is an MCP call
    // from a live Claude (a bare shell pane cannot make it), and it drains queued mail through
    // the floor. So a recipient that is polling is demonstrably alive and receiving its mail —
    // the opposite of the stuck-shell-pane case the deferral streak escalates. Clear its streak
    // here so deferrals it accrued before it recovered cannot carry over and trip a false
    // escalation on a later, unrelated shell-out (#42). deliverNext resets on a tmux delivery;
    // this resets on the poll path it never sees.
    deferralStreaks.delete(body.id);
    // Release queued mail in id order, but stop at the first 'delivering' row. That row is
    // older pending mail a tmux send still owns and may requeue on failure; releasing the
    // queued rows behind it would let the caller observe message n+1 before message n, breaking
    // the head-of-line ordering this delivery model guarantees. Only a contiguous queued prefix
    // whose older pending rows are all already delivered is safe to hand out. This handler runs
    // synchronously (no await), so the rows cannot change underneath the loop.
    const pending = selectPendingForPoll.all(body.id) as Message[];
    const messages: Message[] = [];
    for (const msg of releasableQueuedPrefix(pending)) {
      if (markPolled.run(msg.id).changes === 1) messages.push(msg);
    }
    return { messages };
  }

  // --- Gossip loop ---
  const gossipFailureStates = new Map<string, GossipFailureState>();

  async function gossipToSiblings(peerList?: Peer[]) {
    const sourcePeers = peerList ?? (selectAllPeers.all() as Peer[]).filter(p => {
      try { process.kill(p.pid, 0); return true; } catch { return false; }
    });
    // Project every peer through the federated allow-list before it crosses a machine boundary,
    // regardless of whether the caller passed an explicit list or we read the table. This keeps the
    // local-only delivery coordinates (tmux_pane/tmux_socket/delivery_kind) on this host.
    const peers = sourcePeers.map(toGossipPeer);
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
    if (hasWorkInFlight()) return;
    if ((selectAllPeers.all() as unknown[]).length > 0) return;
    if (Date.now() - lastActivityAt <= IDLE_EXIT_MS) return;
    console.error("[claude-peers broker] idle with no peers; exiting");
    // Route through retire() rather than duplicating teardown here: retire() announces an empty
    // peer list to siblings (so they drop this broker's peers instead of carrying them stale until
    // their own sweep), clears the same timers, and is idempotent. maybeIdleExit already bailed on
    // `retiring`, so a re-entrant idle tick during the retire window is a no-op.
    void retire();
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
            status: "ok", peers: (selectAllPeers.all() as unknown[]).length,
            machine: config.machine, remote_peer_count: (selectAllRemotePeers.all() as unknown[]).length,
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
        // Loopback-gated control plane, single trusted client (our MCP server) — see
        // ControlPlaneRequest. The cast restores the per-route field types from `unknown`.
        const body = (await req.json()) as ControlPlaneRequest;
        // Per-session capability auth, before the idle bump (an unauthorized request is neither
        // trusted input nor real traffic, like the loopback gate above). Every mutating control-
        // plane call binds to the session that registered it: the presented Authorization: Bearer
        // token must equal the stored token for the call's principal — from_id for /send-message,
        // which is what blocks forging a sender; id otherwise. Exempt: /register (mints the token),
        // /retire (a broker-lifecycle call from a NEW server that never registered here, so it
        // holds no token), /list-peers (read-only browsing, and it must strip the token column it
        // would otherwise return), and federation routes (cross-machine, IP-gated; the token never
        // crosses a machine boundary). A missing token 401s unless ALLOW_UNSIGNED AND the principal
        // is a genuine pre-v3 NULL-token row (see below); a wrong token always 401s.
        const tokenExempt = path === "/register" || path === "/retire" || path === "/list-peers" || isFederationRoute(path);
        if (!tokenExempt) {
          const principal = path === "/send-message" ? body.from_id : body.id;
          const auth = req.headers.get("authorization") ?? "";
          const presented = auth.startsWith("Bearer ") ? auth.slice(7) : null;
          const row = principal ? (tokenForPeer.get(principal) as { token: string | null } | null) : null;
          const valid = presented !== null && row?.token != null && row.token === presented;
          // The unsigned grace covers exactly one principal: a genuine pre-v3 row whose token is
          // still NULL — a legacy client that registered before tokens existed and cannot present
          // one yet. A principal that already minted a token must ALWAYS present it, or mere header
          // omission would reopen the from_id forgery for the whole upgrade window; an unknown
          // principal (no row) is not a legacy peer either, so it gets no pass.
          const legacyUnsigned = ALLOW_UNSIGNED && presented === null && row != null && row.token == null;
          if (!valid && !legacyUnsigned) {
            return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
          }
        }
        // Refresh the idle window only for local control-plane traffic, not sibling federation
        // (/gossip, /forward-message). Self-exit reaps a broker with no LOCAL work; a federated
        // broker otherwise gets its idle clock reset forever by a sibling's periodic gossip and
        // never reaps itself. (/health is a GET handled above and never reaches here.)
        if (!isFederationRoute(path)) lastActivityAt = Date.now();
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
            // Remove the departing peer and its now-unreachable mail. A peer id is ephemeral
            // (a fresh id per session, never reused), so a graceful exit's undelivered mail is
            // addressed to an id nothing will poll again — deleting it is the documented model,
            // not loss. Routed through removePeerOrDefer so an in-flight delivery resolves
            // against a peer that still exists instead of orphaning its row; list-peers filters
            // dead pids, so the session disappears from listings immediately regardless.
            removePeerOrDefer(body.id);
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
