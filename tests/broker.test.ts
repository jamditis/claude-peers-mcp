// tests/broker.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import {
  generatePeerId,
  isAllowedIp,
  mergeGossipPeers,
  pruneRemotePeers,
  recordGossipResult,
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
  const ALLOWED = ["127.0.0.1", "100.122.208.15", "100.84.214.24", "100.108.24.67"];

  it("allows listed IPs", () => {
    expect(isAllowedIp("127.0.0.1", ALLOWED)).toBe(true);
    expect(isAllowedIp("100.122.208.15", ALLOWED)).toBe(true);
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
      { id: "ofj-aaaa1111", pid: 1000, machine: "officejawn", tailscale_ip: "100.84.214.24",
        cwd: "/home/jamditis", git_root: null, tty: null, summary: "working on bot",
        registered_at: now, last_seen: now, is_remote: false },
    ], "officejawn", "100.84.214.24");

    const result = db.query("SELECT * FROM remote_peers").all() as any[];
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ofj-aaaa1111");
    expect(result[0].summary).toBe("working on bot");
  });

  it("updates existing remote peers on re-gossip", () => {
    const now = new Date().toISOString();
    mergeGossipPeers(db, [
      { id: "ofj-aaaa1111", pid: 1000, machine: "officejawn", tailscale_ip: "100.84.214.24",
        cwd: "/tmp/old", git_root: null, tty: null, summary: "old summary",
        registered_at: now, last_seen: now, is_remote: false },
    ], "officejawn", "100.84.214.24");

    mergeGossipPeers(db, [
      { id: "ofj-aaaa1111", pid: 1000, machine: "officejawn", tailscale_ip: "100.84.214.24",
        cwd: "/tmp/new", git_root: null, tty: null, summary: "new summary",
        registered_at: now, last_seen: now, is_remote: false },
    ], "officejawn", "100.84.214.24");

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
      ["ofj-stale111", "officejawn", "100.84.214.24", 1000, "/tmp", "", stale, stale]);
    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["leg-fresh222", "legion2025", "100.108.24.67", 2000, "/tmp", "", fresh, fresh]);

    const pruned = pruneRemotePeers(db, 30_000);
    expect(pruned).toBe(1);

    const remaining = db.query("SELECT * FROM remote_peers").all() as any[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("leg-fresh222");
  });
});

describe("recordGossipResult", () => {
  const SUMMARY_INTERVAL_MS = 5 * 60 * 1000;
  const T0 = 1_000_000_000_000;

  it("healthy stays silent", () => {
    const result = recordGossipResult(null, true, "", "officejawn", T0, SUMMARY_INTERVAL_MS);
    expect(result.state).toBeNull();
    expect(result.logLine).toBeNull();
  });

  it("first failure logs immediately and initializes state", () => {
    const result = recordGossipResult(null, false, "The operation timed out.", "legion2025", T0, SUMMARY_INTERVAL_MS);
    expect(result.state).toEqual({
      firstFailureAt: T0,
      lastSummaryAt: T0,
      failureCount: 1,
    });
    expect(result.logLine).toBe("Gossip to legion2025 failed: The operation timed out.");
  });

  it("continuing failure within summary interval is silent", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 1 };
    const result = recordGossipResult(prev, false, "timeout", "legion2025", T0 + 5_000, SUMMARY_INTERVAL_MS);
    expect(result.state).toEqual({
      firstFailureAt: T0,
      lastSummaryAt: T0,
      failureCount: 2,
    });
    expect(result.logLine).toBeNull();
  });

  it("continuing failure past summary interval logs a summary and updates lastSummaryAt", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 60 };
    const result = recordGossipResult(prev, false, "timeout", "legion2025", T0 + SUMMARY_INTERVAL_MS, SUMMARY_INTERVAL_MS);
    expect(result.state?.lastSummaryAt).toBe(T0 + SUMMARY_INTERVAL_MS);
    expect(result.state?.failureCount).toBe(61);
    expect(result.logLine).toBe("Gossip to legion2025 still failing: 61 failures over 5m (latest: timeout)");
  });

  it("recovery logs and clears state", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 60 };
    const result = recordGossipResult(prev, true, "", "legion2025", T0 + 5 * 60_000, SUMMARY_INTERVAL_MS);
    expect(result.state).toBeNull();
    expect(result.logLine).toBe("Gossip to legion2025 recovered after 60 failures over 5m");
  });

  it("recovery after a single failure pluralizes correctly", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 1 };
    const result = recordGossipResult(prev, true, "", "officejawn", T0 + 5_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toBe("Gossip to officejawn recovered after 1 failure over 5s");
  });

  it("formats sub-minute durations in seconds", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 5 };
    const result = recordGossipResult(prev, true, "", "officejawn", T0 + 30_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 30s");
  });

  it("formats sub-hour durations in minutes", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 50 };
    const result = recordGossipResult(prev, true, "", "officejawn", T0 + 47 * 60_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 47m");
  });

  it("formats multi-hour durations in hours with one decimal", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 999 };
    const result = recordGossipResult(prev, true, "", "officejawn", T0 + 90 * 60_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 1.5h");
  });

  it("formats just-under-a-minute as Xs, never rounding up to 60s", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 5 };
    const result = recordGossipResult(prev, true, "", "officejawn", T0 + 59_999, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 59s");
    expect(result.logLine).not.toContain("over 60s");
  });

  it("formats just-under-an-hour as Xm, never rounding up to 60m", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 5 };
    const result = recordGossipResult(prev, true, "", "officejawn", T0 + 3_599_999, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 59m");
    expect(result.logLine).not.toContain("over 60m");
  });

  it("formats exactly-one-minute as 1m (boundary into minute branch)", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 5 };
    const result = recordGossipResult(prev, true, "", "officejawn", T0 + 60_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 1m");
  });

  it("formats exactly-one-hour as 1.0h (boundary into hour branch)", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 5 };
    const result = recordGossipResult(prev, true, "", "officejawn", T0 + 3_600_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 1.0h");
  });
});

describe("resolveTargetBroker", () => {
  let db: Database;
  beforeEach(() => { try { unlinkSync(TEST_DB); } catch {} db = createTestDb(); });
  afterEach(() => { db.close(); try { unlinkSync(TEST_DB); } catch {} });

  const siblings = [
    { machine: "officejawn", url: "http://100.84.214.24:7899" },
    { machine: "legion2025", url: "http://100.108.24.67:7899" },
  ];

  it("returns sibling URL for a known remote peer", () => {
    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["ofj-target11", "officejawn", "100.84.214.24", 1000, "/tmp", "", new Date().toISOString(), new Date().toISOString()]);

    expect(resolveTargetBroker(db, "ofj-target11", siblings)).toBe("http://100.84.214.24:7899");
  });

  it("returns null for unknown peer ID", () => {
    expect(resolveTargetBroker(db, "xxx-unknown1", siblings)).toBeNull();
  });

  // Regression: issue #17. A peer is visible in list_peers but every send_message
  // bounces "Peer not found" because the sibling config's machine casing differs
  // from the name the remote broker broadcasts in its gossip.
  it("resolves when sibling config casing differs from the broadcast machine name", () => {
    // The A4000 (2026-06-04) broadcasts machine "A4000"; the sibling was configured "a4000".
    const lowercaseSiblings = [{ machine: "a4000", url: "http://100.73.117.41:7899" }];
    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["a40-8qp0moq4", "A4000", "100.73.117.41", 3000, "C:\\WINDOWS\\system32", "", new Date().toISOString(), new Date().toISOString()]);

    expect(resolveTargetBroker(db, "a40-8qp0moq4", lowercaseSiblings)).toBe("http://100.73.117.41:7899");
  });

  it("matches machine names case-insensitively regardless of which side is uppercase", () => {
    const uppercaseSiblings = [{ machine: "OFFICEJAWN", url: "http://100.84.214.24:7899" }];
    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["ofj-mixed111", "officejawn", "100.84.214.24", 4000, "/tmp", "", new Date().toISOString(), new Date().toISOString()]);

    expect(resolveTargetBroker(db, "ofj-mixed111", uppercaseSiblings)).toBe("http://100.84.214.24:7899");
  });
});
