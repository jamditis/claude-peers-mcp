// shared/doctor.ts
// Pure, testable operator diagnostics for `bun cli.ts doctor` (issue #73).
//
// Split, matching the rest of the repo: this module gathers facts through injected seams
// (a fetch, a read-only Database, a pid probe, a tmux query) and turns them into structured
// checks; cli.ts owns the wiring and the rendering choice (text or --json).
//
// Two constraints shape everything below.
//
// Read-only. Doctor never registers a peer, never marks a row delivered, never writes the
// store. It reads /health and /list-peers (both non-mutating; /list-peers is token-exempt and
// already strips the capability token) and opens db_path readonly. That is also why it adds no
// broker route and leaves PROTOCOL_VERSION alone: a diagnostic that refuses to run against an
// older broker is useless exactly when it is needed, so an older broker is REPORTED, not retired.
//
// Never leaks. The facts below are a deliberate allow-list of non-sensitive columns: no
// `peers.token`, no `messages.text`, no `lease_token`, no environment values. Message state is
// counted and aged, never read. `redact` is the belt-and-braces second line for strings that
// come back from someone else (a fetch error, a SQLite message) and could quote something we
// did not choose.

import type { Database } from "bun:sqlite";
import { HOLDERLESS_DELIVERING, type PaneReadiness } from "../delivery.ts";
import { displaySessionName } from "./format-peers.ts";

/** Severity of a single check. `fail` means broken now; `warn` means degraded or at risk. */
export type DoctorSeverity = "ok" | "warn" | "fail";

/**
 * One diagnostic result. `code` is the stable machine-readable identity (safe to grep or
 * alert on); `detail` explains what was observed; `remediation` is the operator's next
 * action and is present on every non-ok check.
 */
export interface DoctorCheck {
  id: string;
  title: string;
  code: string;
  severity: DoctorSeverity;
  detail: string;
  remediation: string | null;
}

export interface DoctorReport {
  generated_at: string;
  ok: boolean;
  counts: { ok: number; warn: number; fail: number };
  checks: DoctorCheck[];
}

// A local peer whose last_seen is older than this is not heartbeating. Mirrors the broker's
// LOCAL_PEER_TTL_MS; a parity test pins the two together so a broker-side change surfaces here.
export const DOCTOR_PEER_STALE_MS = 45_000;
// Floor for "this backlog is not draining", used when push_delay_ms is at or below the default.
export const DOCTOR_QUEUE_STALE_MS = 15 * 60_000;

/**
 * How old pending mail must be before doctor calls the backlog stale.
 *
 * It cannot be a fixed constant: `push_delay_ms` is an operator knob, and a node configured to
 * hold normal-urgency mail for, say, half an hour is doing exactly what it was told when a row
 * sits queued for twenty minutes. Flagging that would train an operator to ignore the check.
 * So the window is at least twice the configured delay — one delay to become push-due, another
 * for the push and the recipient's own poll to have had their chance — with the constant as the
 * floor for the default and shorter delays.
 */
export function resolveQueueStaleMs(pushDelayMs: number): number {
  const delay = Number.isFinite(pushDelayMs) && pushDelayMs > 0 ? pushDelayMs : 0;
  return Math.max(DOCTOR_QUEUE_STALE_MS, delay * 2);
}

// --- Fact types (what doctor observes; deliberately free of secrets) ---

export interface ConfigFacts {
  /** Config file doctor resolved, so an operator can tell WHICH file the fleet is running on. */
  path: string;
  loaded: boolean;
  /** True when no config file existed and the zero-config single-host default is in force. */
  defaulted: boolean;
  /**
   * Descriptions of `siblings` entries doctor could not probe — a non-array value, or entries
   * that are not objects or lack a machine/url string. loadConfig checks that required keys are
   * PRESENT, not that they are well-typed, so everything from `"siblings": {}` to `[null]` loads
   * happily and then explodes in the first federation loop that iterates it. Reporting the fault
   * is what keeps it a structured check (with valid --json) rather than a stack trace.
   */
  siblings_invalid: string[];
  error: string | null;
}

export interface BrokerProbeFacts {
  url: string;
  reachable: boolean;
  error: string | null;
  status: string | null;
  protocol_version: number | null;
  machine: string | null;
  local_peer_count: number | null;
  remote_peer_count: number | null;
  /** Whether a real peer operation (/list-peers) succeeded. null = not attempted. */
  serves_peers: boolean | null;
  serve_error: string | null;
}

export interface SiblingProbeFacts {
  /** The machine name this sibling is configured AS. */
  machine: string;
  url: string;
  reachable: boolean;
  /** The machine name the host at `url` calls ITSELF. A mismatch means the URL is misrouted. */
  reported_machine: string | null;
  /** The sibling's own self-assessment from /health, judged exactly as the local broker's is. */
  status: string | null;
  protocol_version: number | null;
  latency_ms: number | null;
  error: string | null;
}

/** The peer columns doctor reads. `token`, `cwd`, and `summary` are deliberately not here. */
export interface StoredPeer {
  id: string;
  name: string | null;
  machine: string;
  pid: number;
  delivery_kind: string;
  tmux_pane: string | null;
  tmux_socket: string | null;
  last_seen: string;
}

export type BackendState = "ready" | "unready" | "absent" | "none" | "unknown";

export interface PeerFacts {
  id: string;
  name: string | null;
  machine: string;
  pid: number;
  delivery_kind: string;
  last_seen: string;
  age_ms: number | null;
  pid_alive: boolean | null;
  /**
   * "ready" = pane present and its foreground is not a bare shell; "unready" = pane present
   * but the foreground is a shell, so a push would be deferred (live but not usable — the
   * state the issue asks to distinguish from a dead process); "absent" = registered as a tmux
   * backend with no pane recorded; "none" = poll-only session by design; "unknown" = not probed.
   */
  backend: BackendState;
  backend_reason: string | null;
}

export interface QueueFacts {
  to_id: string;
  queued: number;
  delivering: number;
  /**
   * Rows with push_after IS NULL — fyi and floored forwards, poll-only whatever the recipient is.
   * This is only HALF of the broker's isPollOnly rule: the other half is the recipient itself
   * (a session with no push backend makes all of its mail poll-only, push_after or not), which
   * needs peer facts and so is applied in checkQueues rather than baked into this count.
   */
  never_push: number;
  oldest_pending_at: string | null;
  oldest_age_ms: number | null;
  /**
   * How long the recipient's earliest push deadline has been due (epoch-ms `push_after`, the
   * column hasDuePush reads), or null when no pending row has one — all poll-only, or a store
   * with no push_after column. Judging "overdue" from this rather than from sent_at is what keeps
   * doctor consistent with the broker: push_after is STORED at insert from the delay in force
   * then, so a row enqueued under a longer push_delay_ms carries its own later deadline, and
   * inferring staleness from the CURRENT setting would call it stale while hasDuePush correctly
   * still refuses to push it.
   */
  oldest_due_ms: number | null;
}

export interface StalledLeaseFacts {
  message_id: number;
  to_id: string;
  /** How long the lease has been expired, or null when the row carries no expiry at all. */
  expired_ms: number | null;
  /**
   * The row is `delivering` with a missing lease column, so no attempt can own it (the broker's
   * HOLDERLESS_DELIVERING invariant). Reported as a boolean: whether a lease token exists, never
   * what it is.
   */
  holderless: boolean;
}

export interface StoreFacts {
  path: string;
  integrity: "ok" | "corrupt" | "missing" | "unreadable";
  integrity_detail: string;
  /**
   * Whether the queue and lease reads actually completed. False means the arrays below are
   * absence of data, not absence of mail — the difference between "nothing is stuck" and
   * "nothing was read", which a queue check must never blur into a green result.
   */
  queues_read: boolean;
  queues: QueueFacts[];
  stalled_leases: StalledLeaseFacts[];
  /** Recipients holding rows whose channel push attempts have stopped making progress. */
  push_capped: Array<{ to_id: string; rows: number }>;
}

export interface DoctorFacts {
  now_ms: number;
  expected_protocol: number;
  /** The node's configured push_delay_ms, so backlog staleness is judged against its own policy. */
  push_delay_ms: number;
  /** Whether the peer table was actually read (see checkPeers; false means "unknown", not "none"). */
  peers_read: boolean;
  config: ConfigFacts;
  broker: BrokerProbeFacts;
  siblings: SiblingProbeFacts[];
  peers: PeerFacts[];
  store: StoreFacts;
}

// --- Redaction ---

// A capability token is 64 lowercase hex chars (generateAuthToken); a lease nonce is 16 base36.
// Neither is ever put into a check by this module, but an error string handed to us by fetch or
// SQLite is not ours to trust, so scrub anything token-shaped before it can reach the output.
const TOKEN_SHAPED = /\b[0-9a-f]{32,}\b/gi;
const BEARER = /Bearer\s+\S+/gi;
// The text renderer is line-per-check, so a newline inside a foreign string would let that string
// forge a check line ("[ok  ] Broker process: BROKER_OK"). Collapsing C0/DEL — which also strips
// any escape sequence's introducer — keeps every foreign value on the line it was printed on.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point here — this strip is what keeps them out of the rendered report
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

/** Strip token-shaped runs, Authorization values, and control characters from foreign text. */
export function redact(text: string, maxLen = 200): string {
  const scrubbed = text
    .replace(BEARER, "Bearer [redacted]")
    .replace(TOKEN_SHAPED, "[redacted]")
    .replace(CONTROL_CHARS, " ")
    .trim();
  return scrubbed.length > maxLen ? `${scrubbed.slice(0, maxLen)}…` : scrubbed;
}

/**
 * Which SQLite file doctor should inspect.
 *
 * A loaded config already carries the resolution (loadConfig lets CLAUDE_PEERS_DB override the
 * file's db_path), so it wins outright. The env override only has to be repeated for the case
 * that has no config at all — doctor still runs when the config is broken, and that is exactly
 * when reading the wrong store would be most misleading: an empty queue reported with confidence
 * while the broker's real store, named only by the env var, holds the stuck mail.
 */
export function resolveDoctorDbPath(
  configDbPath: string | undefined,
  envDbPath: string | undefined,
  homeDefault: string,
): string {
  return configDbPath ?? (envDbPath && envDbPath.length > 0 ? envDbPath : homeDefault);
}

// --- Fact gathering (injected seams; no globals) ---

/** A sibling entry doctor can actually probe: both fields present and non-empty strings. */
export interface ValidSibling { machine: string; url: string; }

/**
 * Split a config's `siblings` value into the entries that can be probed and a description of the
 * ones that cannot.
 *
 * loadConfig checks that required keys exist, not what they contain, so everything from
 * `"siblings": {}` to `[null]` to `[{"machine": "b"}]` reaches this code. probeSiblings reads
 * `s.url` to build the request and `s.machine` to label the result — including inside its own
 * catch — so one malformed entry throws past every boundary and doctor emits no report at all,
 * which is the one outcome a diagnostic must never have. Entries are described by INDEX rather
 * than by their contents: an entry that failed validation cannot be trusted to name itself.
 */
export function partitionSiblings(raw: unknown): { valid: ValidSibling[]; invalid: string[] } {
  if (raw === undefined || raw === null) return { valid: [], invalid: [] };
  if (!Array.isArray(raw)) return { valid: [], invalid: ['"siblings" is not an array'] };
  const valid: ValidSibling[] = [];
  const invalid: string[] = [];
  raw.forEach((entry, i) => {
    if (entry === null || typeof entry !== "object") {
      invalid.push(`entry ${i} is not an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const machine = typeof e.machine === "string" ? e.machine.trim() : "";
    const url = typeof e.url === "string" ? e.url.trim() : "";
    const missing = [machine === "" ? "machine" : null, url === "" ? "url" : null].filter(Boolean);
    if (missing.length > 0) {
      invalid.push(`entry ${i} is missing ${missing.join(" and ")}`);
      return;
    }
    valid.push({ machine, url });
  });
  return { valid, invalid };
}

export type DoctorFetch = (
  url: string,
  body?: unknown,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Probe the local broker: is the process answering at all (/health), and can it actually serve
 * a peer operation (/list-peers)? A process that answers /health but faults on a peer read is a
 * distinct state from a dead one — the split the issue asks for — so both are recorded.
 */
export async function probeBroker(fetchFn: DoctorFetch, url: string): Promise<BrokerProbeFacts> {
  const base: BrokerProbeFacts = {
    url, reachable: false, error: null, status: null, protocol_version: null,
    machine: null, local_peer_count: null, remote_peer_count: null,
    serves_peers: null, serve_error: null,
  };
  try {
    const res = await fetchFn(`${url}/health`);
    // ANY HTTP response proves a process is listening and answering, so reachability is settled
    // here — before the body is judged. A 500 from /health is a broker that is up and broken,
    // which is precisely the state this command exists to name; reporting it as "no broker
    // answered" would send the operator off to start a broker that is already running.
    base.reachable = true;
    if (!res.ok) return { ...base, error: `health returned ${res.status}` };
    const h = (await res.json()) as Record<string, unknown>;
    // /health is the local broker's own output, but it is still a foreign string by the time it
    // reaches a line-per-check renderer, and it is echoed verbatim into a check detail. Same
    // treatment as every other value we did not author.
    base.status = typeof h.status === "string" ? redact(h.status, 40) : null;
    // A reachable broker with no protocol_version predates the field entirely (protocol 1),
    // the same resolution `send` uses — not "unknown".
    base.protocol_version = typeof h.protocol_version === "number" ? h.protocol_version : 1;
    base.machine = typeof h.machine === "string" ? redact(h.machine, 60) : null;
    base.local_peer_count = typeof h.peers === "number" ? h.peers : null;
    base.remote_peer_count = typeof h.remote_peer_count === "number" ? h.remote_peer_count : null;
  } catch (e) {
    // A transport fault leaves reachable as set above: false if the connection never landed,
    // true if we had already taken a response and only the body was unreadable.
    return { ...base, error: redact(e instanceof Error ? e.message : String(e)) };
  }
  try {
    // A real peer operation, not another liveness ping: /list-peers is a POST that touches the
    // store, so it fails where /health still answers (a locked or corrupt SQLite file). Scoped
    // to "machine" with a root cwd so it never filters itself down to an empty answer. Read-only
    // and token-exempt, and it strips the token column on the broker side (stripToken).
    const res = await fetchFn(`${url}/list-peers`, { scope: "machine", cwd: "/", git_root: null });
    base.serves_peers = res.ok;
    if (!res.ok) base.serve_error = `list-peers returned ${res.status}`;
    else await res.json();
  } catch (e) {
    base.serves_peers = false;
    base.serve_error = redact(e instanceof Error ? e.message : String(e));
  }
  return base;
}

/**
 * Probe every configured sibling's /health for reachability, protocol version, and the machine
 * name it calls itself. Probes run concurrently: each carries its own multi-second timeout, and
 * serially a handful of unreachable siblings would add up to a diagnostic that looks hung
 * exactly when the fleet is broken. Promise.all preserves configuration order in the result.
 */
export async function probeSiblings(
  fetchFn: DoctorFetch,
  siblings: Array<{ machine: string; url: string }>,
  nowMs: () => number,
): Promise<SiblingProbeFacts[]> {
  return Promise.all(siblings.map(async (s): Promise<SiblingProbeFacts> => {
    const started = nowMs();
    try {
      const res = await fetchFn(`${s.url}/health`);
      const latency_ms = nowMs() - started;
      if (!res.ok) {
        return {
          machine: s.machine, url: s.url, reachable: false, reported_machine: null,
          status: null, protocol_version: null, latency_ms, error: `health returned ${res.status}`,
        };
      }
      const h = (await res.json()) as Record<string, unknown>;
      return {
        machine: s.machine, url: s.url, reachable: true,
        reported_machine: typeof h.machine === "string" ? redact(h.machine, 60) : null,
        status: typeof h.status === "string" ? redact(h.status, 40) : null,
        protocol_version: typeof h.protocol_version === "number" ? h.protocol_version : 1,
        latency_ms, error: null,
      };
    } catch (e) {
      return {
        machine: s.machine, url: s.url, reachable: false, reported_machine: null,
        status: null, protocol_version: null, latency_ms: null,
        error: redact(e instanceof Error ? e.message : String(e)),
      };
    }
  }));
}

/** Whether a column exists, so a legacy store missing a newer column degrades instead of throwing. */
function hasColumn(db: Database, table: string, column: string): boolean {
  try {
    return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  } catch {
    return false;
  }
}

/**
 * Whether a table exists. A store the broker has never opened has no messages table yet, and
 * an empty queue is the honest answer there — not an unreadable store.
 */
function hasTable(db: Database, table: string): boolean {
  try {
    return db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== null;
  } catch {
    return false;
  }
}

/**
 * The peer rows doctor inspects. Explicit column list: `token` must never be selected.
 *
 * The projection is built from PRAGMA table_info rather than written out flat, because the store
 * predates several of these columns (`name` arrived in protocol 7, the delivery columns in 2) and
 * the broker only adds them when IT next opens the file. Doctor opens the store READ-ONLY, so it
 * can never do that migration itself — a flat SELECT would throw "no such column" and label an
 * old-but-perfectly-healthy store unreadable, which is the opposite of a diagnostic's job. A
 * missing column reads as the value its migration backfills: NULL for name and the pane
 * coordinates, 'none' for delivery_kind (no push backend on record).
 */
export function readStoredPeers(db: Database): StoredPeer[] {
  if (!hasTable(db, "peers")) return [];
  const col = (name: string, fallback: string) =>
    (hasColumn(db, "peers", name) ? name : `${fallback} AS ${name}`);
  return db.query(
    `SELECT id, pid, machine, last_seen,
            ${col("name", "NULL")}, ${col("delivery_kind", "'none'")},
            ${col("tmux_pane", "NULL")}, ${col("tmux_socket", "NULL")}
       FROM peers`,
  ).all() as StoredPeer[];
}

/**
 * Read queue state, stalled leases, and store integrity from an already-open (read-only)
 * database. Every projection is an aggregate or an id — `text` is never selected, so no message
 * body can reach the report even by accident.
 */
export function readStoreFacts(db: Database, path: string, nowMs: number, pushCap: number): StoreFacts {
  const facts: StoreFacts = {
    path, integrity: "ok", integrity_detail: "", queues_read: false,
    queues: [], stalled_leases: [], push_capped: [],
  };
  try {
    const rows = db.query("PRAGMA quick_check").all() as Array<Record<string, string>>;
    const verdict = rows.map((r) => Object.values(r)[0]).join("; ");
    if (verdict.toLowerCase() !== "ok") {
      facts.integrity = "corrupt";
      facts.integrity_detail = redact(verdict);
    } else {
      facts.integrity_detail = "quick_check ok";
    }
  } catch (e) {
    facts.integrity = "unreadable";
    facts.integrity_detail = redact(e instanceof Error ? e.message : String(e));
    return facts;
  }

  // A store the broker has not opened yet has no messages table. That is an empty queue, and a
  // real reading of it — not a failure to read.
  if (!hasTable(db, "messages")) {
    facts.queues_read = true;
    return facts;
  }

  // Same reasoning as readStoredPeers, and more load-bearing here: a protocol-1 store keeps a
  // boolean `delivered` column and has no delivery_state, no push_after, and no lease columns at
  // all, so the modern queries do not merely lose a field — they throw, and the whole store gets
  // reported unreadable at exit 2 while nothing is actually wrong with it. Doctor is read-only
  // and cannot migrate, so it reads the old shape on the old shape's terms: `delivered` maps to
  // the two states it encoded, and an absent push_after reads as 0 (due now), which is exactly
  // what migrateMessagesSchema backfills.
  const modernState = hasColumn(db, "messages", "delivery_state");
  const hasPushAfter = hasColumn(db, "messages", "push_after");
  const state = modernState
    ? "delivery_state"
    : "(CASE WHEN delivered=1 THEN 'delivered' ELSE 'queued' END)";
  const pushAfter = hasPushAfter ? "push_after" : "0";
  // Leases arrived with delivery_state; without both columns no row can be 'delivering', so
  // there is no lease to stall and the query is skipped rather than guessed at.
  const hasLeases = modernState
    && hasColumn(db, "messages", "lease_expires_at")
    && hasColumn(db, "messages", "lease_token");

  try {
    const queues = db.query(
      `SELECT to_id,
              SUM(CASE WHEN ${state}='queued' THEN 1 ELSE 0 END) AS queued,
              SUM(CASE WHEN ${state}='delivering' THEN 1 ELSE 0 END) AS delivering,
              SUM(CASE WHEN ${pushAfter} IS NULL THEN 1 ELSE 0 END) AS never_push,
              MIN(sent_at) AS oldest_pending_at,
              ${hasPushAfter ? "MIN(CASE WHEN push_after IS NOT NULL THEN push_after END)" : "NULL"} AS oldest_push_after
         FROM messages
        WHERE ${state} IN ('queued','delivering')
        GROUP BY to_id
        ORDER BY to_id`,
    ).all() as Array<{ to_id: string; queued: number; delivering: number; never_push: number; oldest_pending_at: string | null; oldest_push_after: number | null }>;
    facts.queues = queues.map(({ oldest_push_after, ...q }) => {
      const parsed = q.oldest_pending_at === null ? Number.NaN : Date.parse(q.oldest_pending_at);
      return {
        ...q,
        // Clamp at 0: a store written by a host whose clock is ahead must read as "just now",
        // never as negative age. A deadline still in the future clamps to 0 too — not yet due is
        // not overdue.
        oldest_age_ms: Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null,
        oldest_due_ms: oldest_push_after === null ? null : Math.max(0, nowMs - oldest_push_after),
      };
    });

    // A delivering row is stalled when its lease has expired (the owner never confirmed or
    // released) or when it is holderless. Holderless is the broker's OWN predicate, imported
    // rather than restated: a row with a future lease_expires_at but a NULL lease_token belongs
    // to no attempt (claimForDelivery writes state, expiry, and token in one UPDATE), and
    // nextDeliverable nonetheless reads that future timestamp as a live attempt and blocks the
    // recipient head-of-line until it passes. Expiry alone would call that jam healthy.
    // `lease_token IS NULL` is selected as a boolean; the token value itself is never read.
    if (hasLeases) {
      const stalled = db.query(
        `SELECT id, to_id, lease_expires_at, (lease_token IS NULL) AS no_token FROM messages
          WHERE ${HOLDERLESS_DELIVERING}
             OR (delivery_state='delivering' AND lease_expires_at < ?)
          ORDER BY id`,
      ).all(nowMs) as Array<{ id: number; to_id: string; lease_expires_at: number | null; no_token: number }>;
      facts.stalled_leases = stalled.map((r) => ({
        message_id: r.id,
        to_id: r.to_id,
        expired_ms: r.lease_expires_at === null ? null : Math.max(0, nowMs - r.lease_expires_at),
        holderless: r.lease_expires_at === null || r.no_token === 1,
      }));
    }

    if (hasColumn(db, "messages", "channel_push_attempts") && pushCap > 0) {
      facts.push_capped = db.query(
        `SELECT to_id, COUNT(*) AS row_count FROM messages
          WHERE ${state}='queued' AND channel_push_attempts >= ?
          GROUP BY to_id ORDER BY to_id`,
      ).all(pushCap).map((r) => {
        const row = r as { to_id: string; row_count: number };
        return { to_id: row.to_id, rows: row.row_count };
      });
    }
    facts.queues_read = true;
  } catch (e) {
    facts.integrity = "unreadable";
    facts.integrity_detail = redact(e instanceof Error ? e.message : String(e));
  }
  return facts;
}

export interface PeerProbeDeps {
  nowMs: number;
  /** True when the registered pid is still alive. */
  isPidAlive: (pid: number) => boolean;
  /** Foreground-readiness of a tmux pane; omitted when tmux cannot be probed at all. */
  probePane?: (pane: string, socket: string | null) => Promise<PaneReadiness>;
}

/**
 * Turn stored peer rows into diagnosable facts: heartbeat age, whether the registered process
 * still exists, and whether its delivery backend could actually take a push right now. The pane
 * probe is injected so tests exercise the real classification without a real tmux.
 */
export async function resolvePeerFacts(peers: StoredPeer[], deps: PeerProbeDeps): Promise<PeerFacts[]> {
  // Concurrent, order-preserving. Each pane probe spawns tmux under a multi-second kill-timeout,
  // and the fleet this is aimed at runs many panes: serially, one wedged tmux per peer turns a
  // diagnostic into a minute-long hang precisely when the host is in trouble. Promise.all keeps
  // the result in peer order regardless of which probe returns first.
  return Promise.all(peers.map(async (p): Promise<PeerFacts> => {
    const seen = Date.parse(p.last_seen);
    let pid_alive: boolean | null = null;
    try {
      pid_alive = deps.isPidAlive(p.pid);
    } catch {
      pid_alive = null;
    }
    let backend: BackendState = "none";
    let backend_reason: string | null = null;
    if (p.delivery_kind === "tmux") {
      if (!p.tmux_pane) {
        backend = "absent";
        backend_reason = "registered as a tmux backend but no pane recorded";
      } else if (!deps.probePane) {
        backend = "unknown";
        backend_reason = "pane not probed";
      } else {
        try {
          const readiness = await deps.probePane(p.tmux_pane, p.tmux_socket);
          backend = readiness.ready ? "ready" : "unready";
          backend_reason = redact(readiness.reason);
        } catch (e) {
          backend = "unknown";
          backend_reason = redact(e instanceof Error ? e.message : String(e));
        }
      }
    } else {
      backend_reason = `delivery_kind=${redact(p.delivery_kind, 20)}; messages wait for check_messages`;
    }
    return {
      id: p.id, name: p.name, machine: p.machine, pid: p.pid,
      delivery_kind: p.delivery_kind, last_seen: p.last_seen,
      age_ms: Number.isFinite(seen) ? Math.max(0, deps.nowMs - seen) : null,
      pid_alive, backend, backend_reason,
    };
  }));
}

// --- Check construction (pure) ---

function check(
  id: string, title: string, code: string, severity: DoctorSeverity,
  detail: string, remediation: string | null = null,
): DoctorCheck {
  return { id, title, code, severity, detail, remediation };
}

/** Compact relative age for a check's detail text. */
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function checkConfig(c: ConfigFacts): DoctorCheck[] {
  if (!c.loaded) {
    return [check(
      "config.source", "Config", "CONFIG_UNREADABLE", "fail",
      `Could not load config at ${redact(c.path, 120)}${c.error ? `: ${c.error}` : ""}.`,
      "Fix or recreate the config file (see deploy/configs/ for per-host samples), or point CLAUDE_PEERS_CONFIG at a valid one.",
    )];
  }
  if (c.siblings_invalid.length > 0) {
    return [check(
      "config.source", "Config", "CONFIG_SIBLINGS_INVALID", "fail",
      `${redact(c.path, 120)} has ${c.siblings_invalid.length} unusable "siblings" entr${c.siblings_invalid.length === 1 ? "y" : "ies"} (${c.siblings_invalid.join("; ")}); those siblings were not probed and federation cannot reach them.`,
      'Set "siblings" to an array of {"machine","url"} entries (an empty array [] for a single-host node).',
    )];
  }
  if (c.defaulted) {
    // Not a warning. A single host with no config file is a supported, documented deployment
    // (loadConfig returns singleHostDefault for exactly this case), so flagging it would mean a
    // healthy default install could never exit 0 — and a check that cannot be satisfied is a
    // check an operator learns to ignore. An explicitly requested config that failed to load is
    // a different thing entirely, and fails above.
    return [check(
      "config.source", "Config", "CONFIG_DEFAULTED", "ok",
      `No config file at ${redact(c.path, 120)}; running the zero-config single-host default (loopback only, no siblings). Write one if this host is meant to federate.`,
    )];
  }
  return [check("config.source", "Config", "CONFIG_OK", "ok", `Loaded ${redact(c.path, 120)}.`)];
}

export function checkBroker(b: BrokerProbeFacts, expectedProtocol: number): DoctorCheck[] {
  if (!b.reachable) {
    return [check(
      "broker.process", "Broker process", "BROKER_UNREACHABLE", "fail",
      `No broker answered ${b.url}/health${b.error ? ` (${b.error})` : ""}.`,
      "Start any MCP session (the server auto-launches the broker), or run `bun broker.ts` directly. Queue state below was read from SQLite instead.",
    )];
  }
  const checks: DoctorCheck[] = [];
  const counts = `${b.local_peer_count ?? "?"} local peer(s), ${b.remote_peer_count ?? "?"} remote`;
  if (b.error !== null) {
    // A process answered but its health endpoint did not: an HTTP error, or a body we could not
    // read. Distinct from BROKER_UNREACHABLE, and distinct from a broker that reports its own
    // unhealthy status — here even the report failed.
    checks.push(check(
      "broker.process", "Broker process", "BROKER_HEALTH_ERROR", "fail",
      `A process is answering at ${b.url} but /health did not: ${b.error}.`,
      "The port is taken by a broken or foreign process. Check the broker log; if the port belongs to something else, free it, otherwise `bun cli.ts kill-broker` and let the next session relaunch.",
    ));
  } else if (b.status !== "ok") {
    checks.push(check(
      "broker.process", "Broker process", "BROKER_UNHEALTHY", "warn",
      `Broker answered ${b.url} with status "${b.status ?? "none"}" (${counts}).`,
      "Check the broker log; restart it with `bun cli.ts kill-broker` and let the next session relaunch it.",
    ));
  } else {
    checks.push(check(
      "broker.process", "Broker process", "BROKER_OK", "ok",
      `Answering at ${b.url}${b.machine ? ` as ${b.machine}` : ""} (${counts}).`,
    ));
  }

  if (b.serves_peers === false) {
    checks.push(check(
      "broker.serving", "Peer operations", "BROKER_NOT_SERVING", "fail",
      `The broker process is alive but a peer read failed${b.serve_error ? `: ${b.serve_error}` : ""}.`,
      "The process is up but cannot serve peers — usually a bad or locked SQLite store. Check store.integrity below, then `bun cli.ts kill-broker`.",
    ));
  } else if (b.serves_peers === true) {
    checks.push(check("broker.serving", "Peer operations", "BROKER_SERVING", "ok", "/list-peers answered."));
  }

  const v = b.protocol_version;
  if (v === null) {
    checks.push(check(
      "broker.protocol", "Protocol version", "BROKER_PROTOCOL_UNKNOWN", "warn",
      "The broker reported no protocol version.",
      "Restart the broker so a current build takes the port.",
    ));
  } else if (v < expectedProtocol) {
    checks.push(check(
      "broker.protocol", "Protocol version", "BROKER_PROTOCOL_OUTDATED", "warn",
      `Broker speaks protocol ${v}; this build expects ${expectedProtocol}. Newer features (urgency tiers, /peek, /heartbeat-probe) may be ignored.`,
      "Run `bun cli.ts kill-broker`; the next MCP session relaunches the current broker.",
    ));
  } else if (v > expectedProtocol) {
    checks.push(check(
      "broker.protocol", "Protocol version", "BROKER_PROTOCOL_AHEAD", "warn",
      `Broker speaks protocol ${v}; this CLI build expects ${expectedProtocol}.`,
      "Update this checkout — the running broker is newer than the CLI.",
    ));
  } else {
    checks.push(check("broker.protocol", "Protocol version", "BROKER_PROTOCOL_OK", "ok", `Protocol ${v}.`));
  }
  return checks;
}

export function checkStore(s: StoreFacts): DoctorCheck[] {
  // A POSIX filename may contain newlines, and db_path comes from a config file or an env var —
  // foreign input by the same standard as everything else here. The FACTS keep the real path
  // (the caller opens the file with it); only the rendered form is collapsed and capped.
  const shown = redact(s.path, 120);
  switch (s.integrity) {
    case "missing":
      return [check(
        "store.integrity", "Message store", "STORE_MISSING", "warn",
        `No SQLite store at ${shown}.`,
        "Expected before the first session registers; the broker creates it on start.",
      )];
    case "unreadable":
      return [check(
        "store.integrity", "Message store", "STORE_UNREADABLE", "fail",
        `Could not read ${shown}: ${s.integrity_detail}.`,
        "Check file permissions and that db_path points at the broker's store.",
      )];
    case "corrupt":
      return [check(
        "store.integrity", "Message store", "STORE_CORRUPT", "fail",
        `PRAGMA quick_check on ${shown} reported: ${s.integrity_detail}.`,
        "Stop the broker (`bun cli.ts kill-broker`), back up the file, then recover it with sqlite3 .recover or move it aside to start clean (queued mail is lost).",
      )];
    default:
      return [check("store.integrity", "Message store", "STORE_OK", "ok", `${shown}: quick_check ok.`)];
  }
}

export function checkSiblings(siblings: SiblingProbeFacts[], expectedProtocol: number): DoctorCheck[] {
  if (siblings.length === 0) {
    return [check("siblings", "Siblings", "SIBLINGS_NONE", "ok", "No siblings configured (single-host node).")];
  }
  return siblings.map((s) => {
    if (!s.reachable) {
      return check(
        `sibling.${s.machine}`, `Sibling ${s.machine}`, "SIBLING_UNREACHABLE", "warn",
        `${s.url} did not answer${s.error ? ` (${s.error})` : ""}. Peers on ${s.machine} will not appear here and sends to them will fail.`,
        `Check that ${s.machine} is up and its broker is running, and that the network path (e.g. the tailnet) is connected.`,
      );
    }
    // The host answered, but is it the host we think? /health names the machine it runs on, so a
    // config pointing two entries at one URL (a copy-paste, a stale IP another node has taken
    // over) is visible here and nowhere else: gossip would keep filing that host's peers under
    // the wrong name, and every other check would read green.
    // Case-insensitively, the way resolveTargetBroker compares these very names when routing a
    // forward (issue #17: sibling config and gossiped machine name come from independently-edited
    // files, so casing drifts). A case-sensitive compare here would report a mismatch on a pair
    // the broker itself considers a match, sending an operator to fix working federation.
    if (s.reported_machine !== null && s.reported_machine.toLowerCase() !== s.machine.toLowerCase()) {
      return check(
        `sibling.${s.machine}`, `Sibling ${s.machine}`, "SIBLING_MACHINE_MISMATCH", "warn",
        `${s.url} is configured as ${s.machine} but calls itself ${s.reported_machine}, so this entry points at the wrong host.`,
        `Fix the sibling URL for ${s.machine} in the config (two entries may share one address, or the address moved to another node).`,
      );
    }
    if (s.protocol_version !== null && s.protocol_version !== expectedProtocol) {
      return check(
        `sibling.${s.machine}`, `Sibling ${s.machine}`, "SIBLING_PROTOCOL_MISMATCH", "warn",
        `${s.machine} speaks protocol ${s.protocol_version}; this node expects ${expectedProtocol}. Fields newer than ${s.protocol_version} are dropped in both directions.`,
        `Upgrade the ${s.protocol_version < expectedProtocol ? "sibling" : "local"} node so both run the same release.`,
      );
    }
    // A sibling's own self-assessment counts for as much as the local broker's, which is already
    // evaluated: a 2xx only says the HTTP layer worked, and "degraded" in the body is the host
    // telling us it is not well.
    if (s.status !== null && s.status !== "ok") {
      return check(
        `sibling.${s.machine}`, `Sibling ${s.machine}`, "SIBLING_UNHEALTHY", "warn",
        `${s.url} answered but reports its own status as "${s.status}" (protocol ${s.protocol_version}).`,
        `Check the broker log on ${s.machine}; peers there may not be reachable even though the host answers.`,
      );
    }
    return check(
      `sibling.${s.machine}`, `Sibling ${s.machine}`, "SIBLING_OK", "ok",
      `${s.url} reachable (protocol ${s.protocol_version}${s.latency_ms === null ? "" : `, ${s.latency_ms}ms`}).`,
    );
  });
}

/**
 * One check per registered peer, at the worst state observed. Ordering matters: a dead process
 * explains everything downstream of it, so it wins over a stale heartbeat, which in turn wins
 * over a backend that merely cannot take a push right now.
 */
export function checkPeers(
  peers: PeerFacts[], staleMs = DOCTOR_PEER_STALE_MS, peersRead = true,
): DoctorCheck[] {
  // Same rule as the queue section: an empty list because the read failed is not an empty list.
  // "No peers registered" printed over an unreadable store is a false all-clear.
  if (!peersRead) {
    return [check(
      "peers", "Peers", "PEERS_UNAVAILABLE", "warn",
      "The peer table could not be read, so no conclusion about registered sessions or their backends is possible.",
      "Fix the store (see the message-store check above), then re-run doctor.",
    )];
  }
  if (peers.length === 0) {
    return [check("peers", "Peers", "PEERS_NONE", "ok", "No peers registered.")];
  }
  return peers.map((p) => {
    // A session name comes from the tmux session or an env override — operator-controlled, but
    // not OURS, and the text renderer is one line per check. displaySessionName is the same
    // collapse-and-cap list_peers applies, so a name carrying newlines cannot forge a check line
    // and an oversized one cannot bury the report. redact strips control characters underneath.
    const label = p.name ? `${p.id} (${redact(displaySessionName(p.name), 60)})` : p.id;
    const id = `peer.${p.id}`;
    const title = `Peer ${label}`;
    const age = formatMs(p.age_ms);
    if (p.pid_alive === false) {
      return check(
        id, title, "PEER_PROCESS_DEAD", "fail",
        `PID ${p.pid} is gone but the row is still registered (last seen ${age} ago).`,
        "The broker's dead-pid sweep normally clears this within a cleanup tick; if it persists, the row is stuck — restart the broker.",
      );
    }
    if (p.age_ms !== null && p.age_ms > staleMs) {
      return check(
        id, title, "PEER_STALE", "warn",
        `Last heartbeat ${age} ago (stale past ${formatMs(staleMs)}); the process is alive but not calling the broker.`,
        "The session is likely wedged or its MCP server lost the broker. Check the session, or let TTL eviction reap it.",
      );
    }
    if (p.backend === "absent") {
      return check(
        id, title, "PEER_BACKEND_MISSING", "warn",
        `Registered with delivery_kind=tmux but no pane recorded, so nothing can be pushed (last seen ${age} ago).`,
        "Restart the session inside a tmux pane so it re-registers a delivery target; until then its mail waits for check_messages.",
      );
    }
    if (p.backend === "unready") {
      return check(
        id, title, "PEER_BACKEND_UNREADY", "warn",
        `Pane is live but not ready for injection — ${p.backend_reason ?? "foreground is a shell"}. Pushes defer; mail stays queued rather than lost.`,
        "Claude has exited or shelled out in that pane. Bring it back to the foreground, or expect the peer to read via check_messages.",
      );
    }
    if (p.backend === "unknown") {
      return check(
        id, title, "PEER_BACKEND_UNKNOWN", "warn",
        `Backend readiness could not be determined — ${p.backend_reason ?? "probe unavailable"}.`,
        "Check that tmux is installed and reachable from this shell; delivery fails open, so pushes are still attempted.",
      );
    }
    if (p.backend === "none") {
      return check(
        id, title, "PEER_POLL_ONLY", "ok",
        `No push backend (${p.backend_reason ?? "delivery_kind=none"}); healthy, reads via check_messages. Last seen ${age} ago.`,
      );
    }
    return check(id, title, "PEER_OK", "ok", `Healthy: pane ready, last seen ${age} ago.`);
  });
}

/**
 * Queue health per recipient plus the two fleet-wide delivery pathologies: leases that never
 * settled, and rows whose push attempts have hit their cap. Counts and ages only — no bodies.
 */
export function checkQueues(
  s: StoreFacts, peers: PeerFacts[], staleMs = DOCTOR_QUEUE_STALE_MS,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const known = new Set(peers.map((p) => p.id));
  const unreadyPeers = new Set(peers.filter((p) => p.backend === "unready" || p.backend === "absent").map((p) => p.id));
  // The recipient half of the broker's isPollOnly rule: a session with no push backend at all
  // ('none', or a tmux registration with no pane) can never be pushed to, so ALL of its pending
  // mail is poll-only regardless of push_after. Counting only push_after IS NULL would report
  // "0 poll-only" for a delivery_kind='none' session whose entire backlog waits on check_messages.
  const unpushable = new Set(
    peers.filter((p) => p.backend === "none" || p.backend === "absent").map((p) => p.id),
  );

  // Nothing below was read, so nothing below may be reported as clear. An empty array here means
  // the reads never ran, and answering "no pending messages / no stalled leases" would be the
  // worst possible failure mode for a diagnostic: an all-green queue section printed underneath
  // an unreadable store, which is exactly when the operator most needs to be told to look.
  if (!s.queues_read) {
    const missing = s.integrity === "missing";
    return [check(
      "queue", "Queues", "QUEUE_UNAVAILABLE", missing ? "ok" : "warn",
      missing
        ? `No store at ${redact(s.path, 120)} yet, so there is no queue to read.`
        : `Queue and lease state could not be read from ${redact(s.path, 120)}: ${s.integrity_detail}. No conclusion about pending mail or stalled leases is possible.`,
      missing ? null : "Fix the store (see the message-store check above), then re-run doctor.",
    )];
  }

  if (s.queues.length === 0) {
    checks.push(check("queue", "Queues", "QUEUE_EMPTY", "ok", "No pending messages."));
  }
  for (const q of s.queues) {
    const id = `queue.${q.to_id}`;
    const title = `Queue ${q.to_id}`;
    // An unknown recipient is unpushable too: no peer row means no backend (QUEUE_ORPHANED below).
    const pollOnly = unpushable.has(q.to_id) || !known.has(q.to_id)
      ? q.queued + q.delivering
      : q.never_push;
    const counts =
      `${q.queued} queued, ${q.delivering} delivering, ${pollOnly} poll-only; oldest ${formatMs(q.oldest_age_ms)} old`;
    if (!known.has(q.to_id)) {
      checks.push(check(
        id, title, "QUEUE_ORPHANED", "warn",
        `${counts}. No peer with this id is registered here, so nothing will ever read it.`,
        "Peer ids are per-session and never reused; this mail is unreachable. It ages out via the 24h queued backstop, or clear it by removing the peer's rows.",
      ));
      continue;
    }
    if (unreadyPeers.has(q.to_id)) {
      checks.push(check(
        id, title, "QUEUE_DELIVERY_DEFERRED", "warn",
        `${counts}. The recipient's pane is not accepting pushes, so delivery attempts keep deferring.`,
        "Fix the recipient's pane (see its peer check above) or have that session run check_messages.",
      ));
      continue;
    }
    // Overdue against the row's OWN stored deadline when it has one; a wholly poll-only backlog
    // has no deadline to miss, so its age since sent_at is the only signal available.
    const overdueMs = q.oldest_due_ms ?? q.oldest_age_ms;
    if (overdueMs !== null && overdueMs > staleMs) {
      checks.push(check(
        id, title, "QUEUE_BACKLOG_STALE", "warn",
        `${counts}. Older than ${formatMs(staleMs)} — past this node's own push window — so the recipient is not draining.`,
        "Have that session run check_messages; if it never does, it is wedged — restart it.",
      ));
      continue;
    }
    checks.push(check(id, title, "QUEUE_OK", "ok", counts));
  }

  if (s.stalled_leases.length > 0) {
    const holderless = s.stalled_leases.filter((l) => l.holderless).length;
    const oldest = s.stalled_leases.reduce<number | null>(
      (acc, l) => (l.expired_ms === null ? acc : acc === null ? l.expired_ms : Math.max(acc, l.expired_ms)), null,
    );
    checks.push(check(
      "queue.leases", "Delivery leases", "QUEUE_LEASE_STALLED", "fail",
      `${s.stalled_leases.length} row(s) stuck in delivering (${holderless} holderless — a missing lease column, so no attempt owns them; oldest expired ${formatMs(oldest)} ago). They block the recipient's queued prefix.`,
      "Restart the broker (`bun cli.ts kill-broker`): it requeues orphaned delivering rows on start and its sweep reclaims holderless ones. A holderless row with a future expiry never times out on its own.",
    ));
  } else {
    checks.push(check("queue.leases", "Delivery leases", "QUEUE_LEASE_OK", "ok", "No stalled leases."));
  }

  if (s.push_capped.length > 0) {
    const rows = s.push_capped.reduce((n, r) => n + r.rows, 0);
    checks.push(check(
      "delivery.attempts", "Push attempts", "DELIVERY_PUSH_CAP_REACHED", "warn",
      `${rows} queued row(s) across ${s.push_capped.length} recipient(s) have hit the channel push cap, so they are no longer being re-notified.`,
      "Not lost: check_messages still delivers them. Have those sessions poll, or raise CLAUDE_PEERS_CHANNEL_PUSH_CAP.",
    ));
  }
  return checks;
}

/** Assemble the whole report from gathered facts. Pure: the same facts always give the same report. */
export function buildDoctorReport(facts: DoctorFacts): DoctorReport {
  const checks = [
    ...checkConfig(facts.config),
    ...checkBroker(facts.broker, facts.expected_protocol),
    ...checkStore(facts.store),
    ...checkSiblings(facts.siblings, facts.expected_protocol),
    ...checkPeers(facts.peers, DOCTOR_PEER_STALE_MS, facts.peers_read),
    ...checkQueues(facts.store, facts.peers, resolveQueueStaleMs(facts.push_delay_ms)),
  ];
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.severity]++;
  return {
    generated_at: new Date(facts.now_ms).toISOString(),
    ok: counts.fail === 0 && counts.warn === 0,
    counts,
    checks,
  };
}

const MARKS: Record<DoctorSeverity, string> = { ok: "ok  ", warn: "WARN", fail: "FAIL" };

/** Render the report as operator-readable text: one line per check, remediation indented under it. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [`claude-peers doctor — ${report.generated_at}`, ""];
  for (const c of report.checks) {
    lines.push(`[${MARKS[c.severity]}] ${c.title}: ${c.code}`);
    lines.push(`       ${c.detail}`);
    if (c.remediation) lines.push(`       → ${c.remediation}`);
  }
  lines.push("");
  lines.push(
    report.ok
      ? `All ${report.counts.ok} check(s) passed.`
      : `${report.counts.fail} failing, ${report.counts.warn} warning, ${report.counts.ok} ok.`,
  );
  return lines.join("\n");
}

/** Process exit code: 2 on any failure, 1 on warnings only, 0 when clean. */
export function doctorExitCode(report: DoctorReport): number {
  if (report.counts.fail > 0) return 2;
  if (report.counts.warn > 0) return 1;
  return 0;
}
