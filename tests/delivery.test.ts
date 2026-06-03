import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import { ensureMessagesTable, migrateMessagesSchema } from "../delivery.ts";
import {
  generateLeaseToken, claimForDelivery, confirmDelivered,
  releaseToQueued, resetDeliveringOnStart, reclaimIfExpired,
} from "../delivery.ts";

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
