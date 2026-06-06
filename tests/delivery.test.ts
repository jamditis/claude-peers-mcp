import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { ensureMessagesTable, migrateMessagesSchema } from "../delivery.ts";
import {
  claimForDelivery, confirmDelivered, isMessageDelivered,
  releaseToQueued, resetDeliveringOnStart, reclaimIfExpired, findLeaklessDelivering,
  reclaimLeaklessDelivering,
} from "../delivery.ts";
import { resolveTmuxTarget, formatPeerMessage, PASTE_START, PASTE_END } from "../delivery.ts";
import { deliverViaTmux, buildTmuxArgs, type TmuxSpawn } from "../delivery.ts";
import { nextDeliverable, isLoopback, isFederationRoute, isPidDead, pruneMessages, releasableQueuedPrefix } from "../delivery.ts";

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
// Construct the issue #10 corrupt state (a delivering row with no lease). The create-path
// CHECK rejects it, so model its real-world provenance — a migrated legacy table or a write
// that bypassed the constraint — by suspending the CHECK for just this raw UPDATE.
function rawNullLease(db: Database, id: number): void {
  db.run("PRAGMA ignore_check_constraints = ON");
  try { db.run("UPDATE messages SET lease_expires_at=NULL WHERE id=?", [id]); }
  finally { db.run("PRAGMA ignore_check_constraints = OFF"); }
}

// The other half of the holderless shape: a future lease_expires_at with no token (a legacy
// 'delivering' row migrated onto a table that never got the CHECK). Only a raw write makes it.
function rawNullToken(db: Database, id: number): void {
  db.run("PRAGMA ignore_check_constraints = ON");
  try { db.run("UPDATE messages SET lease_token=NULL WHERE id=?", [id]); }
  finally { db.run("PRAGMA ignore_check_constraints = OFF"); }
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

  // Issue #14: reporting a forward's own disposition reads the specific row's state, so a
  // queued or in-flight row is not "delivered" — only a confirmed one is.
  it("isMessageDelivered is true only for a row in the delivered state", () => {
    const id = insert(db, "b");
    expect(isMessageDelivered(db, id)).toBe(false);       // queued
    claimForDelivery(db, id, 1000, 5000, "tok1");
    expect(isMessageDelivered(db, id)).toBe(false);       // delivering
    confirmDelivered(db, id, "tok1");
    expect(isMessageDelivered(db, id)).toBe(true);        // delivered
    expect(isMessageDelivered(db, 9999)).toBe(false);     // absent row
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

  // Issue #10: a delivering row whose lease was raw-nulled out (the only way the corrupt
  // state arises) has no live claim, so it must be reclaimable — otherwise it jams the head.
  it("reclaims a delivering row whose lease was nulled out (orphaned, no live claim)", () => {
    const id = insert(db, "b");
    claimForDelivery(db, id, 1000, 5000, "tok1");           // delivering, lease=6000
    // Construct the corrupt NULL-lease delivering state with a raw UPDATE (the only way it arises).
    rawNullLease(db, id);
    expect(state(db, id).delivery_state).toBe("delivering");
    expect(state(db, id).lease_expires_at).toBeNull();
    expect(reclaimIfExpired(db, id, 7000)).toBe(true);       // FAILS before the fix (guard returns false)
    expect(state(db, id).delivery_state).toBe("queued");
    expect(state(db, id).lease_token).toBeNull();
  });

  it("does not reclaim a delivering row whose lease is still in the future (NULL-relaxation must not reclaim live)", () => {
    const id = insert(db, "b");
    claimForDelivery(db, id, 1000, 5000, "tok1");           // lease=6000, not yet expired
    expect(reclaimIfExpired(db, id, 5000)).toBe(false);      // still passes after the fix
    expect(state(db, id).delivery_state).toBe("delivering");
  });

  it("findLeaklessDelivering counts a NULL-lease delivering row", () => {
    const id = insert(db, "b");
    claimForDelivery(db, id, 1000, 5000, "tok1");
    expect(findLeaklessDelivering(db)).toBe(0);
    rawNullLease(db, id);
    expect(findLeaklessDelivering(db)).toBe(1);
  });

  // The periodic sweep — not the delivery path — is what unjams a pull-only recipient: deliverNext
  // bails at its tmux backend gate before reclaiming, and a poll stops at the delivering head, so
  // an orphaned head would sit until a restart. reclaimLeaklessDelivering requeues it in the sweep.
  it("reclaimLeaklessDelivering requeues every orphaned (NULL-lease) delivering row", () => {
    const a = insert(db, "b"); const c = insert(db, "b");
    claimForDelivery(db, a, 1000, 5000, "t1");
    claimForDelivery(db, c, 1000, 5000, "t2");
    rawNullLease(db, a); rawNullLease(db, c); // orphan both heads (the only way the corrupt state arises)
    expect(findLeaklessDelivering(db)).toBe(2);
    expect(reclaimLeaklessDelivering(db)).toBe(2);
    expect(findLeaklessDelivering(db)).toBe(0);
    expect(state(db, a).delivery_state).toBe("queued");
    expect(state(db, c).delivery_state).toBe("queued");
  });

  // Safety boundary: the sweep must touch only orphans, never a live attempt holding a future lease.
  it("reclaimLeaklessDelivering leaves a live (future-lease) delivering row alone", () => {
    const id = insert(db, "b");
    claimForDelivery(db, id, 1000, 5000, "tok1"); // lease=6000, a live attempt
    expect(reclaimLeaklessDelivering(db)).toBe(0);
    expect(state(db, id).delivery_state).toBe("delivering");
    expect(state(db, id).lease_token).toBe("tok1");
  });

  // The holderless invariant has two halves — null lease_expires_at OR null lease_token — and must
  // match the create-path CHECK. A future-lease/null-token row has no token that can ever confirm or
  // release it, yet nextDeliverable reads the future lease as live and blocks the queue until that
  // timestamp. The runtime defense (the only enforcement on a CHECK-less legacy table) must catch it.
  it("findLeaklessDelivering and reclaimLeaklessDelivering catch a future-lease, null-token row", () => {
    const id = insert(db, "b");
    claimForDelivery(db, id, 1000, 5000, "tok1"); // delivering, lease=6000 (future), token set
    rawNullToken(db, id);                          // holderless: token gone, lease still in the future
    expect(state(db, id).lease_expires_at).not.toBeNull();
    expect(state(db, id).lease_token).toBeNull();
    expect(findLeaklessDelivering(db)).toBe(1);    // FAILS before the predicate covers null token
    expect(reclaimLeaklessDelivering(db)).toBe(1); // FAILS before the predicate covers null token
    expect(state(db, id).delivery_state).toBe("queued");
  });

  // The create-path CHECK enforces 'delivering' => a live claim: a non-null lease AND a
  // non-null token. A future lease with no token still has no holder that can confirm or
  // release the row, so a raw write of that shape must be rejected on a fresh table.
  it("the create-path CHECK rejects a delivering row with no lease token (holderless)", () => {
    const id = insert(db, "b"); // queued
    expect(() => db.run(
      "UPDATE messages SET delivery_state='delivering', lease_expires_at=? WHERE id=?",
      [9999, id],
    )).toThrow();
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

  // Issue #10: an orphaned NULL-lease delivering head must be reclaimable so younger mail
  // behind it is not blocked head-of-line forever.
  it("an orphaned NULL-lease delivering head is reclaimable and unblocks younger mail", () => {
    const a = ins(db, "b"); ins(db, "b");                  // a is the older head; a younger row sits behind it
    claimForDelivery(db, a, 1000, 5000, "t1");
    rawNullLease(db, a); // orphan the head (suspends the create-path CHECK, as in production legacy DBs)
    // nextDeliverable already returns it (live=false) — that part is not the bug:
    const row = nextDeliverable(db, "b", 7000, new Set());
    expect(row!.id).toBe(a);
    expect(row!.delivery_state).toBe("delivering");
    // The fix: reclaimIfExpired must now actually reclaim it so the consumer can proceed.
    expect(reclaimIfExpired(db, a, 7000)).toBe(true);       // FAILS before the fix
    expect(nextDeliverable(db, "b", 7000, new Set())!.id).toBe(a); // now a queued, deliverable head
  });
});

describe("releasableQueuedPrefix", () => {
  const row = (id: number, s: string) => ({ id, delivery_state: s });
  it("releases all rows when nothing is in flight", () => {
    const out = releasableQueuedPrefix([row(1, "queued"), row(2, "queued"), row(3, "queued")]);
    expect(out.map((r) => r.id)).toEqual([1, 2, 3]);
  });
  it("releases nothing when the head is delivering", () => {
    // The oldest pending row is mid-tmux-send; a poll must not hand out the younger queued
    // rows behind it, or a requeue-on-failure would reorder them.
    const out = releasableQueuedPrefix([row(1, "delivering"), row(2, "queued"), row(3, "queued")]);
    expect(out).toHaveLength(0);
  });
  it("releases only the contiguous queued prefix before the first delivering row", () => {
    const out = releasableQueuedPrefix([row(1, "queued"), row(2, "queued"), row(3, "delivering"), row(4, "queued")]);
    expect(out.map((r) => r.id)).toEqual([1, 2]);
  });
  it("returns empty for no pending rows", () => {
    expect(releasableQueuedPrefix([])).toHaveLength(0);
  });
});

describe("isLoopback", () => {
  it("accepts loopback addresses", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });
  it("rejects non-loopback", () => {
    expect(isLoopback("100.64.0.2")).toBe(false);
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
    // A real delivering row holds a live claim — a non-null lease AND token (the invariant
    // the create-path CHECK enforces); supply both.
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivery_state,lease_expires_at,lease_token) VALUES ('a','b','in-flight',?,'delivering',?,'tok')", [old, now + 5000]);
    const res = pruneMessages(db, { deliveredTtlMs: 60_000, queuedMaxAgeMs: 5 * 60_000, nowMs: now });
    expect(res.deliveredPruned).toBe(0);
    expect(res.queuedPruned).toBe(0);
    const texts = (db.query("SELECT text FROM messages").all() as any[]).map((r) => r.text);
    expect(texts).toEqual(["in-flight"]);
  });
});
