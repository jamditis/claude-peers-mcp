# Reliable peer-message delivery (M1) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superjawn:subagent-driven-development (recommended) or superjawn:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make peer messages arrive on their own in a running Claude session via the tmux backend and a `check_messages` floor, with no Claude-side polling and no silent message consumption.

**Architecture:** Delivery moves out of the per-session MCP poll loop into the broker daemon. The broker resolves a recipient's backend locally and pushes: a tmux pane via `send-keys`, or — for a session reachable by no backend — leaves the message `queued` for `check_messages`. A per-message lease (`queued`→`delivering`→`delivered`) plus token-gated confirmation makes send-time injection, the heartbeat drain, and `check_messages` mutually safe, and guarantees a message is marked `delivered` only on a real confirmation (`send-keys` exit 0 or a `check_messages` read).

**Tech stack:** Bun, `bun:sqlite`, `Bun.serve`, `Bun.spawn` (array args, no shell), `@modelcontextprotocol/sdk` 1.27.1, `bun test`. TypeScript, ESM.

**Spec:** `docs/superpowers/specs/2026-06-03-peer-message-delivery-design.md`. This plan implements **milestone 1 only**. The launcher backend is milestone 2 (deferred, issues #7/#8) and is out of scope here.

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `shared/types.ts` | Broker API types | Modify: add `delivery_kind`/`tmux_pane`/`tmux_socket` to `Peer`+`RegisterRequest`; `Message.delivery_state`; `SendResult`; bump `PROTOCOL_VERSION` consumers |
| `shared/config.ts` | Config loading | Modify: add optional `floor_remote_forwards` |
| `delivery.ts` (new) | Pure, testable delivery logic: schema migration, lease state machine, tmux target/format, `deliverViaTmux`, ordering, message prune | Create |
| `broker.ts` | Broker daemon | Modify: import + wire `delivery.ts`; new schema; lease-based send/forward/heartbeat drain; loopback `/register` check; `/retire`; `/health` protocol version; liveness ESRCH/EPERM fix; staleness prune; remove `/peek-messages` + `/ack-messages`; optional self-exit |
| `server.ts` | MCP server | Modify: remove poll loop + `mcp.notification` + `CLAUDE_PEERS_CHANNEL`; send `tmux_pane`/`tmux_socket` at registration; broker version handshake in `ensureBroker`; surface `delivery` from `send_message` |
| `tests/delivery.test.ts` (new) | Unit tests for `delivery.ts` | Create |
| `tests/integration.test.ts` | Two-broker HTTP harness | Modify: add delivery, regression, version-handshake, crash-recovery, liveness, cross-machine tests; stub-`tmux` helper |
| `cli.ts` | CLI | Modify: `status` prints broker protocol version (minor) |

**Why a new `delivery.ts`:** `broker.ts` keeps its daemon logic inside `if (import.meta.main)`, so those closures are not importable by tests. All new delivery logic that needs unit tests goes in `delivery.ts` as exported functions (the same pattern as the existing exported helpers in `broker.ts`), and `broker.ts` composes them. This keeps each file focused and the new logic testable in isolation.

---

## Conventions used by every task

- Run a single test: `bun test tests/delivery.test.ts -t "<test name>"`.
- Run a file: `bun test tests/delivery.test.ts` / `bun test tests/integration.test.ts`.
- Run all: `bun test`.
- Commit messages explain **why**, not what. **Never** add a `Co-Authored-By` trailer or any AI-attribution text — this repo's commit hook rejects the trailer and the owner's rules forbid the attribution. Do not use `--no-verify`.
- Sentence case in prose and log messages. No emojis in code or logs.

---

### Task 1: Types and config fields

**Files:**
- Modify: `shared/types.ts`
- Modify: `shared/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/config.test.ts`)

```ts
import { describe, it, expect } from "bun:test";
import { loadConfig } from "../shared/config.ts";

describe("floor_remote_forwards", () => {
  it("defaults to false when absent", async () => {
    const path = "/tmp/cfg-floor-absent.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19001,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    expect(loadConfig(path).floor_remote_forwards).toBe(false);
  });

  it("reads true when set", async () => {
    const path = "/tmp/cfg-floor-true.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19002,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
      floor_remote_forwards: true,
    }));
    expect(loadConfig(path).floor_remote_forwards).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/config.test.ts -t "floor_remote_forwards"`
Expected: FAIL — `floor_remote_forwards` is `undefined`, not `false`.

- [ ] **Step 3: Implement — `shared/config.ts`**

Add the field to the interface (after `db_path`):

```ts
export interface PeersConfig {
  machine: string;
  tailscale_ip: string;
  port: number;
  id_prefix: string;
  siblings: SiblingConfig[];
  allowed_ips: string[];
  db_path: string;
  floor_remote_forwards: boolean;
}
```

Change the return in `loadConfig` so the flag defaults to `false` (do **not** add it to `REQUIRED_FIELDS`):

```ts
  const db_path = process.env.CLAUDE_PEERS_DB ?? (obj.db_path as string | undefined) ?? DEFAULT_DB_PATH;
  const floor_remote_forwards = obj.floor_remote_forwards === true;

  return { ...obj, db_path, floor_remote_forwards } as PeersConfig;
```

- [ ] **Step 4: Implement — `shared/types.ts`**

Add a delivery-kind type and extend `Peer`, `RegisterRequest`, `Message`; add `SendResult` and the broker protocol constant. Replace the relevant blocks:

```ts
export type DeliveryKind = "tmux" | "launcher" | "none";
export type DeliveryState = "queued" | "delivering" | "delivered";

// Broker wire-protocol version. Bumped to 2 for the delivery_state schema and
// delivery backends. server.ts requires at least this from a running broker.
export const PROTOCOL_VERSION = 2;

export interface Peer {
  id: PeerId;
  pid: number;
  machine: string;
  tailscale_ip: string;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
  is_remote?: boolean;
  // Local-only delivery coordinates. Never serialized into gossip/forward payloads.
  tmux_pane?: string | null;
  tmux_socket?: string | null;
  delivery_kind?: DeliveryKind;
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string;
  delivery_state: DeliveryState;
  lease_expires_at: number | null;
  lease_token: string | null;
}

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  machine: string;
  tailscale_ip: string;
  tmux_pane?: string | null;
  tmux_socket?: string | null;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  routed?: "local" | "remote";
  delivery?: "injected" | "accepted" | "queued";
}
```

`GossipRequest` and `ForwardMessageRequest` are left unchanged — they already carry only identity/routing fields, never pane/socket/launcher data.

Note: `broker.ts` currently declares its own `const PROTOCOL_VERSION = 1`. Task 9 replaces that with the imported constant; do not duplicate it.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS (all config tests, including the two new ones).

- [ ] **Step 6: Commit**

```bash
git add shared/config.ts shared/types.ts tests/config.test.ts
git commit -m "Add delivery types and floor_remote_forwards config flag

Foundational types for the M1 delivery path: delivery_kind/tmux coordinates
on Peer, delivery_state/lease columns on Message, the SendResult shape, and
the broker protocol bump to 2. floor_remote_forwards lets a deployment opt
out of cross-machine auto-injection without code changes."
```

---

### Task 2: `delivery_state` schema and migration

**Files:**
- Create: `delivery.ts`
- Create: `tests/delivery.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/delivery.test.ts`)

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import { ensureMessagesTable, migrateMessagesSchema } from "../delivery.ts";

const DB = "/tmp/test-delivery-migration.db";

function cols(db: Database): string[] {
  return (db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
}

describe("migrateMessagesSchema", () => {
  beforeEach(() => { try { unlinkSync(DB); } catch {} });
  afterEach(() => { try { unlinkSync(DB); } catch {} });

  it("creates a fresh DB directly in the new schema", () => {
    const db = new Database(DB);
    ensureMessagesTable(db);
    migrateMessagesSchema(db);
    const c = cols(db);
    expect(c).toContain("delivery_state");
    expect(c).toContain("lease_expires_at");
    expect(c).toContain("lease_token");
    expect(c).not.toContain("delivered");
    db.close();
  });

  it("backfills a legacy DB and drops the delivered column", () => {
    const db = new Database(DB);
    db.run(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
      text TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
    )`);
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivered) VALUES ('a','b','hi',?,1)", [new Date().toISOString()]);
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivered) VALUES ('a','b','yo',?,0)", [new Date().toISOString()]);

    ensureMessagesTable(db); // no-op: table exists
    migrateMessagesSchema(db);

    const c = cols(db);
    expect(c).not.toContain("delivered");
    expect(c).toContain("delivery_state");
    const rows = db.query("SELECT text, delivery_state FROM messages ORDER BY id").all() as any[];
    expect(rows[0].delivery_state).toBe("delivered");
    expect(rows[1].delivery_state).toBe("queued");
    db.close();
  });

  it("is a no-op on a second run (already migrated)", () => {
    const db = new Database(DB);
    ensureMessagesTable(db);
    migrateMessagesSchema(db);
    expect(() => migrateMessagesSchema(db)).not.toThrow();
    expect(cols(db)).not.toContain("delivered");
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/delivery.test.ts -t "migrateMessagesSchema"`
Expected: FAIL — `Cannot find module '../delivery.ts'`.

- [ ] **Step 3: Implement — `delivery.ts` (create with this header + the two functions)**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/delivery.test.ts -t "migrateMessagesSchema"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add delivery.ts tests/delivery.test.ts
git commit -m "Add gated, transactional messages-schema migration

delivery_state is the single source of truth. A fresh DB is born in the new
schema; a legacy DB is upgraded inside one BEGIN IMMEDIATE transaction with
per-column PRAGMA guards so a second broker start (or a racing starter) is a
no-op rather than a thrown duplicate-column error."
```

---

### Task 2 covers migration; subsequent tasks build on `delivery.ts`.

### Task 3: Lease state machine

**Files:**
- Modify: `delivery.ts`
- Test: `tests/delivery.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/delivery.test.ts`)

```ts
import {
  generateLeaseToken, claimForDelivery, confirmDelivered,
  releaseToQueued, resetDeliveringOnStart, reclaimIfExpired,
} from "../delivery.ts";

const LDB = "/tmp/test-delivery-lease.db";

function seededDb(): Database {
  try { unlinkSync(LDB); } catch {}
  const db = new Database(LDB);
  ensureMessagesTable(db);
  return db;
}
function insert(db: Database, toId: string): number {
  db.run("INSERT INTO messages (from_id,to_id,text,sent_at) VALUES ('a',?,?,?)",
    [toId, "m", new Date().toISOString()]);
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}
function state(db: Database, id: number) {
  return db.query("SELECT delivery_state, lease_token, lease_expires_at FROM messages WHERE id=?").get(id) as any;
}

describe("lease state machine", () => {
  let db: Database;
  beforeEach(() => { db = seededDb(); });
  afterEach(() => { db.close(); try { unlinkSync(LDB); } catch {} });

  it("a queued row is claimable once", () => {
    const id = insert(db, "b");
    expect(claimForDelivery(db, id, 1000, 5000, "tok1")).toBe(true);
    expect(claimForDelivery(db, id, 1000, 5000, "tok2")).toBe(false);
    expect(state(db, id).delivery_state).toBe("delivering");
    expect(state(db, id).lease_token).toBe("tok1");
  });

  it("confirm requires the matching token", () => {
    const id = insert(db, "b");
    claimForDelivery(db, id, 1000, 5000, "tok1");
    expect(confirmDelivered(db, id, "wrong")).toBe(false);
    expect(state(db, id).delivery_state).toBe("delivering");
    expect(confirmDelivered(db, id, "tok1")).toBe(true);
    expect(state(db, id).delivery_state).toBe("delivered");
  });

  it("releaseToQueued only releases the holder's row", () => {
    const id = insert(db, "b");
    claimForDelivery(db, id, 1000, 5000, "tok1");
    releaseToQueued(db, id, "wrong");
    expect(state(db, id).delivery_state).toBe("delivering");
    releaseToQueued(db, id, "tok1");
    expect(state(db, id).delivery_state).toBe("queued");
    expect(state(db, id).lease_token).toBeNull();
  });

  it("reclaimIfExpired reclaims only a past-due delivering row", () => {
    const id = insert(db, "b");
    claimForDelivery(db, id, 1000, 5000, "tok1"); // expires at 6000
    expect(reclaimIfExpired(db, id, 5000)).toBe(false); // not yet expired
    expect(reclaimIfExpired(db, id, 7000)).toBe(true);  // expired
    expect(state(db, id).delivery_state).toBe("queued");
  });

  it("resetDeliveringOnStart requeues every delivering row", () => {
    const a = insert(db, "b"); const c = insert(db, "b");
    claimForDelivery(db, a, 1000, 5000, "t1");
    claimForDelivery(db, c, 1000, 5000, "t2");
    expect(resetDeliveringOnStart(db)).toBe(2);
    expect(state(db, a).delivery_state).toBe("queued");
    expect(state(db, c).delivery_state).toBe("queued");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/delivery.test.ts -t "lease state machine"`
Expected: FAIL — the lease functions are not exported.

- [ ] **Step 3: Implement — append to `delivery.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/delivery.test.ts -t "lease state machine"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add delivery.ts tests/delivery.test.ts
git commit -m "Add per-message lease state machine

Token-gated claim/confirm/release plus an expired-lease reclaim and a
start-up requeue. The token gate is what stops a stale confirmation from a
timed-out attempt flipping a re-leased row — the core of the never-ack
invariant that designs out the original silent-consume bug."
```

---

### Task 4: tmux target resolution and message format

**Files:**
- Modify: `delivery.ts`
- Test: `tests/delivery.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/delivery.test.ts`)

```ts
import { resolveTmuxTarget, formatPeerMessage, PASTE_START, PASTE_END } from "../delivery.ts";

describe("resolveTmuxTarget", () => {
  it("accepts a valid pane and socket", () => {
    expect(resolveTmuxTarget({ TMUX_PANE: "%3", TMUX: "/tmp/tmux-1000/default,1234,0" }))
      .toEqual({ pane: "%3", socket: "/tmp/tmux-1000/default" });
  });
  it("returns null for a missing or malformed pane", () => {
    expect(resolveTmuxTarget({})).toBeNull();
    expect(resolveTmuxTarget({ TMUX_PANE: "3" })).toBeNull();
    expect(resolveTmuxTarget({ TMUX_PANE: "%3; rm -rf" })).toBeNull();
  });
  it("drops a non-absolute socket but keeps the pane", () => {
    expect(resolveTmuxTarget({ TMUX_PANE: "%0", TMUX: "relative,1,0" }))
      .toEqual({ pane: "%0", socket: null });
  });
});

describe("formatPeerMessage", () => {
  it("wraps in bracketed paste with the id tag and reply hint", () => {
    const out = formatPeerMessage({ id: 7, from_id: "bet-abc", text: "ping" });
    expect(out.startsWith(PASTE_START)).toBe(true);
    expect(out.endsWith(PASTE_END)).toBe(true);
    expect(out).toContain("[peer bet-abc #7] ping");
    expect(out).toContain('(reply: send_message to_id="bet-abc")');
  });
  it("keeps embedded newlines inside the paste wrap", () => {
    const out = formatPeerMessage({ id: 1, from_id: "x", text: "a\nb" });
    expect(out).toContain("a\nb");
    expect(out.indexOf("\n")).toBeGreaterThan(out.indexOf(PASTE_START));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/delivery.test.ts -t "resolveTmuxTarget"`
Expected: FAIL — functions/constants not exported.

- [ ] **Step 3: Implement — append to `delivery.ts`**

```ts
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

/** Build the bracketed-paste-wrapped peer line. A single trailing Enter submits it. */
export function formatPeerMessage(msg: { id: number; from_id: string; text: string }): string {
  const body = `[peer ${msg.from_id} #${msg.id}] ${msg.text}  (reply: send_message to_id="${msg.from_id}")`;
  return `${PASTE_START}${body}${PASTE_END}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/delivery.test.ts -t "resolveTmuxTarget"` then `-t "formatPeerMessage"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add delivery.ts tests/delivery.test.ts
git commit -m "Add tmux target validation and bracketed-paste message format

Pane ids are validated against ^%\\d+$ and sockets must be absolute, so neither
can carry shell metacharacters into the spawn. The bracketed-paste wrap makes a
multi-line peer message land as one input and submit on a single Enter."
```

---

### Task 5: `deliverViaTmux` with an injected spawn

**Files:**
- Modify: `delivery.ts`
- Test: `tests/delivery.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/delivery.test.ts`)

```ts
import { deliverViaTmux, buildTmuxArgs, type TmuxSpawn } from "../delivery.ts";

describe("buildTmuxArgs", () => {
  it("chains both send-keys in one tmux invocation, with -S when socketed", () => {
    expect(buildTmuxArgs("%2", "/tmp/sock", "TXT")).toEqual([
      "tmux", "-S", "/tmp/sock", "send-keys", "-t", "%2", "-l", "TXT",
      ";", "send-keys", "-t", "%2", "Enter",
    ]);
  });
  it("omits -S when there is no socket", () => {
    expect(buildTmuxArgs("%2", null, "TXT")).toEqual([
      "tmux", "send-keys", "-t", "%2", "-l", "TXT", ";", "send-keys", "-t", "%2", "Enter",
    ]);
  });
});

describe("deliverViaTmux", () => {
  it("returns true on exit 0", async () => {
    const spawn: TmuxSpawn = async () => ({ exitCode: 0 });
    expect(await deliverViaTmux("%1", null, "hi", spawn)).toBe(true);
  });
  it("returns false on non-zero exit", async () => {
    const spawn: TmuxSpawn = async () => ({ exitCode: 1 });
    expect(await deliverViaTmux("%1", null, "hi", spawn)).toBe(false);
  });
  it("returns false when the spawn throws (timeout/abort)", async () => {
    const spawn: TmuxSpawn = async () => { throw new Error("timed out"); };
    expect(await deliverViaTmux("%1", null, "hi", spawn)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/delivery.test.ts -t "deliverViaTmux"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement — append to `delivery.ts`**

```ts
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
  } catch {
    return false;
  }
}
```

The real `TmuxSpawn` used by the daemon (Task 7) wraps `Bun.spawn` with array args, a 2s timeout, and always awaits `proc.exited` so no child is left unreaped.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/delivery.test.ts -t "deliverViaTmux"` then `-t "buildTmuxArgs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add delivery.ts tests/delivery.test.ts
git commit -m "Add deliverViaTmux over an injected spawn

The spawn is injected so the exit-0/non-zero/throw paths are unit-tested
without a real tmux. The argv chains both send-keys in one tmux process, so a
delivery costs one spawn, not two."
```

---

### Task 6: Ordering — next-deliverable selection

**Files:**
- Modify: `delivery.ts`
- Test: `tests/delivery.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/delivery.test.ts`)

```ts
import { nextDeliverable, type DeliverableRow } from "../delivery.ts";

const NDB = "/tmp/test-delivery-order.db";
function orderDb(): Database {
  try { unlinkSync(NDB); } catch {}
  const db = new Database(NDB); ensureMessagesTable(db); return db;
}
function ins(db: Database, toId: string): number {
  db.run("INSERT INTO messages (from_id,to_id,text,sent_at) VALUES ('a',?,?,?)", [toId, "m", new Date().toISOString()]);
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

describe("nextDeliverable", () => {
  let db: Database;
  beforeEach(() => { db = orderDb(); });
  afterEach(() => { db.close(); try { unlinkSync(NDB); } catch {} });

  it("returns the oldest queued row for the recipient", () => {
    const a = ins(db, "b"); ins(db, "b");
    expect(nextDeliverable(db, "b", 1000, new Set())!.id).toBe(a);
  });

  it("does not jump a younger row ahead of an in-flight older one", () => {
    const a = ins(db, "b"); ins(db, "b");
    claimForDelivery(db, a, 1000, 5000, "t1"); // a is delivering; lease expires at 6000
    // A live attempt at the head of line blocks the whole recipient — the younger row
    // never overtakes it. Either guard alone suffices, so prove each in isolation.
    expect(nextDeliverable(db, "b", 7000, new Set([a]))).toBeNull(); // active set blocks even past lease expiry
    expect(nextDeliverable(db, "b", 2000, new Set())).toBeNull();    // an unexpired lease blocks on its own
  });

  it("treats an expired, non-active delivering row as reclaimable (returns it)", () => {
    const a = ins(db, "b");
    claimForDelivery(db, a, 1000, 5000, "t1"); // expires 6000
    const row = nextDeliverable(db, "b", 7000, new Set());
    expect(row!.id).toBe(a);
    expect(row!.delivery_state).toBe("delivering"); // caller must reclaim before claiming
  });

  it("ignores other recipients", () => {
    ins(db, "other");
    expect(nextDeliverable(db, "b", 1000, new Set())).toBeNull();
  });
});
```

(A delivering row is "live" — and so blocks the recipient's head of line — when the broker is actively attempting it (`activeIds`) OR its lease has not yet expired. Hence the `||` in `nextDeliverable`: the two assertions above isolate each disjunct (active-with-expired-lease, and unexpired-lease-without-active), and the reclaimable test below proves the only returnable delivering case is expired AND not active. The `||` also keeps the consumer safe — returning a row whose lease is still live would let `reclaimIfExpired` fail and, in the active case, risk a second attempt on a row already in flight.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/delivery.test.ts -t "nextDeliverable"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement — append to `delivery.ts`**

```ts
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
  const rows = db.query(
    "SELECT id, from_id, to_id, text, sent_at, delivery_state, lease_expires_at, lease_token FROM messages WHERE to_id=? AND delivery_state IN ('queued','delivering') ORDER BY id ASC",
  ).all(toId) as DeliverableRow[];
  for (const row of rows) {
    if (row.delivery_state === "queued") return row;
    const live = activeIds.has(row.id) || (row.lease_expires_at !== null && row.lease_expires_at > nowMs);
    if (live) return null;     // head-of-line blocked by a live attempt
    return row;                // expired + not active => reclaimable
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/delivery.test.ts -t "nextDeliverable"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add delivery.ts tests/delivery.test.ts
git commit -m "Add ordered next-deliverable selection per recipient

Walks a recipient's rows oldest-id first and stops at the head-of-line if a
live attempt holds it, so a younger message never overtakes an older blocked
one. An expired, non-active delivering row is surfaced for reclaim."
```

---

### Task 7: Wire delivery into broker send / forward / heartbeat

**Files:**
- Modify: `broker.ts`
- Test: `tests/integration.test.ts`

This task replaces the broker's message storage/retrieval with the lease-based delivery path and adds the per-recipient serial drain. It introduces a real `TmuxSpawn` and a stub-`tmux` integration helper.

- [ ] **Step 1: Write the failing integration test** (append a new `describe` block to `tests/integration.test.ts`)

First add a stub-`tmux` helper near the top of the file (after the imports):

```ts
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Create a directory holding a fake `tmux` executable that records its argv and
// exits 0, so the broker's tmux backend is deterministic without a real tmux.
function makeStubTmux(): { dir: string; logFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "stub-tmux-"));
  const logFile = join(dir, "tmux.log");
  const stub = join(dir, "tmux");
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\0' "$@" >> "${logFile}"\nexit 0\n`);
  chmodSync(stub, 0o755);
  return { dir, logFile };
}
```

Then the delivery test block:

```ts
describe("tmux delivery and floor", () => {
  const PORT = 17905;
  let proc: any;
  let stub: { dir: string; logFile: string };

  const cfg = {
    machine: "del-a", tailscale_ip: "127.0.0.1", port: PORT,
    id_prefix: "dla", siblings: [], allowed_ips: ["127.0.0.1"],
  };

  beforeAll(async () => {
    stub = makeStubTmux();
    await Bun.write("/tmp/config-del.json", JSON.stringify(cfg));
    try { unlinkSync("/tmp/broker-del.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: {
        ...process.env,
        CLAUDE_PEERS_CONFIG: "/tmp/config-del.json",
        CLAUDE_PEERS_DB: "/tmp/broker-del.db",
        PATH: `${stub.dir}:${process.env.PATH}`, // stub tmux wins
      },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  afterAll(() => {
    proc?.kill();
    try { unlinkSync("/tmp/broker-del.db"); } catch {}
    try { unlinkSync("/tmp/config-del.json"); } catch {}
  });

  it("delivers to a tmux peer and marks accepted", async () => {
    const reg = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/d1", git_root: null, tty: null, summary: "",
      machine: "del-a", tailscale_ip: "127.0.0.1", tmux_pane: "%9", tmux_socket: null,
    }) as any;
    const send = await brokerFetch(PORT, "/send-message", {
      from_id: "dla-sender0", to_id: reg.id, text: "hello tmux",
    }) as any;
    expect(send.ok).toBe(true);
    expect(send.delivery).toBe("accepted");
    // poll returns nothing because the row was delivered (not queued)
    const poll = await brokerFetch(PORT, "/poll-messages", { id: reg.id }) as any;
    expect(poll.messages).toHaveLength(0);
    // the stub tmux recorded a send-keys for pane %9 carrying the formatted text
    const log = readFileSync(stub.logFile, "utf-8");
    expect(log).toContain("%9");
    expect(log).toContain("hello tmux");
  });

  it("leaves a none peer queued and retrievable via check_messages", async () => {
    const reg = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/d2", git_root: null, tty: null, summary: "",
      machine: "del-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null,
    }) as any;
    const send = await brokerFetch(PORT, "/send-message", {
      from_id: "dla-sender0", to_id: reg.id, text: "floor me",
    }) as any;
    expect(send.delivery).toBe("queued");
    const poll = await brokerFetch(PORT, "/poll-messages", { id: reg.id }) as any;
    expect(poll.messages).toHaveLength(1);
    expect(poll.messages[0].text).toBe("floor me");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/integration.test.ts -t "tmux delivery and floor"`
Expected: FAIL — `/register` rejects the unknown `tmux_pane` field / `send.delivery` is undefined / poll still returns the delivered row.

- [ ] **Step 3: Implement — `broker.ts`**

3a. Imports — add at the top (after the existing type import):

```ts
import {
  ensureMessagesTable, migrateMessagesSchema, resetDeliveringOnStart,
  generateLeaseToken, claimForDelivery, confirmDelivered, releaseToQueued,
  reclaimIfExpired, nextDeliverable, resolveTmuxTarget, formatPeerMessage,
  deliverViaTmux, type TmuxSpawn, type DeliverableRow,
} from "./delivery.ts";
import { PROTOCOL_VERSION } from "./shared/types.ts";
```

Remove the local `const PROTOCOL_VERSION = 1;` line.

3b. Schema — replace the `CREATE TABLE ... messages ...` block and add the migration + crash recovery right after the other `CREATE TABLE` calls:

```ts
  ensureMessagesTable(db);
  migrateMessagesSchema(db);
  const requeued = resetDeliveringOnStart(db);
  if (requeued > 0) console.error(`[claude-peers broker] requeued ${requeued} orphaned delivering row(s) on start`);
```

3c. Peers table — add the three local-only columns so registration can store them. Replace the `peers` CREATE with:

```ts
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
```

3d. Prepared statements — replace the message statements:

```ts
  const insertMessage = db.prepare(
    "INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)"
  );
  const selectQueued = db.prepare(
    "SELECT * FROM messages WHERE to_id = ? AND delivery_state = 'queued' ORDER BY id ASC"
  );
  const markPolled = db.prepare(
    "UPDATE messages SET delivery_state = 'delivered', lease_expires_at = NULL, lease_token = NULL WHERE id = ? AND delivery_state = 'queued'"
  );
  const insertReturningId = db.prepare(
    "INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?) RETURNING id"
  );
```

Update `insertPeer` to include the new columns:

```ts
  const insertPeer = db.prepare(`
    INSERT INTO peers (id, pid, machine, tailscale_ip, cwd, git_root, tty, summary, registered_at, last_seen, tmux_pane, tmux_socket, delivery_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
```

3e. Real tmux spawn + delivery context — add above the request handlers:

```ts
  const LEASE_MS = 5_000;        // > the 2s tmux attempt timeout
  const TMUX_TIMEOUT_MS = 2_000;
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

  // In-memory delivery guards (this process only).
  const activeRowIds = new Set<number>();
  const recipientsInFlight = new Set<string>();

  function peerDelivery(toId: string): { kind: string; pane: string | null; socket: string | null } | null {
    return db.query("SELECT delivery_kind AS kind, tmux_pane AS pane, tmux_socket AS socket FROM peers WHERE id = ?").get(toId) as any;
  }

  // Attempt to deliver the recipient's head-of-line row. Serial per recipient.
  // Returns the delivery disposition for an immediately-attempted send, or null
  // when nothing was attempted (blocked / no backend / already in flight).
  async function deliverNext(toId: string): Promise<"injected" | "accepted" | "queued" | null> {
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
```

Declare `let inFlightDeliveries = 0;` near the other daemon-scope state (used by Task 11 self-exit / Task 9 retire too).

3f. `handleRegister` — store delivery coordinates, loopback-gated (the loopback check itself is added in Task 8; here, accept and store the fields). Replace `handleRegister`:

```ts
  function handleRegister(body: RegisterRequest): RegisterResponse {
    const id = generatePeerId(config.id_prefix);
    const now = new Date().toISOString();
    const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
    if (existing) { deleteUndeliveredForPeer.run(existing.id); deletePeer.run(existing.id); }
    const target = resolveTmuxTarget({ TMUX_PANE: body.tmux_pane, TMUX: body.tmux_socket ? `${body.tmux_socket},0,0` : undefined });
    const pane = body.tmux_pane && /^%\d+$/.test(body.tmux_pane) ? body.tmux_pane : null;
    const socket = body.tmux_socket && body.tmux_socket.startsWith("/") ? body.tmux_socket : null;
    const kind = pane ? "tmux" : "none";
    insertPeer.run(id, body.pid, config.machine, config.tailscale_ip,
      body.cwd, body.git_root, body.tty, body.summary, now, now, pane, socket, kind);
    return { id };
  }
```

(The `resolveTmuxTarget` import is reused for validation symmetry; the explicit pane/socket validation above is what is persisted.)

3g. `handleSendMessage` — return `delivery` and attempt immediate delivery for a local target. Replace the local-target branch:

```ts
  async function handleSendMessage(body: SendMessageRequest): Promise<SendResult> {
    const localTarget = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id);
    if (localTarget) {
      insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
      const disposition = (await deliverNext(body.to_id)) ?? "queued";
      return { ok: true, routed: "local", delivery: disposition };
    }
    // ... remote forward branch unchanged ...
```

Import `SendResult` from `./shared/types.ts` and change the function's return type to `Promise<SendResult>`.

3h. `handleForwardMessage` — auto-inject by default; floor when configured. Replace the success branch:

```ts
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
    if (!config.floor_remote_forwards) await deliverNext(body.to_id);
    return { ok: true };
  }
```

Update the route to `await handleForwardMessage(body)`.

3i. `/poll-messages` — return and delete-from-queue only `queued` rows. Replace `handlePollMessages`:

```ts
  function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
    const messages = selectQueued.all(body.id) as Message[];
    for (const msg of messages) markPolled.run(msg.id);
    return { messages };
  }
```

3j. `/heartbeat` — drain the heartbeating recipient after recording liveness. Replace the heartbeat route:

```ts
          case "/heartbeat":
            updateLastSeen.run(new Date().toISOString(), body.id);
            // Drain this recipient's queued backlog in id order (serial per recipient).
            for (let i = 0; i < 50; i++) { if ((await deliverNext(body.id)) === null) break; }
            return Response.json({ ok: true });
```

3k. Remove `/peek-messages`, `/ack-messages`, `handlePeekMessages`, `handleAckMessages` (done in Task 13's deletion step; for now they can remain unused).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/integration.test.ts -t "tmux delivery and floor"`
Expected: PASS — `accepted` for the tmux peer (stub recorded `%9` + text), `queued` for the none peer (retrievable via poll).

- [ ] **Step 5: Run the full suite for regressions**

Run: `bun test`
Expected: PASS (existing federation tests still green; `delivered` no longer referenced).

- [ ] **Step 6: Commit**

```bash
git add broker.ts tests/integration.test.ts
git commit -m "Deliver via tmux backend with the lease, serial per recipient

Send and forward attempt immediate lease-claimed delivery to the recipient's
backend and report injected/accepted/queued; the heartbeat drains the
recipient's queued backlog in id order. A row reaches delivered only on
send-keys exit 0, never on an unconfirmed push. Cross-machine forwards
auto-inject unless floor_remote_forwards is set."
```

---

### Task 8: Loopback control-plane check for pane-carrying registration

**Files:**
- Modify: `broker.ts`
- Test: `tests/integration.test.ts`

- [ ] **Step 1: Write the failing test** (append to the `tmux delivery and floor` describe block)

The two-broker harness already exercises the allowlist with `127.0.0.1`. To test the loopback gate we register with a pane while spoofing a non-loopback but allowlisted source is not possible over a real socket from the test, so we assert the *positive* path (loopback pane accepted) and the *validation* path (a pane-carrying register is stored as `none` when the source is not loopback) via a unit-style check on the exported helper:

```ts
import { isLoopback } from "../delivery.ts";

describe("isLoopback", () => {
  it("accepts loopback addresses", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });
  it("rejects non-loopback", () => {
    expect(isLoopback("100.64.0.2")).toBe(false);
    expect(isLoopback("198.51.100.5")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/delivery.test.ts -t "isLoopback"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement — `delivery.ts` (append)**

```ts
/** True for loopback source addresses (control-plane registration must be local). */
export function isLoopback(ip: string): boolean {
  const n = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return n === "127.0.0.1" || n === "::1";
}
```

- [ ] **Step 4: Implement — `broker.ts`**

Pass the client IP into `/register` and drop pane fields when it is not loopback. In the `fetch` handler, the `/register` route becomes:

```ts
          case "/register": {
            const fromLoopback = isLoopback(clientIp);
            const safeBody = fromLoopback ? body : { ...body, tmux_pane: null, tmux_socket: null };
            if (!fromLoopback && (body.tmux_pane || body.tmux_socket)) {
              console.error(`[claude-peers broker] dropping pane coordinates from non-loopback register (${clientIp})`);
            }
            return Response.json(handleRegister(safeBody));
          }
```

Import `isLoopback` in the existing `delivery.ts` import block. The allowlist check at the top of `fetch` is unchanged; this loopback gate is independent of and in addition to it.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/delivery.test.ts -t "isLoopback"` then `bun test tests/integration.test.ts -t "tmux delivery and floor"`
Expected: PASS (loopback registration in the harness still works; pane stored).

- [ ] **Step 6: Commit**

```bash
git add delivery.ts broker.ts tests/delivery.test.ts
git commit -m "Gate pane-carrying registration to loopback

The allowlist authorizes federation routes, not pane assertion. A register
carrying tmux coordinates from a non-loopback source has them dropped, so a
remote allowlisted host can never make itself a send-keys target."
```

---

### Task 9: Broker version handshake and retire mode

**Files:**
- Modify: `broker.ts`, `server.ts`
- Test: `tests/integration.test.ts`

- [ ] **Step 1: Write the failing test** (new describe block in `tests/integration.test.ts`)

```ts
describe("broker version handshake", () => {
  const PORT = 17906;
  let proc: any;
  const cfg = { machine: "ver-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "vra", siblings: [], allowed_ips: ["127.0.0.1"] };

  beforeAll(async () => {
    await Bun.write("/tmp/config-ver.json", JSON.stringify(cfg));
    try { unlinkSync("/tmp/broker-ver.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-ver.json", CLAUDE_PEERS_DB: "/tmp/broker-ver.db" },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  });
  afterAll(() => { proc?.kill(); try { unlinkSync("/tmp/broker-ver.db"); } catch {} try { unlinkSync("/tmp/config-ver.json"); } catch {} });

  it("reports protocol_version on /health", async () => {
    const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json() as any;
    expect(h.protocol_version).toBe(2);
  });

  it("retire drains and exits even with a peer registered", async () => {
    await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/v1", git_root: null, tty: null, summary: "",
      machine: "ver-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null,
    });
    const r = await brokerFetch(PORT, "/retire", {}) as any;
    expect(r.ok).toBe(true);
    // After retire the port frees within a short window.
    let down = false;
    for (let i = 0; i < 20; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) }); }
      catch { down = true; break; }
      await new Promise((res) => setTimeout(res, 200));
    }
    expect(down).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/integration.test.ts -t "broker version handshake"`
Expected: FAIL — `/health` has no `protocol_version`; `/retire` is a 404.

- [ ] **Step 3: Implement — `broker.ts`**

3a. `/health` — add the version (in the non-POST branch):

```ts
        if (path === "/health") {
          return Response.json({
            status: "ok", protocol_version: PROTOCOL_VERSION,
            peers: (selectAllPeers.all() as any[]).length,
            machine: config.machine, remote_peer_count: (selectAllRemotePeers.all() as any[]).length,
          });
        }
```

3b. Retire mode — add daemon state and a handler. Near the daemon state:

```ts
  let retiring = false;
  let httpServer: ReturnType<typeof Bun.serve> | null = null;

  async function retire(): Promise<void> {
    retiring = true; // new register/send/forward now refused
    const deadline = Date.now() + 3_000;
    while (inFlightDeliveries > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    clearInterval(gossipTimer);
    clearInterval(cleanupTimer);
    try { await gossipToSiblings([]); } catch {}
    httpServer?.stop(true);
    db.close();
    process.exit(0);
  }
```

3c. Refuse new work while retiring and add the route. At the top of the POST switch, before the cases:

```ts
        if (retiring && (path === "/register" || path === "/send-message" || path === "/forward-message")) {
          return Response.json({ ok: false, error: "broker retiring" }, { status: 503 });
        }
```

Add the route:

```ts
          case "/retire": { void retire(); return Response.json({ ok: true }); }
```

3d. Capture the server handle: change `Bun.serve({...})` to `httpServer = Bun.serve({...})`.

- [ ] **Step 4: Implement — `server.ts`**

Add the required-version constant and the handshake to `ensureBroker`. Near the top constants:

```ts
import { PROTOCOL_VERSION as REQUIRED_BROKER_PROTOCOL } from "./shared/types.ts";
```

Replace the early-return in `ensureBroker`:

```ts
async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    const ver = await brokerProtocolVersion();
    if (ver !== null && ver >= REQUIRED_BROKER_PROTOCOL) {
      log("Broker already running");
      return;
    }
    log(`Stale broker (protocol ${ver ?? "?"} < ${REQUIRED_BROKER_PROTOCOL}); retiring it`);
    try {
      await fetch(`${BROKER_URL}/retire`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(2000) });
    } catch { /* it may exit before responding */ }
    // Wait for the port to free.
    let freed = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (!(await isBrokerAlive())) { freed = true; break; }
    }
    if (!freed) throw new Error("A stale claude-peers broker is running; run `bun cli.ts kill-broker` and retry.");
  }
  // ... existing spawn-and-wait logic unchanged ...
}
```

Add the helper:

```ts
async function brokerProtocolVersion(): Promise<number | null> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const h = await res.json() as { protocol_version?: number };
    return typeof h.protocol_version === "number" ? h.protocol_version : null;
  } catch { return null; }
}
```

(A `null` version means a pre-M1 broker that never reported one — treat as stale and retire.)

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/integration.test.ts -t "broker version handshake"`
Expected: PASS — `/health` reports `protocol_version: 2`; `/retire` drains and exits with a peer registered.

- [ ] **Step 6: Commit**

```bash
git add broker.ts server.ts tests/integration.test.ts
git commit -m "Add broker version handshake and a distinct retire mode

ensureBroker checks the running broker's protocol_version and, if stale,
retires it before relaunching — so a code upgrade self-activates instead of
silently talking to an old detached daemon. Retire is its own mode (refuse
new work, drain in-flight, exit even with peers registered), not idle
self-exit, which would never fire during an active upgrade."
```

---

### Task 10: Liveness — ESRCH vs EPERM, deletion decoupled from the probe

**Files:**
- Modify: `delivery.ts`, `broker.ts`
- Test: `tests/delivery.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/delivery.test.ts`)

```ts
import { isPidDead } from "../delivery.ts";

describe("isPidDead", () => {
  it("treats ESRCH as dead", () => {
    expect(isPidDead((e) => { (e as any).code = "ESRCH"; throw e; })).toBe(true);
  });
  it("treats EPERM (alive-but-foreign) as not dead", () => {
    expect(isPidDead((e) => { (e as any).code = "EPERM"; throw e; })).toBe(false);
  });
  it("treats a clean probe as alive", () => {
    expect(isPidDead(() => {})).toBe(false);
  });
});
```

(`isPidDead` takes a probe callback so the error code is injectable without real signals.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/delivery.test.ts -t "isPidDead"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement — `delivery.ts` (append)**

```ts
/**
 * Decide deadness from a process-existence probe. Only ESRCH (no such process)
 * counts as dead; EPERM/EACCES means alive-but-foreign and must NOT be treated as
 * dead. The probe is injected so tests can supply the error code.
 */
export function isPidDead(probe: (e: Error) => void): boolean {
  try { probe(new Error("probe")); return false; }
  catch (e: any) { return e?.code === "ESRCH"; }
}

/** The standard probe: signal 0 to a pid. */
export function pidProbe(pid: number): (e: Error) => void {
  return () => { process.kill(pid, 0); };
}
```

- [ ] **Step 4: Implement — `broker.ts`**

Replace `cleanStalePeers` and the `handleListPeers` filter so a probe failure never deletes messages. `cleanStalePeers` becomes:

```ts
  function cleanStalePeers() {
    const peers = db.query("SELECT id, pid, last_seen FROM peers").all() as { id: string; pid: number; last_seen: string }[];
    const staleCutoff = new Date(Date.now() - STALE_PEER_MS).toISOString();
    for (const peer of peers) {
      const dead = isPidDead(pidProbe(peer.pid));
      const stale = peer.last_seen < staleCutoff;
      if (dead || stale) {
        // Deregistration is the message-deletion trigger (not the probe itself).
        deleteUndeliveredForPeer.run(peer.id);
        deletePeer.run(peer.id);
      }
    }
    pruneRemotePeers(db, REMOTE_TTL_MS);
    pruneMessages(db, { deliveredTtlMs: DELIVERED_TTL_MS, queuedMaxAgeMs: QUEUED_MAX_AGE_MS, nowMs: Date.now() });
  }
```

In `handleListPeers`, change the filter so it does **not** delete on a probe throw — it only hides a dead peer from the listing; cleanup is `cleanStalePeers`' job:

```ts
    localPeers = localPeers
      .filter((p) => !isPidDead(pidProbe(p.pid)))
      .map((p) => ({ ...p, is_remote: false }));
```

Add the constants near the other timing constants:

```ts
const STALE_PEER_MS = 45_000;       // 3x heartbeat — a live session always heartbeats
const DELIVERED_TTL_MS = 60_000;
const QUEUED_MAX_AGE_MS = 24 * 60 * 60_000; // lossy backstop
```

`pruneMessages` is added in Task 11.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/delivery.test.ts -t "isPidDead"`
Expected: PASS. (`broker.ts` will not fully compile until Task 11 adds `pruneMessages`; that is the next task — do not run the full integration suite between Tasks 10 and 11.)

- [ ] **Step 6: Commit**

```bash
git add delivery.ts broker.ts tests/delivery.test.ts
git commit -m "Fix liveness: ESRCH is dead, EPERM is alive; decouple message deletion

A probe that throws EPERM (or a recycled foreign-uid pid, common on Windows)
no longer counts as dead and no longer deletes a peer's undelivered messages.
Deletion now fires only on deregistration or the prune, closing a silent
message-loss path."
```

---

### Task 11: Bounded retention prune

**Files:**
- Modify: `delivery.ts`, `broker.ts`
- Test: `tests/delivery.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/delivery.test.ts`)

```ts
import { pruneMessages } from "../delivery.ts";

const PDB = "/tmp/test-delivery-prune.db";
describe("pruneMessages", () => {
  let db: Database;
  beforeEach(() => { try { unlinkSync(PDB); } catch {} db = new Database(PDB); ensureMessagesTable(db); });
  afterEach(() => { db.close(); try { unlinkSync(PDB); } catch {} });

  it("removes delivered older than ttl and over-age queued, keeps fresh", () => {
    const now = Date.now();
    const old = new Date(now - 10 * 60_000).toISOString();
    const fresh = new Date(now).toISOString();
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivery_state) VALUES ('a','b','old-del',?,'delivered')", [old]);
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivery_state) VALUES ('a','b','fresh-del',?,'delivered')", [fresh]);
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivery_state) VALUES ('a','b','old-q',?,'queued')", [old]);
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivery_state) VALUES ('a','b','fresh-q',?,'queued')", [fresh]);

    const res = pruneMessages(db, { deliveredTtlMs: 60_000, queuedMaxAgeMs: 5 * 60_000, nowMs: now });
    expect(res.deliveredPruned).toBe(1);
    expect(res.queuedPruned).toBe(1);
    const texts = (db.query("SELECT text FROM messages ORDER BY id").all() as any[]).map((r) => r.text);
    expect(texts).toEqual(["fresh-del", "fresh-q"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/delivery.test.ts -t "pruneMessages"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement — `delivery.ts` (append)**

```ts
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
```

- [ ] **Step 4: Implement — `broker.ts`**

Log a lossy queued drop in `cleanStalePeers` (the call added in Task 10 stays; add the log):

```ts
    const pruned = pruneMessages(db, { deliveredTtlMs: DELIVERED_TTL_MS, queuedMaxAgeMs: QUEUED_MAX_AGE_MS, nowMs: Date.now() });
    if (pruned.queuedPruned > 0) console.error(`[claude-peers broker] dropped ${pruned.queuedPruned} over-age queued message(s) (lossy backstop)`);
```

Replace the bare `pruneMessages(...)` call from Task 10 with this logged form. Add `pruneMessages` to the `delivery.ts` import block.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/delivery.test.ts -t "pruneMessages"` then `bun test`
Expected: PASS (the whole suite — `broker.ts` now compiles with `pruneMessages` present).

- [ ] **Step 6: Commit**

```bash
git add delivery.ts broker.ts tests/delivery.test.ts
git commit -m "Bound message storage with a staleness sweep and a lossy backstop

A peer whose last_seen exceeds the staleness window is presumed gone and its
queued messages are pruned — non-lossy for a live session (heartbeats every
15s). A logged max-age cap on queued rows is the final backstop for any
crashed-and-never-heartbeated case the pid probe cannot bound."
```

---

### Task 12: The silent-consume regression test

**Files:**
- Modify: `tests/integration.test.ts`

This is the invariant the whole feature exists to protect; it must stay green forever.

- [ ] **Step 1: Write the test** (append to the `tmux delivery and floor` block — it uses a failing stub tmux)

Add a second broker started with a **failing** stub tmux (exit 1):

```ts
describe("silent-consume regression", () => {
  const PORT = 17907;
  let proc: any;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "fail-tmux-"));
    const stub = join(dir, "tmux");
    writeFileSync(stub, `#!/usr/bin/env bash\nexit 1\n`); // every send-keys fails
    chmodSync(stub, 0o755);
    await Bun.write("/tmp/config-reg.json", JSON.stringify({
      machine: "reg-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "rga", siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync("/tmp/broker-reg.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-reg.json", CLAUDE_PEERS_DB: "/tmp/broker-reg.db", PATH: `${dir}:${process.env.PATH}` },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  });
  afterAll(() => { proc?.kill(); try { unlinkSync("/tmp/broker-reg.db"); } catch {} try { unlinkSync("/tmp/config-reg.json"); } catch {} });

  it("a failing tmux push never marks the message delivered", async () => {
    const reg = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/reg1", git_root: null, tty: null, summary: "",
      machine: "reg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%4", tmux_socket: null,
    }) as any;
    const send = await brokerFetch(PORT, "/send-message", { from_id: "rga-x", to_id: reg.id, text: "must not vanish" }) as any;
    expect(send.delivery).toBe("queued"); // push failed => not accepted
    // The message is still retrievable — it was NOT silently consumed.
    const poll = await brokerFetch(PORT, "/poll-messages", { id: reg.id }) as any;
    expect(poll.messages).toHaveLength(1);
    expect(poll.messages[0].text).toBe("must not vanish");
  });
});
```

- [ ] **Step 2: Run to verify it passes** (the implementation already enforces this)

Run: `bun test tests/integration.test.ts -t "silent-consume regression"`
Expected: PASS — the failing push leaves the row `queued`, retrievable via poll.

- [ ] **Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "Lock in the silent-consume regression test

A push that tmux rejects (exit 1) must never mark the message delivered; it
stays queued and retrievable via check_messages. This reproduces the original
bug and must stay green forever."
```

---

### Task 13: Remove the dead push path from server.ts and broker.ts

**Files:**
- Modify: `server.ts`, `broker.ts`
- Test: `tests/integration.test.ts`

- [ ] **Step 1: Write the failing test** (append to the `tmux delivery and floor` block, or a small new block)

```ts
import { readFileSync as rfs } from "fs";

describe("dead push path removed", () => {
  it("server.ts has no poll loop, channel push, or CLAUDE_PEERS_CHANNEL", () => {
    const src = rfs("server.ts", "utf-8");
    expect(src).not.toContain("pollAndPushMessages");
    expect(src).not.toContain("CLAUDE_PEERS_CHANNEL");
    expect(src).not.toContain("notifications/claude/channel");
  });
  it("broker.ts no longer serves /peek-messages or /ack-messages", () => {
    const src = rfs("broker.ts", "utf-8");
    expect(src).not.toContain("/peek-messages");
    expect(src).not.toContain("/ack-messages");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/integration.test.ts -t "dead push path removed"`
Expected: FAIL — those strings are still present.

- [ ] **Step 3: Implement — `server.ts`**

- Delete the entire `pollAndPushMessages` function (lines ~405-467).
- In `main()`, delete the `channelEnabled` / `pollTimer` block and its `if (!channelEnabled)` log; delete `if (pollTimer) clearInterval(pollTimer);` from `cleanup`.
- Send the session's own tmux coordinates in the `/register` call:

```ts
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: "",
    machine: config.machine,
    tailscale_ip: config.tailscale_ip,
    tmux_pane: process.env.TMUX_PANE ?? null,
    tmux_socket: process.env.TMUX ? process.env.TMUX.split(",")[0] : null,
  });
```

- Surface `delivery` from `send_message` (replace the success return in the `send_message` case):

```ts
        const result = await brokerFetch<{ ok: boolean; error?: string; delivery?: string }>("/send-message", {
          from_id: myId, to_id, text: message,
        });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }], isError: true };
        }
        const how = result.delivery === "accepted" ? " (pushed to their session)"
                  : result.delivery === "injected" ? " (delivered)"
                  : " (queued; they'll see it on their next check)";
        return { content: [{ type: "text" as const, text: `Message sent to peer ${to_id}${how}` }] };
```

- The `POLL_INTERVAL_MS` constant and the `Peer`/`PollMessagesResponse` imports used only by the poll loop can be removed if now unused (leave imports still referenced by other handlers).

- [ ] **Step 4: Implement — `broker.ts`**

- Delete `handlePeekMessages` and `handleAckMessages`.
- Delete the `case "/peek-messages":` and `case "/ack-messages":` routes.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/integration.test.ts -t "dead push path removed"` then `bun test`
Expected: PASS (whole suite green; no channel/poll references remain).

- [ ] **Step 6: Commit**

```bash
git add server.ts broker.ts tests/integration.test.ts
git commit -m "Remove the broken channel push path and its dead endpoints

Deletes pollAndPushMessages, the CLAUDE_PEERS_CHANNEL gate, the
mcp.notification call, and the now-orphaned /peek-messages and /ack-messages
endpoints. The MCP server now reports its own tmux pane at registration and
surfaces the delivery disposition from send_message. check_messages remains."
```

---

### Task 14: Empty-broker self-exit (race-safe)

**Files:**
- Modify: `broker.ts`
- Test: `tests/integration.test.ts`

> **Checkpoint before implementing:** the broker is deployed under systemd (`deploy/claude-peers-broker.service`). If that unit uses `Restart=always`, idle self-exit will restart-loop. Confirm the unit's `Restart=` policy first; if it restarts unconditionally, either gate self-exit behind a config flag (default off for systemd nodes) or skip this task and track it as a follow-up. The spec lists self-exit under resource hygiene, but it must not fight the daemon supervisor.

- [ ] **Step 1: Write the failing test** (new describe block)

```ts
describe("empty-broker self-exit", () => {
  const PORT = 17908;
  let proc: any;
  beforeAll(async () => {
    await Bun.write("/tmp/config-exit.json", JSON.stringify({
      machine: "exit-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "exa", siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync("/tmp/broker-exit.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-exit.json", CLAUDE_PEERS_DB: "/tmp/broker-exit.db",
             CLAUDE_PEERS_IDLE_EXIT_MS: "1000" }, // short grace for the test
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  });
  afterAll(() => { proc?.kill(); try { unlinkSync("/tmp/broker-exit.db"); } catch {} try { unlinkSync("/tmp/config-exit.json"); } catch {} });

  it("exits after the idle window with zero peers", async () => {
    let down = false;
    for (let i = 0; i < 30; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) }); }
      catch { down = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(down).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/integration.test.ts -t "empty-broker self-exit"`
Expected: FAIL — the broker stays up indefinitely.

- [ ] **Step 3: Implement — `broker.ts`**

Add `lastActivityAt` tracking and an idle check. Near the daemon state:

```ts
  const IDLE_EXIT_MS = parseInt(process.env.CLAUDE_PEERS_IDLE_EXIT_MS ?? String(10 * 60_000), 10);
  let lastActivityAt = Date.now();
```

Bump `lastActivityAt = Date.now();` at the start of the POST branch (after parsing the body) and in the non-POST `/health` branch. Add an idle check inside the existing `cleanupTimer` callback (wrap `cleanStalePeers`):

```ts
  const cleanupTimer = setInterval(() => {
    cleanStalePeers();
    const livePeers = (selectAllPeers.all() as any[]).length;
    if (!retiring && livePeers === 0 && inFlightDeliveries === 0 && Date.now() - lastActivityAt > IDLE_EXIT_MS) {
      console.error("[claude-peers broker] idle with no peers; exiting");
      clearInterval(gossipTimer); clearInterval(cleanupTimer);
      try { httpServer?.stop(true); } catch {}
      db.close();
      process.exit(0);
    }
  }, CLEANUP_INTERVAL_MS);
```

Remove the old standalone `const cleanupTimer = setInterval(cleanStalePeers, CLEANUP_INTERVAL_MS);` line.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/integration.test.ts -t "empty-broker self-exit"`
Expected: PASS — the broker exits after the 1s idle window.

- [ ] **Step 5: Commit**

```bash
git add broker.ts tests/integration.test.ts
git commit -m "Add race-safe empty-broker self-exit

Exits only with zero live peers, zero in-flight deliveries, and an expired
idle window; any request refreshes the window. Independent of retire mode.
Idle window is env-tunable for tests and for systemd nodes that prefer a
longer or disabled grace."
```

---

### Task 15: Docs

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Update `CLAUDE.md`**

Add to the Architecture section that the broker now owns delivery via per-session backends (tmux + check_messages floor), the lease state machine, and the `delivery.ts` module. Note `PROTOCOL_VERSION = 2` and the version handshake. Note `floor_remote_forwards`.

- [ ] **Step 2: Update `README.md`**

- Remove the implication that `--dangerously-load-development-channels` is required for delivery (channel push is gone in M1; tmux delivery works with the plain `.mcp.json` setup).
- Document that a session in a tmux pane gets push automatically; a non-tmux session uses `check_messages`.
- Document `floor_remote_forwards`.

- [ ] **Step 3: Run the full suite + a type check**

Run: `bun test`
Expected: PASS (all unit + integration).

Run: `bunx tsc --noEmit` (typecheck)
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Document the M1 delivery model

The broker delivers via tmux + check_messages floor; channel push is gone.
Records the protocol-2 version handshake and the floor_remote_forwards opt-out."
```

---

## Self-review

**Spec coverage — every M1 spec section maps to a task:**

| Spec section | Task(s) |
|---|---|
| Per-message delivery state and lease | 2, 3 |
| Heartbeat drain and ordering | 6, 7 |
| Broker-restart crash recovery | 2 (reset on start wired in 7 step 3b) |
| Migration to delivery_state | 2 |
| Broker version handshake | 9 |
| The never-ack invariant | 3, 7, 12 |
| server.ts changes | 1, 9, 13 |
| broker.ts changes | 7, 8, 9, 10, 11 |
| shared/types.ts changes | 1 |
| Injected message format (tmux) | 4 |
| Error handling | 7, 10 |
| Security (loopback split, cross-machine rule) | 7 (forward rule), 8 (loopback) |
| Resource hygiene / cross-platform | 7 (tmuxAvailable), 10 (liveness), 14 (self-exit) |
| Memory and storage (retention) | 11 |
| Testing | every task; regression in 12 |
| What gets deleted | 13 |

**Type/signature consistency check:** `delivery.ts` exports used identically across tasks — `claimForDelivery(db,id,nowMs,leaseMs,token)`, `confirmDelivered(db,id,token)`, `releaseToQueued(db,id,token)`, `reclaimIfExpired(db,id,nowMs)`, `nextDeliverable(db,toId,nowMs,Set)`, `deliverViaTmux(pane,socket,text,spawn)`, `formatPeerMessage({id,from_id,text})`, `resolveTmuxTarget({TMUX,TMUX_PANE})`, `isLoopback(ip)`, `isPidDead(probe)`, `pruneMessages(db,{deliveredTtlMs,queuedMaxAgeMs,nowMs})`. `PROTOCOL_VERSION` is defined once in `shared/types.ts` and imported by `broker.ts` (Task 7) and `server.ts` (Task 9). `SendResult.delivery` values `injected|accepted|queued` match `deliverNext`'s return union.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every test step shows the assertion and the exact `bun test -t` command with expected result.

**Build-order note:** `broker.ts` does not fully compile between Task 10 and Task 11 (it references `pruneMessages`, added in Task 11). Tasks 10 and 11 should be done back-to-back; run the full suite only at the end of Task 11. This is called out in Task 10 Step 5.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-03-reliable-peer-delivery-m1.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, two-stage review between tasks, fast iteration. REQUIRED SUB-SKILL: superjawn:subagent-driven-development.
2. **Inline Execution** — execute tasks in this session with checkpoints. REQUIRED SUB-SKILL: superjawn:executing-plans.

Each task ends with a codex gpt-5.4/low review gate on its diff per the repo's PR workflow before the work is considered done.
