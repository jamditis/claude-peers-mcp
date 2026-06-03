// delivery.ts
// Pure, testable delivery logic for the claude-peers broker. broker.ts composes
// these; tests import them directly (the broker daemon body is not importable).

import type { Database } from "bun:sqlite";

/** Create the messages table in the M1 target schema if it does not exist. */
export function ensureMessagesTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    text TEXT NOT NULL, sent_at TEXT NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'queued',
    lease_expires_at INTEGER, lease_token TEXT
  )`);
}

/**
 * Upgrade a legacy messages table (with a `delivered` column) to the delivery_state
 * schema. Gated on PRAGMA table_info so a re-run is a no-op, and wrapped in a single
 * BEGIN IMMEDIATE transaction so a concurrent starter never sees a half-migrated
 * schema. SQLite has no ALTER ... IF NOT EXISTS, hence the explicit column guards.
 * Precondition: the messages table must already exist — call ensureMessagesTable
 * first. On an absent table the first ALTER throws "no such table" (rolled back).
 */
export function migrateMessagesSchema(db: Database): void {
  const names = (db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
  const has = (c: string) => names.includes(c);
  if (!has("delivered") && has("delivery_state")) return; // already migrated

  db.run("BEGIN IMMEDIATE");
  try {
    if (!has("delivery_state")) db.run("ALTER TABLE messages ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'queued'");
    if (!has("lease_expires_at")) db.run("ALTER TABLE messages ADD COLUMN lease_expires_at INTEGER");
    if (!has("lease_token")) db.run("ALTER TABLE messages ADD COLUMN lease_token TEXT");
    if (has("delivered")) {
      db.run("UPDATE messages SET delivery_state = CASE WHEN delivered = 1 THEN 'delivered' ELSE 'queued' END");
      db.run("ALTER TABLE messages DROP COLUMN delivered");
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

const LEASE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A fresh per-attempt nonce that names the attempt owning a row's lease. */
export function generateLeaseToken(): string {
  let t = "";
  for (let i = 0; i < 16; i++) t += LEASE_ALPHABET[Math.floor(Math.random() * LEASE_ALPHABET.length)];
  return t;
}

/** Claim a queued row for one delivery attempt. Returns true iff this caller won it. */
export function claimForDelivery(db: Database, id: number, nowMs: number, leaseMs: number, token: string): boolean {
  const res = db.run(
    "UPDATE messages SET delivery_state='delivering', lease_expires_at=?, lease_token=? WHERE id=? AND delivery_state='queued'",
    [nowMs + leaseMs, token, id],
  );
  return res.changes === 1;
}

/** Mark a row delivered — only for the attempt still holding its lease token. */
export function confirmDelivered(db: Database, id: number, token: string): boolean {
  const res = db.run(
    "UPDATE messages SET delivery_state='delivered', lease_expires_at=NULL, lease_token=NULL WHERE id=? AND delivery_state='delivering' AND lease_token=?",
    [id, token],
  );
  return res.changes === 1;
}

/** Return a row to queued after a failed attempt — only for the lease holder. */
export function releaseToQueued(db: Database, id: number, token: string): void {
  db.run(
    "UPDATE messages SET delivery_state='queued', lease_expires_at=NULL, lease_token=NULL WHERE id=? AND delivery_state='delivering' AND lease_token=?",
    [id, token],
  );
}

/** Reclaim a delivering row whose lease has expired (caller must guard the active set). */
export function reclaimIfExpired(db: Database, id: number, nowMs: number): boolean {
  const res = db.run(
    "UPDATE messages SET delivery_state='queued', lease_expires_at=NULL, lease_token=NULL WHERE id=? AND delivery_state='delivering' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?",
    [id, nowMs],
  );
  return res.changes === 1;
}

/** On broker start the active-attempt set is empty, so every delivering row is orphaned. */
export function resetDeliveringOnStart(db: Database): number {
  const res = db.run(
    "UPDATE messages SET delivery_state='queued', lease_expires_at=NULL, lease_token=NULL WHERE delivery_state='delivering'",
  );
  return res.changes;
}

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** Validate a session's own $TMUX/$TMUX_PANE into a delivery target, or null. */
export function resolveTmuxTarget(
  env: { TMUX?: string | null; TMUX_PANE?: string | null },
): { pane: string; socket: string | null } | null {
  const pane = env.TMUX_PANE ?? "";
  if (!/^%\d+$/.test(pane)) return null;
  let socket: string | null = null;
  if (env.TMUX) {
    const candidate = env.TMUX.split(",")[0];
    if (candidate && candidate.startsWith("/")) socket = candidate;
  }
  return { pane, socket };
}

// Strip C0 AND C1 control characters (except tab and newline) from peer-controlled
// fields. Critically this removes ESC (0x1b), which neutralizes the bracketed-paste
// END sequence: without it, a peer whose text contained the PASTE_END bytes could
// close the paste wrap early and have the trailing bytes land as live keystrokes in
// the recipient's session. The C1 range (0x80-0x9f) is stripped for the same reason:
// 0x9b is the single-byte CSI (equivalent to ESC '['), so an 8-bit-clean terminal
// would read "\x9b201~" as the paste-END sequence just as it reads "\x1b[201~" —
// UTF-8 encoding preserves U+009B end to end, so the ESC-only strip alone is bypassable.
// Newlines are kept so a multi-line message still pastes as one.
function stripControl(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Build the bracketed-paste-wrapped peer line. A single trailing Enter submits it. */
export function formatPeerMessage(msg: { id: number; from_id: string; text: string }): string {
  const from = stripControl(msg.from_id);
  const text = stripControl(msg.text);
  const body = `[peer ${from} #${msg.id}] ${text}  (reply: send_message to_id="${from}")`;
  return `${PASTE_START}${body}${PASTE_END}`;
}

export type TmuxSpawn = (args: string[]) => Promise<{ exitCode: number }>;

/** Build the argv for one tmux process that types the text then presses Enter. */
export function buildTmuxArgs(pane: string, socket: string | null, text: string): string[] {
  const args = ["tmux"];
  if (socket) args.push("-S", socket);
  args.push("send-keys", "-t", pane, "-l", text, ";", "send-keys", "-t", pane, "Enter");
  return args;
}

/** Inject text into a pane via one tmux spawn. Success iff tmux exits 0. */
export async function deliverViaTmux(
  pane: string, socket: string | null, text: string, spawn: TmuxSpawn,
): Promise<boolean> {
  try {
    const { exitCode } = await spawn(buildTmuxArgs(pane, socket, text));
    return exitCode === 0;
  } catch (e) {
    // A non-zero exit is handled above; reaching here means the spawn itself
    // rejected (a bug or environment fault, not a normal failed delivery). The
    // message still stays queued — never silently dropped — but the fault is
    // logged so it does not vanish, unlike the ordinary non-zero-exit miss.
    console.error(`[claude-peers broker] tmux delivery spawn error for pane ${pane}:`, e);
    return false;
  }
}

export interface DeliverableRow {
  id: number; from_id: string; to_id: string; text: string; sent_at: string;
  delivery_state: string; lease_expires_at: number | null; lease_token: string | null;
}

/**
 * The oldest row for `toId` that may be delivered now, or null when the recipient's
 * head-of-line row is an in-flight attempt that must not be jumped. A returned row in
 * `delivering` state is reclaimable (expired + not active) — the caller reclaims it
 * before claiming. `activeIds` is the broker's in-memory set of rows it is attempting.
 */
export function nextDeliverable(
  db: Database, toId: string, nowMs: number, activeIds: Set<number>,
): DeliverableRow | null {
  // Only the head-of-line row matters: a younger message must never overtake an older
  // one, so we fetch the single oldest queued-or-delivering row and decide on it alone.
  // Column list mirrors DeliverableRow exactly — keep them in sync if the schema changes.
  const row = db.query(
    "SELECT id, from_id, to_id, text, sent_at, delivery_state, lease_expires_at, lease_token FROM messages WHERE to_id=? AND delivery_state IN ('queued','delivering') ORDER BY id ASC LIMIT 1",
  ).get(toId) as DeliverableRow | null;
  if (!row) return null;
  if (row.delivery_state === "queued") return row;
  const live = activeIds.has(row.id) || (row.lease_expires_at !== null && row.lease_expires_at > nowMs);
  return live ? null : row;    // a live attempt blocks; expired + not active is reclaimable
}

/** True for loopback source addresses (control-plane registration must be local). */
export function isLoopback(ip: string): boolean {
  const n = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return n === "127.0.0.1" || n === "::1";
}

/**
 * Decide deadness from a process-existence probe. The probe throws if the process
 * is gone; only ESRCH (no such process) counts as dead. EPERM/EACCES means
 * alive-but-foreign and must NOT be treated as dead. The probe is injected so a
 * test can throw an error carrying whatever code it wants to exercise.
 */
export function isPidDead(probe: () => void): boolean {
  try { probe(); return false; }
  catch (e: any) { return e?.code === "ESRCH"; }
}

/** The standard probe: signal 0 to a pid. Throws (ESRCH) if the pid is gone. */
export function pidProbe(pid: number): () => void {
  return () => { process.kill(pid, 0); };
}

/**
 * Bound the messages table: delete delivered rows older than the ttl, and queued
 * rows older than the lossy max-age backstop. Returns counts for logging. The
 * primary bound is the heartbeat-staleness peer sweep (broker side); this is the
 * final backstop.
 */
export function pruneMessages(
  db: Database,
  opts: { deliveredTtlMs: number; queuedMaxAgeMs: number; nowMs: number },
): { deliveredPruned: number; queuedPruned: number } {
  const deliveredCutoff = new Date(opts.nowMs - opts.deliveredTtlMs).toISOString();
  const queuedCutoff = new Date(opts.nowMs - opts.queuedMaxAgeMs).toISOString();
  const d = db.run("DELETE FROM messages WHERE delivery_state='delivered' AND sent_at < ?", [deliveredCutoff]);
  const q = db.run("DELETE FROM messages WHERE delivery_state='queued' AND sent_at < ?", [queuedCutoff]);
  return { deliveredPruned: d.changes, queuedPruned: q.changes };
}
