// tests/broker.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import {
  generatePeerId,
  isAllowedIp,
  mergeGossipPeers,
  pruneRemotePeers,
  resolveTargetBroker,
} from "../broker.ts";

const TEST_DB = "/tmp/test-claude-peers-unit.db";

function createTestDb(): Database {
  const db = new Database(TEST_DB);
  db.run("PRAGMA journal_mode = WAL");

  db.run(`CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY, pid INTEGER NOT NULL, machine TEXT NOT NULL,
    tailscale_ip TEXT NOT NULL, cwd TEXT NOT NULL, git_root TEXT,
    tty TEXT, summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS remote_peers (
    id TEXT PRIMARY KEY, machine TEXT NOT NULL, tailscale_ip TEXT NOT NULL,
    pid INTEGER NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
    summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL,
    to_id TEXT NOT NULL, text TEXT NOT NULL, sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )`);

  return db;
}

describe("generatePeerId", () => {
  it("generates IDs with the correct prefix", () => {
    const id = generatePeerId("hoj");
    expect(id).toMatch(/^hoj-[a-z0-9]{8}$/);
  });

  it("generates different IDs across calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generatePeerId("tst")));
    expect(ids.size).toBe(100);
  });
});

describe("isAllowedIp", () => {
  const ALLOWED = ["127.0.0.1", "100.64.0.1", "100.64.0.2", "100.64.0.3"];

  it("allows listed IPs", () => {
    expect(isAllowedIp("127.0.0.1", ALLOWED)).toBe(true);
    expect(isAllowedIp("100.64.0.1", ALLOWED)).toBe(true);
  });

  it("rejects unlisted IPs", () => {
    expect(isAllowedIp("192.168.1.100", ALLOWED)).toBe(false);
    expect(isAllowedIp("8.8.8.8", ALLOWED)).toBe(false);
  });

  it("handles IPv6-mapped IPv4", () => {
    expect(isAllowedIp("::ffff:127.0.0.1", ALLOWED)).toBe(true);
    expect(isAllowedIp("::ffff:8.8.8.8", ALLOWED)).toBe(false);
  });
});

describe("mergeGossipPeers", () => {
  let db: Database;
  beforeEach(() => { try { unlinkSync(TEST_DB); } catch {} db = createTestDb(); });
  afterEach(() => { db.close(); try { unlinkSync(TEST_DB); } catch {} });

  it("inserts new remote peers", () => {
    const now = new Date().toISOString();
    mergeGossipPeers(db, [
      { id: "ofj-aaaa1111", pid: 1000, machine: "host-b", tailscale_ip: "100.64.0.2",
        cwd: "/home/peer", git_root: null, tty: null, summary: "working on bot",
        registered_at: now, last_seen: now, is_remote: false },
    ], "host-b", "100.64.0.2");

    const result = db.query("SELECT * FROM remote_peers").all() as any[];
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ofj-aaaa1111");
    expect(result[0].summary).toBe("working on bot");
  });

  it("updates existing remote peers on re-gossip", () => {
    const now = new Date().toISOString();
    mergeGossipPeers(db, [
      { id: "ofj-aaaa1111", pid: 1000, machine: "host-b", tailscale_ip: "100.64.0.2",
        cwd: "/tmp/old", git_root: null, tty: null, summary: "old summary",
        registered_at: now, last_seen: now, is_remote: false },
    ], "host-b", "100.64.0.2");

    mergeGossipPeers(db, [
      { id: "ofj-aaaa1111", pid: 1000, machine: "host-b", tailscale_ip: "100.64.0.2",
        cwd: "/tmp/new", git_root: null, tty: null, summary: "new summary",
        registered_at: now, last_seen: now, is_remote: false },
    ], "host-b", "100.64.0.2");

    const result = db.query("SELECT * FROM remote_peers").all() as any[];
    expect(result).toHaveLength(1);
    expect(result[0].cwd).toBe("/tmp/new");
    expect(result[0].summary).toBe("new summary");
  });
});

describe("pruneRemotePeers", () => {
  let db: Database;
  beforeEach(() => { try { unlinkSync(TEST_DB); } catch {} db = createTestDb(); });
  afterEach(() => { db.close(); try { unlinkSync(TEST_DB); } catch {} });

  it("removes peers older than TTL, keeps fresh ones", () => {
    const stale = new Date(Date.now() - 60_000).toISOString();
    const fresh = new Date().toISOString();

    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["ofj-stale111", "host-b", "100.64.0.2", 1000, "/tmp", "", stale, stale]);
    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["leg-fresh222", "host-c", "100.64.0.3", 2000, "/tmp", "", fresh, fresh]);

    const pruned = pruneRemotePeers(db, 30_000);
    expect(pruned).toBe(1);

    const remaining = db.query("SELECT * FROM remote_peers").all() as any[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("leg-fresh222");
  });
});

describe("resolveTargetBroker", () => {
  let db: Database;
  beforeEach(() => { try { unlinkSync(TEST_DB); } catch {} db = createTestDb(); });
  afterEach(() => { db.close(); try { unlinkSync(TEST_DB); } catch {} });

  const siblings = [
    { machine: "host-b", url: "http://100.64.0.2:7899" },
    { machine: "host-c", url: "http://100.64.0.3:7899" },
  ];

  it("returns sibling URL for a known remote peer", () => {
    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["ofj-target11", "host-b", "100.64.0.2", 1000, "/tmp", "", new Date().toISOString(), new Date().toISOString()]);

    expect(resolveTargetBroker(db, "ofj-target11", siblings)).toBe("http://100.64.0.2:7899");
  });

  it("returns null for unknown peer ID", () => {
    expect(resolveTargetBroker(db, "xxx-unknown1", siblings)).toBeNull();
  });
});
