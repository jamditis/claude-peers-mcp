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

// Strip C0 control characters (except tab and newline) from peer-controlled fields.
// Critically this removes ESC (0x1b), which neutralizes the bracketed-paste END
// sequence: without it, a peer whose text contained the PASTE_END bytes could close
// the paste wrap early and have the trailing bytes land as live keystrokes in the
// recipient's session. Newlines are kept so a multi-line message still pastes as one.
function stripControl(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
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
