// delivery.ts
// Pure, testable delivery logic for the claude-peers broker. broker.ts composes
// these; tests import them directly (the broker daemon body is not importable).

import type { Database } from "bun:sqlite";
import type { DeliveryState, Urgency } from "./shared/types.ts";

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
  // push_after: epoch ms when the row becomes push-eligible. DEFAULT 0 (due now) so a
  // write that does not know about urgency keeps the old push-on-sight behavior; an
  // explicit NULL means never auto-push (fyi, floored remote forwards) — poll-only.
  // channel_push_attempts: how many times the best-effort channel tier (#6) has pushed
  // this row. NOT NULL DEFAULT 0 so every row carries a real count; the cap in
  // decideChannelPush reads it, and persisting it in the row (not an in-memory map) keeps
  // the cap honest across a broker restart. Never touched by the acked backends.
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    text TEXT NOT NULL, sent_at TEXT NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'queued',
    lease_expires_at INTEGER, lease_token TEXT,
    urgency TEXT NOT NULL DEFAULT 'interrupt',
    push_after INTEGER DEFAULT 0,
    channel_push_attempts INTEGER NOT NULL DEFAULT 0,
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
  // Include channel_push_attempts in the fast-path guard so a deployment already on the
  // delivery_state schema but predating the #6 column still falls through to add it.
  if (!has("delivered") && has("delivery_state") && has("urgency") && has("push_after") && has("channel_push_attempts")) return; // already migrated

  db.run("BEGIN IMMEDIATE");
  try {
    if (!has("delivery_state")) db.run("ALTER TABLE messages ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'queued'");
    if (!has("lease_expires_at")) db.run("ALTER TABLE messages ADD COLUMN lease_expires_at INTEGER");
    if (!has("lease_token")) db.run("ALTER TABLE messages ADD COLUMN lease_token TEXT");
    if (!has("urgency")) db.run("ALTER TABLE messages ADD COLUMN urgency TEXT NOT NULL DEFAULT 'interrupt'");
    // DEFAULT 0 backfills the pre-urgency rows as due-now: they were all push-on-sight,
    // so never-push (NULL) would strand them. The DEFAULT applies only at ADD COLUMN
    // time — a NULL written explicitly afterwards (fyi) survives later runs because the
    // has() guard above skips this branch once the column exists.
    if (!has("push_after")) db.run("ALTER TABLE messages ADD COLUMN push_after INTEGER DEFAULT 0");
    // Additive, non-behavior-changing: existing rows backfill to 0 attempts. NOT NULL is
    // safe with a DEFAULT at ADD COLUMN time; no acked backend reads or writes it.
    if (!has("channel_push_attempts")) db.run("ALTER TABLE messages ADD COLUMN channel_push_attempts INTEGER NOT NULL DEFAULT 0");
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

/**
 * Map an urgency tier to the row's push deadline. "interrupt" is due at once;
 * "normal" waits delayMs so the recipient can drain it via check_messages first (the
 * cheap path — no inference turn); "fyi" never auto-pushes (NULL), poll-only.
 */
export function pushAfterFor(urgency: Urgency, nowMs: number, delayMs: number): number | null {
  switch (urgency) {
    case "interrupt": return nowMs;
    case "normal": return nowMs + delayMs;
    case "fyi": return null;
  }
}

export type ChannelPushDecision = { push: boolean; reason: string };

/**
 * Default per-message cap for the best-effort channel tier (#6). After this many channel
 * pushes on one queued row the broker stops re-notifying it; the row stays queued so
 * check_messages still delivers it. The tier wiring reads any operator override and falls
 * back to this.
 */
export const DEFAULT_CHANNEL_PUSH_CAP = 3;

/**
 * Decide whether the best-effort channel tier (#6) may push a queued row now.
 *
 * The channel tier is the fallback for a session that loaded the `claude/channel`
 * notification but is neither a tmux pane nor launcher-spawned, so it has no acked push
 * path, only check_messages. It pushes `notifications/claude/channel` and never acks. This
 * function owns the BOUNDED rule and is built to be consistent with NEVER-ACK:
 *
 *  Bounded (enforced here). A session that never reads must not be pushed forever, so stop
 *  after `cap` attempts on a given row. The row remains queued for check_messages; the
 *  broker just quits re-notifying it. A cap of 0 (or less) disables the tier.
 *
 *  Never-ack (enforced by confirmDelivered, not here). A channel push alone must never mark
 *  a row delivered. This function only decides to PUSH and returns no lease, claim, or
 *  confirm, so a caller acting on its decision has nothing to ack with; the invariant
 *  itself lives in confirmDelivered's lease-token guard, the one path to 'delivered',
 *  reachable only from the acked backends. A push here is fire-and-forget: a dropped
 *  notification is never lost, because the row stays queued and check_messages is the floor.
 *
 * Pure and storage-agnostic: the caller passes the row's delivery_state and its current
 * channel-push attempt count. Where that count is persisted (a messages column, an
 * in-memory map) is the tier wiring's call, deferred so this safety core lands and is
 * tested on its own. State is necessary but not the whole gate: only a 'queued' row reaches
 * here (a 'delivering' row already holds a live acked attempt, a 'delivered' row is done),
 * and the tier wiring must additionally skip poll-only rows — fyi, and floored remote
 * forwards, whose NULL push_after is a security property (their text must never be
 * auto-delivered). That push_after filter is the caller's, the same exclusion hasDuePush
 * and nextDeliverable apply, kept out of this pure cap rule.
 */
export function decideChannelPush(
  deliveryState: DeliveryState,
  attempts: number,
  cap: number,
): ChannelPushDecision {
  if (deliveryState !== "queued") return { push: false, reason: `state ${deliveryState}, not queued` };
  if (cap <= 0) return { push: false, reason: "channel tier disabled (cap <= 0)" };
  if (attempts >= cap) return { push: false, reason: `attempt cap reached (${attempts}/${cap})` };
  return { push: true, reason: `under cap (${attempts}/${cap})` };
}

/**
 * Resolve the channel tier's per-message push cap from an operator override
 * (`CLAUDE_PEERS_CHANNEL_PUSH_CAP`), falling back to `DEFAULT_CHANNEL_PUSH_CAP`. `raw` is the
 * override string, passed in by the broker wiring rather than read from the environment here,
 * so this stays pure and testable like `decideChannelPush`.
 *
 * A well-formed integer >= 0 is honored verbatim, INCLUDING 0: setting the cap to 0 disables
 * the fallback tier on purpose (`decideChannelPush` treats cap <= 0 as off), distinct from
 * leaving it unset. Everything else — unset, empty, negative, or non-numeric — is "no valid
 * override," so the built-in default stands.
 *
 * The full-string `/^\d+$/` check is stricter than the broker's other numeric env reads, which
 * use a bare `parseInt`. For a duration a partial parse is harmless, but here `parseInt("0oops")`
 * is 0 (which would disable the tier) and `parseInt("1abc")` is 1, so a typo after a leading
 * digit must reject the whole value rather than silently read as a low or zero cap. Degrading a
 * bad value to the default keeps delivery working rather than silently disabling or lowering the tier.
 *
 * A digit-only value long enough to overflow (parseInt returns Infinity past ~309 digits, or an
 * imprecise float past 2^53) also degrades to the default: decideChannelPush reads `attempts >= cap`,
 * and `attempts >= Infinity` is never true, so an overflowed cap would silently remove the ceiling
 * and re-push every session forever. Number.isSafeInteger rejects both Infinity and the lossy range.
 */
export function resolveChannelPushCap(raw: string | undefined | null): number {
  const trimmed = (raw ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_CHANNEL_PUSH_CAP;
  const parsed = parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_CHANNEL_PUSH_CAP;
  return parsed;
}

/**
 * Persistence for the channel tier's attempt count (#6, slice 1). The count decideChannelPush
 * consumes lives in the row, not an in-memory map, so a broker restart cannot reset it and
 * re-push a row past its cap. These are storage helpers only: they carry no lease, claim, or
 * confirm, so the never-ack invariant (confirmDelivered's lease-token guard) is untouched.
 */
export function getChannelPushAttempts(db: Database, id: number): number {
  const row = db.query("SELECT channel_push_attempts AS n FROM messages WHERE id=?").get(id) as { n: number } | null;
  return row?.n ?? 0;
}

/**
 * Record one channel push and return the new count. Scoped to 'queued' rows so a channel
 * push can never advance the counter on a row an acked backend has claimed (delivering) or
 * finished (delivered) — that is the "a channel push and an acked attempt cannot race the
 * lease" guard for the counter. A non-queued (or missing) row is a no-op that returns the
 * stored count unchanged.
 */
export function bumpChannelPushAttempts(db: Database, id: number): number {
  db.run(
    "UPDATE messages SET channel_push_attempts=channel_push_attempts+1 WHERE id=? AND delivery_state='queued'",
    [id],
  );
  return getChannelPushAttempts(db, id);
}

export type DeferralEscalationDecision = { escalate: boolean; reason: string };

/** Default consecutive not-ready deferrals before a stuck pane is escalated (issue #42). */
export const DEFAULT_DEFERRAL_ESCALATION_CAP = 5;

/**
 * Decide whether a run of consecutive not-ready deferrals to one recipient should escalate
 * to a louder surface than the per-attempt defer log (issue #42, follow-up to the #5 probe).
 *
 * The readiness probe (classifyPaneReadiness) skips a pane whose foreground is a shell and
 * leaves the row queued, emitting one defer log per attempt. For a transient state — Claude
 * briefly shelled out — that is correct and self-heals on the next attempt. But a pane that
 * is *permanently* a shell (the registered pid still alive, Claude gone, so the dead-pid
 * sweep never reaps it) defers on every attempt forever, and the per-attempt log is too quiet
 * to notice that a protected long-running session is silently receiving no mail.
 *
 * This owns the FIRES-ONCE rule: escalate on exactly the attempt where the streak first
 * reaches `cap`, and stay silent both below the cap (still plausibly transient) and above it
 * (already escalated — re-escalating every attempt would just restore the noise the cap is
 * meant to cut). A cap of 0 or less disables escalation.
 *
 * Pure and storage-agnostic, like decideChannelPush: the caller owns where the consecutive
 * count lives (the broker keeps an in-memory per-recipient streak, reset on any delivered or
 * otherwise-not-deferred attempt and dropped when the peer is removed) and what the louder
 * surface is (a structured log today).
 */
export function decideDeferralEscalation(
  consecutiveDeferrals: number,
  cap: number,
): DeferralEscalationDecision {
  if (cap <= 0) return { escalate: false, reason: "escalation disabled (cap <= 0)" };
  if (consecutiveDeferrals < cap) return { escalate: false, reason: `under cap (${consecutiveDeferrals}/${cap})` };
  if (consecutiveDeferrals === cap) return { escalate: true, reason: `cap reached (${consecutiveDeferrals}/${cap})` };
  return { escalate: false, reason: `already escalated (${consecutiveDeferrals}/${cap})` };
}

/**
 * Whether the recipient has any pending row that is push-due now — the gate that
 * decides if a delivery attempt may interrupt their session at all. A due
 * 'delivering' row counts: it is a retry in progress, still due work. NULL
 * push_after rows never trigger (fyi, floored forwards).
 */
export function hasDuePush(db: Database, toId: string, nowMs: number): boolean {
  const row = db.query(
    "SELECT 1 AS one FROM messages WHERE to_id=? AND delivery_state IN ('queued','delivering') AND push_after IS NOT NULL AND push_after<=? LIMIT 1",
  ).get(toId, nowMs);
  return row !== null;
}

/**
 * Once one row is due, the turn is being paid anyway — promote the recipient's
 * future-due queued rows to now so they ride the same flush instead of buying their
 * own interruption later. NULL rows are deliberately left alone: fyi and floored
 * remote forwards stay poll-only even during a flush (for floored forwards this is
 * a security property, not a courtesy — remote text must never be auto-pasted).
 */
export function promoteQueuedForFlush(db: Database, toId: string, nowMs: number): void {
  db.run(
    "UPDATE messages SET push_after=? WHERE to_id=? AND delivery_state='queued' AND push_after IS NOT NULL AND push_after>?",
    [nowMs, toId, nowMs],
  );
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

/**
 * Build the bracketed-paste-wrapped peer line. A single trailing Enter submits it.
 * Only "interrupt" carries the reply hint — it marks "the sender is blocked on you";
 * the recipient's system prompt already explains how to reply, and repeating the hint
 * on every message both costs tokens and nudges reflexive acknowledgment replies.
 * "fyi" is tagged so the recipient knows no reply is expected. Urgency defaults to
 * "interrupt" for rows that predate the column.
 */
export function formatPeerMessage(msg: { id: number; from_id: string; text: string; urgency?: Urgency | string }): string {
  const from = stripControl(msg.from_id);
  const text = stripControl(msg.text);
  const urgency = msg.urgency ?? "interrupt";
  const tag = urgency === "fyi" ? ` fyi` : "";
  const hint = urgency === "interrupt" ? `  (reply: send_message to_id="${from}")` : "";
  const body = `[peer ${from} #${msg.id}${tag}] ${text}${hint}`;
  return `${PASTE_START}${body}${PASTE_END}`;
}

export type TmuxSpawn = (args: string[]) => Promise<{ exitCode: number }>;

/** Like TmuxSpawn, but also returns the process stdout so a probe can read it. */
export type TmuxQuery = (args: string[]) => Promise<{ exitCode: number; stdout: string }>;

/** Build the argv for one tmux process that types the text then presses Enter. */
export function buildTmuxArgs(pane: string, socket: string | null, text: string): string[] {
  const args = ["tmux"];
  if (socket) args.push("-S", socket);
  args.push("send-keys", "-t", pane, "-l", text, ";", "send-keys", "-t", pane, "Enter");
  return args;
}

// Pane foreground-process names that mean a bare shell prompt rather than a running
// Claude session. A send-keys exit 0 only proves tmux queued the keystrokes; it does not
// prove Claude was at its input box. If the pane's foreground process is a shell, the
// injected Enter runs the pasted text as a shell command line instead of submitting a
// Claude turn. Claude Code runs under node, so a live Claude pane reports node (or bun),
// never one of these. The list covers the common POSIX shells, the BusyBox/embedded shells
// a container or Alpine pane drops to (ash, hush, mksh), and the cross-platform fallbacks
// (PowerShell on the Windows install path, nushell, xonsh, elvish), so the guard catches an
// outlived pane on every supported host, not just a desktop Unix one. Compared lowercased
// against pane_current_command, which tmux reports as the basename of the pane's foreground
// command. The detector is a denylist on purpose: an unrecognized foreground fails open and
// injects, so a live Claude pane is never starved by a name we did not anticipate; the cost
// of a missing shell name is one stray paste into an already-dead session, not lost mail.
// Exported so the atomic-guard builder (buildPaneReadyFormat) and its parity test derive
// from this one set rather than a hand-copied second list -- the single source of truth
// that makes the if-shell guard in issue #44 safe to build.
export const SHELL_COMMANDS = new Set([
  "bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh",
  "ash", "hush", "mksh",
  "pwsh", "powershell", "nu", "nushell", "xonsh", "elvish",
]);

export interface PaneReadiness {
  ready: boolean;
  reason: string;
}

/**
 * Decide, from a pane's foreground-process name, whether injecting a peer message is
 * safe. A bare shell is not ready: an injected Enter would run the text as a command.
 * Anything else (node or bun running Claude, or an unrecognized command) is treated as
 * ready, so an unknown foreground never blocks a legitimate delivery. This check only
 * suppresses the one case it can positively identify as wrong, and fails open otherwise.
 * Detecting a modal or permission prompt inside a live Claude pane needs capture-pane
 * signature matching and is out of scope (issue #5): the foreground process is still node
 * in that state, so this check passes it through.
 *
 * See buildPaneReadyFormat for the atomic-guard twin of this check: the same denylist
 * expressed as a tmux `-F` predicate, for closing the probe-to-send TOCTOU in issue #44.
 */
export function classifyPaneReadiness(currentCommand: string): PaneReadiness {
  const cmd = currentCommand.trim().toLowerCase();
  if (cmd === "") return { ready: true, reason: "no foreground command reported; injecting" };
  if (SHELL_COMMANDS.has(cmd)) return { ready: false, reason: `pane foreground is a shell (${cmd})` };
  return { ready: true, reason: `pane foreground is ${cmd}` };
}

/**
 * Build the tmux `-F` format predicate that evaluates truthy exactly when a pane is ready
 * for injection: its foreground command is not one of `shellCommands`. This is the
 * atomic-guard counterpart to classifyPaneReadiness. A single
 * `tmux if-shell -F <predicate> "send-keys ..."` re-reads pane_current_command and sends
 * in one process, closing the probe-to-send TOCTOU window (issue #44): a pane that stops
 * running Claude between an earlier probe and the send cannot receive a stray paste,
 * because the predicate is re-evaluated at send time inside the same tmux invocation.
 *
 * The point of deriving the predicate from the SHELL_COMMANDS set here, rather than
 * hand-copying the list into a tmux `case` string, is that the classifier and the atomic
 * guard keep one source of truth: the "two sources of truth" tradeoff #44 raises against
 * an if-shell guard does not apply when the guard is generated from the same set. Adding a
 * shell name to SHELL_COMMANDS flows into both paths at once. Shape: OR every
 * `#{==:#{pane_current_command},<sh>}` comparison, then negate, so an empty or unrecognized
 * command falls open to ready, matching classifyPaneReadiness's fail-open denylist rule.
 *
 * Two differences from the pure classifier a caller must weigh before wiring this into the
 * send path (they are why #44 needs a deliberate decision, not a reflexive patch): tmux `-F` comparisons are
 * case-sensitive and do not trim, whereas classifyPaneReadiness folds case and trims, so a
 * pane reporting "BASH" reads ready here but not-ready there. In practice
 * pane_current_command is the lowercase basename, so the two agree, but the divergence is
 * real. And `#{||:...}` / `#{?...}` format conditionals require a tmux new enough to
 * support them (roughly 2.9+); an older tmux would treat the predicate as a literal.
 */
export function buildPaneReadyFormat(shellCommands: Iterable<string> = SHELL_COMMANDS): string {
  const isShell = [...shellCommands]
    .map((sh) => `#{==:#{pane_current_command},${sh}}`)
    .reduce((acc, cmp) => (acc === "" ? cmp : `#{||:${acc},${cmp}}`), "");
  if (isShell === "") return "1"; // no shells defined: nothing is a shell, so every pane is ready
  return `#{?${isShell},0,1}`; // truthy (1) only when the command matched no shell name
}

/** Build the argv that asks tmux for a pane's foreground command name. */
export function buildPaneCommandArgs(pane: string, socket: string | null): string[] {
  const args = ["tmux"];
  if (socket) args.push("-S", socket);
  args.push("display-message", "-p", "-t", pane, "#{pane_current_command}");
  return args;
}

/** Build the argv that asks tmux for a pane's session name (#S), the human-facing handle. */
export function buildSessionNameArgs(pane: string, socket: string | null): string[] {
  const args = ["tmux"];
  if (socket) args.push("-S", socket);
  args.push("display-message", "-p", "-t", pane, "#S");
  return args;
}

/** Environment-variable name a session can set to override its resolved name. */
export const SESSION_NAME_ENV = "CLAUDE_PEERS_SESSION_NAME";

/**
 * Resolve the friendly name of the caller's own session -- the handle a human uses
 * (e.g. "newsroom", "billing"), so a peer told "ask newsroom" can find it. Precedence:
 * an explicit CLAUDE_PEERS_SESSION_NAME override (lets a non-tmux session, or a future
 * harness that exposes the name, set it) wins; otherwise the tmux session name of the
 * pane this process runs in, read via `tmux display-message '#S'`. Returns null when
 * neither is available -- a non-tmux session with no override, or a tmux read that
 * faults. The name is optional everywhere downstream, so a missing one degrades to an
 * unnamed peer rather than an error, exactly as before this field existed.
 */
export async function resolveSessionName(
  env: {
    [SESSION_NAME_ENV]?: string | null;
    TMUX?: string | null;
    TMUX_PANE?: string | null;
    [key: string]: string | null | undefined;
  },
  query: TmuxQuery,
): Promise<string | null> {
  const override = env[SESSION_NAME_ENV]?.trim();
  if (override) return override;
  const target = resolveTmuxTarget(env);
  if (!target) return null;
  try {
    const { exitCode, stdout } = await query(buildSessionNameArgs(target.pane, target.socket));
    if (exitCode !== 0) return null;
    const name = stdout.trim();
    return name.length > 0 ? name : null;
  } catch (e) {
    console.error("[claude-peers] session-name probe error:", e);
    return null;
  }
}

/** Default kill-timeout for a session-name probe, so a wedged tmux cannot stall registration. */
export const SESSION_NAME_TIMEOUT_MS = 2_000;

/**
 * Build a real TmuxQuery: spawn tmux, capture stdout, report the exit code, and kill the process
 * if it outlives timeoutMs so a hung tmux cannot stall the caller. A spawn fault rejects to the
 * caller's try/catch rather than being swallowed here. Both callers that need a stdout-capturing
 * tmux query -- the broker's pre-send readiness probe and the server's session-name lookup --
 * share this one implementation, differing only in the timeout they pass.
 */
export function makeSpawnTmuxQuery(timeoutMs: number): TmuxQuery {
  return async (args) => {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    try {
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { exitCode, stdout };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Probe a pane's readiness for injection by reading its foreground command via tmux.
 * Fails open: any probe fault (non-zero exit or spawn rejection) yields ready, so a broken
 * probe can never starve delivery. Only a clean probe that positively identifies a shell
 * returns not-ready.
 */
export async function probePaneReadiness(
  pane: string, socket: string | null, query: TmuxQuery,
): Promise<PaneReadiness> {
  try {
    const { exitCode, stdout } = await query(buildPaneCommandArgs(pane, socket));
    if (exitCode !== 0) return { ready: true, reason: `pane probe exited ${exitCode}; injecting` };
    return classifyPaneReadiness(stdout);
  } catch (e) {
    console.error(`[claude-peers broker] pane readiness probe error for pane ${pane}:`, e);
    return { ready: true, reason: "pane probe threw; injecting" };
  }
}

/**
 * Inject text into a pane via one tmux spawn. Success iff tmux exits 0. When `query` is
 * supplied, the pane's readiness is probed first: if the pane is positively a shell prompt
 * rather than a live Claude session, the injection is skipped and false is returned so the
 * message stays queued for a later attempt instead of landing as a stray shell command.
 * Omitting `query` preserves the original inject-unconditionally behavior.
 *
 * `onDefer` fires only when a clean probe positively identifies a shell and the injection is
 * skipped — not on a probe fault (which fails open and injects) nor on a send failure. The
 * broker uses it to count consecutive not-ready deferrals per recipient and escalate a pane
 * that is stuck a shell (issue #42); callers that do not track this omit it.
 */
export async function deliverViaTmux(
  pane: string, socket: string | null, text: string, spawn: TmuxSpawn, query?: TmuxQuery,
  onDefer?: (reason: string) => void,
): Promise<boolean> {
  try {
    if (query) {
      const readiness = await probePaneReadiness(pane, socket, query);
      if (!readiness.ready) {
        console.error(`[claude-peers broker] deferring tmux delivery to pane ${pane}: ${readiness.reason}`);
        onDefer?.(readiness.reason);
        return false;
      }
    }
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
  urgency: string; push_after: number | null;
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
  // NULL push_after rows (fyi, floored forwards) live outside the push channel entirely —
  // they are skipped here so a poll-only row cannot jam pushable mail behind it. FIFO
  // holds within each channel (push vs poll), not across them.
  // Column list mirrors DeliverableRow exactly — keep them in sync if the schema changes.
  const row = db.query(
    "SELECT id, from_id, to_id, text, sent_at, delivery_state, lease_expires_at, lease_token, urgency, push_after FROM messages WHERE to_id=? AND delivery_state IN ('queued','delivering') AND push_after IS NOT NULL ORDER BY id ASC LIMIT 1",
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
