// delivery.ts
// Pure, testable delivery logic for the claude-peers broker. broker.ts composes
// these; tests import them directly (the broker daemon body is not importable).

import type { Database } from "bun:sqlite";

/**
 * Create the messages table in the M1 target schema if it does not exist. The CHECK
 * enforces the 'delivering' => live-claim invariant (a non-null lease AND a non-null
 * token: a delivering row with no holder can jam the recipient head-of-line) so a raw
 * write can never recreate the issue #10 jam. It is best-effort: it only guards freshly-
 * created tables — SQLite cannot ADD a table CHECK via ALTER, so a migrated legacy table
 * is unprotected. findLeaklessDelivering is the portable runtime probe for the permanent
 * (null-lease) case on those tables.
 */
export function ensureMessagesTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    text TEXT NOT NULL, sent_at TEXT NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'queued',
    lease_expires_at INTEGER, lease_token TEXT,
    CHECK (delivery_state <> 'delivering' OR (lease_expires_at IS NOT NULL AND lease_token IS NOT NULL))
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

/**
 * A per-session capability token. Unlike the lease nonce (which only needs to be
 * unique-ish to name an attempt), this is a credential a peer presents to act as its
 * registered id, so it draws 256 bits from a CSPRNG — unguessable, not just unique.
 */
export function generateAuthToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

/**
 * Reclaim a delivering row whose lease has expired (caller must guard the active set). A
 * NULL lease (a delivering row with no live claim — the issue #10 orphan) is also
 * reclaimable: a delivering row with no lease cannot belong to a live attempt by
 * definition. A future lease (lease_expires_at>now) still fails the predicate and is NOT
 * reclaimed, so a live attempt is left alone.
 */
export function reclaimIfExpired(db: Database, id: number, nowMs: number): boolean {
  const res = db.run(
    "UPDATE messages SET delivery_state='queued', lease_expires_at=NULL, lease_token=NULL WHERE id=? AND delivery_state='delivering' AND (lease_expires_at IS NULL OR lease_expires_at<=?)",
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

/**
 * Whether one specific message row reached the 'delivered' state. Used to report a forward's
 * own disposition rather than the recipient queue head's: deliverNext/drainAfterDelivery work
 * down the queue head-first, so the just-forwarded row may have ridden out behind older
 * backlog or still be queued — its own state is the honest answer (issue #14).
 */
export function isMessageDelivered(db: Database, id: number): boolean {
  const row = db.query("SELECT delivery_state FROM messages WHERE id=?").get(id) as
    | { delivery_state: string }
    | null;
  return row?.delivery_state === "delivered";
}

// The orphan predicate mirrors the create-path CHECK exactly: a 'delivering' row is holderless
// if EITHER lease column is null. Half of it (lease_expires_at only) would miss a future-lease /
// null-token row, which nextDeliverable treats as a live lease and would block until the arbitrary
// timestamp. Migrated legacy tables carry no CHECK (SQLite can't add one via ALTER TABLE ADD
// COLUMN), so this runtime predicate is their only enforcement — it must cover the whole invariant.
const HOLDERLESS_DELIVERING = "delivery_state='delivering' AND (lease_expires_at IS NULL OR lease_token IS NULL)";

/** Invariant: a 'delivering' row always holds a non-null lease AND token. Returns the count that violate it. */
export function findLeaklessDelivering(db: Database): number {
  return (db.query(`SELECT COUNT(*) AS n FROM messages WHERE ${HOLDERLESS_DELIVERING}`).get() as { n: number }).n;
}

/**
 * Reclaim every orphaned (holderless) delivering row back to queued, returning the count reclaimed.
 * The periodic broker sweep calls this. Unlike deliverNext — which returns "queued" at its tmux
 * backend gate before reaching reclaimIfExpired, so it never reclaims for a pull-only recipient —
 * the sweep has no backend gate, so it unjams a stuck head-of-line regardless of how the recipient
 * receives mail. A delivering row missing either lease column cannot belong to a live attempt
 * (claimForDelivery sets state, lease, and token in one atomic UPDATE), so reclaiming it is always safe.
 */
export function reclaimLeaklessDelivering(db: Database): number {
  return db.run(
    `UPDATE messages SET delivery_state='queued', lease_expires_at=NULL, lease_token=NULL WHERE ${HOLDERLESS_DELIVERING}`,
  ).changes;
}

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/**
 * Validate a session's own $TMUX/$TMUX_PANE into a delivery target, or null.
 * The index signature lets `process.env` (a string-keyed map) be passed directly;
 * only TMUX and TMUX_PANE are read.
 */
export function resolveTmuxTarget(
  env: { TMUX?: string | null; TMUX_PANE?: string | null; [key: string]: string | null | undefined },
): { pane: string; socket: string | null } | null {
  const pane = env.TMUX_PANE ?? "";
  if (!/^%\d+$/.test(pane)) return null;
  let socket: string | null = null;
  if (env.TMUX) {
    const candidate = env.TMUX.split(",")[0];
    if (candidate?.startsWith("/")) socket = candidate;
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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately strips C0/C1 control chars (incl. ESC) to neutralize bracketed-paste injection — see comment above.
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

/**
 * The contiguous queued prefix a poll (check_messages) may release. `pending` is the
 * recipient's queued-or-delivering rows in id order. Releasing stops at the first row that is
 * not `queued`: a `delivering` row is older pending mail a tmux send still owns and may requeue
 * on failure, so handing out the queued rows behind it would let the caller observe message n+1
 * before message n. Only rows whose older pending neighbours are all already delivered are safe.
 */
export function releasableQueuedPrefix<T extends { delivery_state: string }>(pending: T[]): T[] {
  const out: T[] = [];
  for (const row of pending) {
    if (row.delivery_state !== "queued") break;
    out.push(row);
  }
  return out;
}

/** True for loopback source addresses (control-plane registration must be local). */
export function isLoopback(ip: string): boolean {
  const n = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return n === "127.0.0.1" || n === "::1";
}

/**
 * The only two routes a remote allowlisted sibling may reach. Every other route is control
 * plane and must be loopback-only: it drives a local session — registers a delivery target,
 * injects into a tmux pane, drains a queue, or retires the broker. The federation allowlist
 * authorizes federation, not authority over local sessions; a remote peer reaches local
 * sessions only through /forward-message, which the broker itself originates after resolving
 * the target. Keep this list tiny and explicit: a new control-plane route is loopback-only by
 * default precisely because it is absent here.
 */
export function isFederationRoute(path: string): boolean {
  return path === "/gossip" || path === "/forward-message";
}

/**
 * Decide deadness from a process-existence probe. The probe throws if the process
 * is gone; only ESRCH (no such process) counts as dead. EPERM/EACCES means
 * alive-but-foreign and must NOT be treated as dead. The probe is injected so a
 * test can throw an error carrying whatever code it wants to exercise.
 */
export function isPidDead(probe: () => void): boolean {
  try { probe(); return false; }
  catch (e) { return (e as NodeJS.ErrnoException | null)?.code === "ESRCH"; }
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
