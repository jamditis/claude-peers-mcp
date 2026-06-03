import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import { ensureMessagesTable, migrateMessagesSchema } from "../delivery.ts";
import {
  generateLeaseToken, claimForDelivery, confirmDelivered,
  releaseToQueued, resetDeliveringOnStart, reclaimIfExpired,
} from "../delivery.ts";
import { resolveTmuxTarget, formatPeerMessage, PASTE_START, PASTE_END } from "../delivery.ts";
import { deliverViaTmux, buildTmuxArgs, type TmuxSpawn } from "../delivery.ts";
import { nextDeliverable, isLoopback, isFederationRoute, isPidDead, pruneMessages } from "../delivery.ts";

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

  it("finishes a partially-migrated table (new columns present, delivered not yet dropped)", () => {
    // Models a crash between ADD COLUMN and DROP COLUMN: both old and new columns exist.
    const db = new Database(DB);
    db.run(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
      text TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
      delivery_state TEXT NOT NULL DEFAULT 'queued', lease_expires_at INTEGER, lease_token TEXT
    )`);
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivered) VALUES ('a','b','hi',?,1)", [new Date().toISOString()]);

    migrateMessagesSchema(db);

    const c = cols(db);
    expect(c).not.toContain("delivered");
    expect(c).toContain("delivery_state");
    const row = db.query("SELECT delivery_state FROM messages").get() as { delivery_state: string };
    expect(row.delivery_state).toBe("delivered");
    db.close();
  });
});

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

  // The invariant this whole state machine exists to protect: a stale token from a
  // timed-out attempt must never flip a row that has since been re-leased.
  it("a stale confirmation after expiry and re-claim is a no-op", () => {
    const id = insert(db, "b");
    claimForDelivery(db, id, 1000, 5000, "tok1"); // expires at 6000
    expect(reclaimIfExpired(db, id, 7000)).toBe(true);
    expect(claimForDelivery(db, id, 7000, 5000, "tok2")).toBe(true);
    expect(confirmDelivered(db, id, "tok1")).toBe(false); // stale token loses
    expect(state(db, id).delivery_state).toBe("delivering");
    expect(state(db, id).lease_token).toBe("tok2");
    expect(confirmDelivered(db, id, "tok2")).toBe(true); // current holder wins
    expect(state(db, id).delivery_state).toBe("delivered");
  });

  it("reclaimIfExpired fires at exactly the lease deadline (<=)", () => {
    const id = insert(db, "b");
    claimForDelivery(db, id, 1000, 5000, "tok1"); // expires at 6000
    expect(reclaimIfExpired(db, id, 6000)).toBe(true); // boundary is inclusive
    expect(state(db, id).delivery_state).toBe("queued");
  });
});

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
    const out = formatPeerMessage({ id: 7, from_id: "ofj-abc", text: "ping" });
    expect(out.startsWith(PASTE_START)).toBe(true);
    expect(out.endsWith(PASTE_END)).toBe(true);
    expect(out).toContain("[peer ofj-abc #7] ping");
    expect(out).toContain('(reply: send_message to_id="ofj-abc")');
  });
  it("keeps embedded newlines inside the paste wrap", () => {
    const out = formatPeerMessage({ id: 1, from_id: "x", text: "a\nb" });
    expect(out).toContain("a\nb");
    expect(out.indexOf("\n")).toBeGreaterThan(out.indexOf(PASTE_START));
  });
  it("strips control bytes so peer text cannot break out of the paste wrap", () => {
    // A peer that smuggles the PASTE_END sequence + a newline could otherwise close
    // the paste early and have the tail land as live keystrokes in the recipient.
    const out = formatPeerMessage({ id: 1, from_id: "x", text: "evil\x1b[201~\nrm -rf safe" });
    // The only PASTE_END left is the wrapper at the very end — none smuggled via text.
    expect(out.indexOf(PASTE_END)).toBe(out.lastIndexOf(PASTE_END));
    expect(out.endsWith(PASTE_END)).toBe(true);
    expect(out).not.toContain("\x1b[201~\n"); // the breakout sequence is gone
    expect(out).toContain("rm -rf safe");     // text survives, defanged not deleted
  });
  it("strips control bytes from from_id too", () => {
    const out = formatPeerMessage({ id: 2, from_id: "x\x1b[201~", text: "hi" });
    expect(out.indexOf(PASTE_END)).toBe(out.lastIndexOf(PASTE_END)); // still only the wrapper
  });
  it("strips the C1 single-byte CSI (0x9b) so it cannot stand in for ESC[ paste-END", () => {
    // 0x9b is CSI; on an 8-bit-clean terminal "\x9b201~" closes bracketed paste just
    // like "\x1b[201~". Stripping ESC alone would miss it.
    const out = formatPeerMessage({ id: 3, from_id: "x", text: "evil\x9b201~\nrm -rf safe" });
    expect(out).not.toContain("\x9b");
    expect(out.indexOf(PASTE_END)).toBe(out.lastIndexOf(PASTE_END)); // only the wrapper
    expect(out).toContain("rm -rf safe");
  });
});

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

describe("isLoopback", () => {
  it("accepts loopback addresses", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });
  it("rejects non-loopback", () => {
    expect(isLoopback("100.84.214.24")).toBe(false);
    expect(isLoopback("192.168.1.5")).toBe(false);
  });
  it("rejects the broker's unknown-address sentinel", () => {
    // broker.ts falls back to "unknown" when server.requestIP returns null;
    // a request with no socket address must never count as loopback.
    expect(isLoopback("unknown")).toBe(false);
  });
});

describe("isFederationRoute", () => {
  it("exempts only the two federation routes from the loopback gate", () => {
    expect(isFederationRoute("/gossip")).toBe(true);
    expect(isFederationRoute("/forward-message")).toBe(true);
  });
  it("treats every control-plane route as loopback-only (not federation)", () => {
    // These all drive a local session — a remote allowlisted sibling must never reach them.
    // /send-message and /heartbeat type into a local tmux pane; /register asserts a delivery
    // target; /poll-messages drains a queue; /retire kills the broker.
    for (const path of ["/register", "/heartbeat", "/set-summary", "/list-peers",
      "/send-message", "/poll-messages", "/unregister", "/retire", "/health", "/unknown", "/"]) {
      expect(isFederationRoute(path)).toBe(false);
    }
  });
});

describe("isPidDead", () => {
  it("treats ESRCH as dead", () => {
    expect(isPidDead(() => { const e: any = new Error("gone"); e.code = "ESRCH"; throw e; })).toBe(true);
  });
  it("treats EPERM (alive-but-foreign) as not dead", () => {
    expect(isPidDead(() => { const e: any = new Error("foreign"); e.code = "EPERM"; throw e; })).toBe(false);
  });
  it("treats a clean probe as alive", () => {
    expect(isPidDead(() => {})).toBe(false);
  });
});

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

  it("never prunes a delivering row, however old (it is an active lease)", () => {
    const now = Date.now();
    const old = new Date(now - 60 * 60_000).toISOString();
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivery_state) VALUES ('a','b','in-flight',?,'delivering')", [old]);
    const res = pruneMessages(db, { deliveredTtlMs: 60_000, queuedMaxAgeMs: 5 * 60_000, nowMs: now });
    expect(res.deliveredPruned).toBe(0);
    expect(res.queuedPruned).toBe(0);
    const texts = (db.query("SELECT text FROM messages").all() as any[]).map((r) => r.text);
    expect(texts).toEqual(["in-flight"]);
  });
});
