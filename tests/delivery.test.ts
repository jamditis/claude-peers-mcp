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
