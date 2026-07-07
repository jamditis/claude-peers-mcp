// tests/broker.test.ts

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  advanceStaleGraceFloor,
  generatePeerId,
  isLocalPeerStale,
  isLocalPeerStalePrunable,
  isAllowedIp,
  mergeGossipPeers,
  pruneRemotePeers,
  recordGossipResult,
  resolvePeerRef,
  resolveTargetBroker,
  shouldPruneLocalPeer,
} from "../broker.ts";
import { NAME_DISPLAY_MAX_CHARS } from "../shared/format-peers.ts";

function createTestDb(): Database {
  // Use a private in-memory database per test. A shared temp file leaked rows
  // between fast Windows tests when cleanup raced SQLite file handles.
  const db = new Database(":memory:");

  db.run(`CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY, pid INTEGER NOT NULL, machine TEXT NOT NULL,
    tailscale_ip TEXT NOT NULL, cwd TEXT NOT NULL, git_root TEXT,
    tty TEXT, summary TEXT NOT NULL DEFAULT '', name TEXT, registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS remote_peers (
    id TEXT PRIMARY KEY, machine TEXT NOT NULL, tailscale_ip TEXT NOT NULL,
    pid INTEGER NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
    summary TEXT NOT NULL DEFAULT '', name TEXT, registered_at TEXT NOT NULL,
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
    const id = generatePeerId("alp");
    expect(id).toMatch(/^alp-[a-z0-9]{8}$/);
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
    expect(isAllowedIp("198.51.100.100", ALLOWED)).toBe(false);
    expect(isAllowedIp("8.8.8.8", ALLOWED)).toBe(false);
  });

  it("handles IPv6-mapped IPv4", () => {
    expect(isAllowedIp("::ffff:127.0.0.1", ALLOWED)).toBe(true);
    expect(isAllowedIp("::ffff:8.8.8.8", ALLOWED)).toBe(false);
  });
});

describe("mergeGossipPeers", () => {
  let db: Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("inserts new remote peers, carrying the federated session name", () => {
    const now = new Date().toISOString();
    mergeGossipPeers(db, [
      { id: "bet-aaaa1111", pid: 1000, machine: "node-b", tailscale_ip: "100.64.0.2",
        cwd: "/home/peer", git_root: null, tty: null, summary: "working on bot",
        name: "newsroom", registered_at: now, last_seen: now, is_remote: false },
    ], "node-b", "100.64.0.2");

    const result = db.query("SELECT * FROM remote_peers").all() as any[];
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("bet-aaaa1111");
    expect(result[0].summary).toBe("working on bot");
    expect(result[0].name).toBe("newsroom");
  });

  it("stores a null name when a gossiped peer has none", () => {
    const now = new Date().toISOString();
    mergeGossipPeers(db, [
      { id: "bet-bbbb2222", pid: 1001, machine: "node-b", tailscale_ip: "100.64.0.2",
        cwd: "/home/peer", git_root: null, tty: null, summary: "unnamed",
        registered_at: now, last_seen: now, is_remote: false },
    ], "node-b", "100.64.0.2");

    const result = db.query("SELECT * FROM remote_peers").all() as any[];
    expect(result).toHaveLength(1);
    expect(result[0].name).toBeNull();
  });

  it("updates existing remote peers on re-gossip, including a renamed session", () => {
    const now = new Date().toISOString();
    mergeGossipPeers(db, [
      { id: "bet-aaaa1111", pid: 1000, machine: "node-b", tailscale_ip: "100.64.0.2",
        cwd: "/tmp/old", git_root: null, tty: null, summary: "old summary",
        name: "old-name", registered_at: now, last_seen: now, is_remote: false },
    ], "node-b", "100.64.0.2");

    mergeGossipPeers(db, [
      { id: "bet-aaaa1111", pid: 1000, machine: "node-b", tailscale_ip: "100.64.0.2",
        cwd: "/tmp/new", git_root: null, tty: null, summary: "new summary",
        name: "new-name", registered_at: now, last_seen: now, is_remote: false },
    ], "node-b", "100.64.0.2");

    const result = db.query("SELECT * FROM remote_peers").all() as any[];
    expect(result).toHaveLength(1);
    expect(result[0].cwd).toBe("/tmp/new");
    expect(result[0].summary).toBe("new summary");
    expect(result[0].name).toBe("new-name");
  });
});

describe("resolvePeerRef", () => {
  const peers = [
    { id: "alp-11112222", name: "newsroom" },
    { id: "bet-33334444", name: "research" },
    { id: "gam-55556666", name: null },
  ];

  it("resolves an exact peer id straight through", () => {
    expect(resolvePeerRef(peers, "bet-33334444")).toEqual({ kind: "match", id: "bet-33334444" });
  });

  it("resolves a unique session name to its id", () => {
    expect(resolvePeerRef(peers, "newsroom")).toEqual({ kind: "match", id: "alp-11112222" });
  });

  it("prefers an exact id over a name that collides with it", () => {
    // A session literally named after another peer's id must not shadow id addressing.
    const collide = [
      { id: "alp-11112222", name: "ops" },
      { id: "zed-99998888", name: "alp-11112222" },
    ];
    expect(resolvePeerRef(collide, "alp-11112222")).toEqual({ kind: "match", id: "alp-11112222" });
  });

  it("reports ambiguity when two distinct peers share a name", () => {
    const dup = [
      { id: "alp-11112222", name: "newsroom" },
      { id: "bet-33334444", name: "newsroom" },
    ];
    expect(resolvePeerRef(dup, "newsroom")).toEqual({
      kind: "ambiguous",
      ids: ["alp-11112222", "bet-33334444"],
    });
  });

  it("de-dupes a local peer and its gossiped remote twin into one match", () => {
    // The same session shows up in both peers and remote_peers under one id — not ambiguous.
    const twin = [
      { id: "alp-11112222", name: "newsroom" },
      { id: "alp-11112222", name: "newsroom" },
    ];
    expect(resolvePeerRef(twin, "newsroom")).toEqual({ kind: "match", id: "alp-11112222" });
  });

  it("never matches an unnamed peer by an empty ref", () => {
    expect(resolvePeerRef(peers, "")).toEqual({ kind: "none" });
  });

  it("returns none for a ref that is neither a known id nor a name", () => {
    expect(resolvePeerRef(peers, "sports")).toEqual({ kind: "none" });
  });

  it("matches a name whose stored whitespace differs from the displayed handle", () => {
    // Stored with a tab and doubled spaces; list_peers shows it collapsed to single spaces, so
    // a ref copied from that display must still resolve.
    const spaced = [{ id: "alp-11112222", name: "morning\tdesk  team" }];
    expect(resolvePeerRef(spaced, "morning desk team")).toEqual({ kind: "match", id: "alp-11112222" });
  });

  it("matches a long name by the truncated handle list_peers displays", () => {
    const longName = "a".repeat(80);
    const handle = `${"a".repeat(59)}…`; // what formatPeerList renders (cap is 60)
    const longPeer = [{ id: "alp-11112222", name: longName }];
    // Both the shown (truncated) handle and the full name resolve, since both reduce to it.
    expect(resolvePeerRef(longPeer, handle)).toEqual({ kind: "match", id: "alp-11112222" });
    expect(resolvePeerRef(longPeer, longName)).toEqual({ kind: "match", id: "alp-11112222" });
  });

  it("treats a whitespace-only ref as unnamed, not a match", () => {
    expect(resolvePeerRef(peers, "   ")).toEqual({ kind: "none" });
  });

  it("keeps two long names with a shared prefix addressable by their full names", () => {
    // Both collapse to the same truncated display handle, but an exact full name is unique and
    // must still resolve — the handle match is only the fallback when no name matches exactly.
    const shared = "x".repeat(NAME_DISPLAY_MAX_CHARS - 1);
    const longs = [
      { id: "alp-11112222", name: `${shared}ALPHA` },
      { id: "bet-33334444", name: `${shared}BETA` },
    ];
    expect(resolvePeerRef(longs, `${shared}ALPHA`)).toEqual({ kind: "match", id: "alp-11112222" });
    expect(resolvePeerRef(longs, `${shared}BETA`)).toEqual({ kind: "match", id: "bet-33334444" });
    // The shared truncated handle genuinely can't distinguish them, so it stays ambiguous.
    expect(resolvePeerRef(longs, `${shared}…`)).toEqual({
      kind: "ambiguous",
      ids: ["alp-11112222", "bet-33334444"],
    });
  });

  it("is ambiguous when a displayed handle equals another peer's literal full name", () => {
    const shared = "x".repeat(NAME_DISPLAY_MAX_CHARS - 1);
    const handle = `${shared}…`; // the long peer's displayed handle, and the other peer's real name
    const collide = [
      { id: "alp-11112222", name: `${shared}LONGTAIL` }, // long: renders as `handle`
      { id: "bet-33334444", name: handle }, // literally named the handle: also renders as `handle`
    ];
    // Copying the handle from list_peers can't tell them apart, so refuse rather than misroute to
    // the literal-name peer.
    expect(resolvePeerRef(collide, handle)).toEqual({
      kind: "ambiguous",
      ids: ["alp-11112222", "bet-33334444"],
    });
  });
});

describe("pruneRemotePeers", () => {
  let db: Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // Skipped on win32: bun:sqlite on Windows reports DELETE changes=1 but a follow-up SELECT on the
  // same connection still returns the deleted row, so this fails despite correct code. Tracked in #57;
  // claude-peers runs on the Linux fleet, so this path is never exercised on Windows in production.
  it.skipIf(process.platform === "win32")("removes peers older than TTL, keeps fresh ones", () => {
    const stale = new Date(Date.now() - 60_000).toISOString();
    const fresh = new Date().toISOString();

    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["bet-stale111", "node-b", "100.64.0.2", 1000, "/tmp", "", stale, stale]);
    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["gam-fresh222", "node-c", "100.64.0.3", 2000, "/tmp", "", fresh, fresh]);

    const pruned = pruneRemotePeers(db, 30_000);
    expect(pruned).toBe(1);

    const remaining = db.query("SELECT * FROM remote_peers").all() as any[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("gam-fresh222");
  });
});

describe("isLocalPeerStale", () => {
  const now = Date.parse("2026-07-01T12:00:00.000Z");

  it("marks a peer stale when last_seen is older than the local TTL", () => {
    expect(isLocalPeerStale("2026-07-01T11:59:00.000Z", 45_000, now)).toBe(true);
  });

  it("keeps a peer fresh inside the local TTL", () => {
    expect(isLocalPeerStale("2026-07-01T11:59:30.000Z", 45_000, now)).toBe(false);
  });

  it("does not delete rows with unparseable last_seen values", () => {
    expect(isLocalPeerStale("not-a-date", 45_000, now)).toBe(false);
  });
});

describe("isLocalPeerStalePrunable", () => {
  const now = Date.parse("2026-07-01T12:00:00.000Z");
  const ttlMs = 45_000;
  const pruneGraceMs = 45_000;

  it("does not prune before the local peer TTL has elapsed", () => {
    const lastSeen = "2026-07-01T11:59:30.000Z";
    const brokerStartedAtMs = Date.parse("2026-07-01T11:55:00.000Z");

    expect(isLocalPeerStalePrunable(lastSeen, brokerStartedAtMs, now, ttlMs, pruneGraceMs)).toBe(false);
  });

  it("keeps a stale live peer through the extra prune grace window", () => {
    const lastSeen = "2026-07-01T11:59:00.000Z";
    const brokerStartedAtMs = Date.parse("2026-07-01T11:55:00.000Z");

    expect(isLocalPeerStalePrunable(lastSeen, brokerStartedAtMs, now, ttlMs, pruneGraceMs)).toBe(false);
  });

  it("prunes a stale live peer after TTL plus prune grace", () => {
    const lastSeen = "2026-07-01T11:58:00.000Z";
    const brokerStartedAtMs = Date.parse("2026-07-01T11:55:00.000Z");

    expect(isLocalPeerStalePrunable(lastSeen, brokerStartedAtMs, now, ttlMs, pruneGraceMs)).toBe(true);
  });

  it("gives already-stale rows a broker-start grace window", () => {
    const lastSeen = "2026-07-01T11:58:00.000Z";
    const brokerStartedAtMs = Date.parse("2026-07-01T11:59:30.000Z");

    expect(isLocalPeerStalePrunable(lastSeen, brokerStartedAtMs, now, ttlMs, pruneGraceMs)).toBe(false);
  });
});

describe("advanceStaleGraceFloor", () => {
  const suspendGapMs = 45_000;
  const ttlMs = 45_000;
  const pruneGraceMs = 45_000;
  const floor = Date.parse("2026-07-01T11:55:00.000Z");
  const lastTick = Date.parse("2026-07-01T12:00:00.000Z");

  it("keeps the floor when cleanup ticks arrive on their normal cadence", () => {
    // 15s cadence, well under the 45s suspend threshold: not a freeze, so the floor is unchanged.
    const now = lastTick + 15_000;
    expect(advanceStaleGraceFloor(floor, lastTick, now, suspendGapMs)).toBe(floor);
  });

  it("advances the floor to now after a freeze longer than the suspend gap", () => {
    // The loop was frozen for 10 minutes: the resumed tick is a time jump, not idle time.
    const now = Date.parse("2026-07-01T12:10:00.000Z");
    expect(advanceStaleGraceFloor(floor, lastTick, now, suspendGapMs)).toBe(now);
  });

  it("does not advance on a gap exactly at the threshold", () => {
    // Strict-greater guard: a gap of exactly the threshold is still treated as a normal tick.
    const now = lastTick + suspendGapMs;
    expect(advanceStaleGraceFloor(floor, lastTick, now, suspendGapMs)).toBe(floor);
  });

  it("after a freeze, the refreshed floor keeps a heartbeat-stale live peer recoverable", () => {
    // A peer last seen just before the freeze: with the wall-clock floor stuck at broker start its
    // staleAtMs is far in the past on resume and it prunes immediately; advancing the floor to the
    // resumed tick gives it a fresh grace window so it survives until its heartbeat catches up (#29).
    const lastSeen = "2026-07-01T12:00:30.000Z";
    const preFreezeFloor = Date.parse("2026-07-01T11:55:00.000Z");
    const tickBeforeFreeze = Date.parse("2026-07-01T12:00:40.000Z");
    const resumedNow = Date.parse("2026-07-01T12:10:40.000Z"); // 10 min later

    // Without the amnesty: the first resumed sweep prunes the live peer and its mail.
    expect(isLocalPeerStalePrunable(lastSeen, preFreezeFloor, resumedNow, ttlMs, pruneGraceMs)).toBe(true);

    // With the amnesty: the floor advances to the resumed tick, sparing the peer this window.
    const refreshed = advanceStaleGraceFloor(preFreezeFloor, tickBeforeFreeze, resumedNow, suspendGapMs);
    expect(refreshed).toBe(resumedNow);
    expect(isLocalPeerStalePrunable(lastSeen, refreshed, resumedNow, ttlMs, pruneGraceMs)).toBe(false);
  });
});

describe("shouldPruneLocalPeer", () => {
  it("prunes a dead pid even when its heartbeat is fresh", () => {
    expect(shouldPruneLocalPeer({
      deadPid: true,
      staleHeartbeat: false,
      stalePruneReady: false,
    })).toBe(true);
  });

  it("does not delete a live pid only because its heartbeat is newly stale", () => {
    expect(shouldPruneLocalPeer({
      deadPid: false,
      staleHeartbeat: true,
      stalePruneReady: false,
    })).toBe(false);
  });

  it("prunes a stale live pid after the recovery grace window expires", () => {
    expect(shouldPruneLocalPeer({
      deadPid: false,
      staleHeartbeat: true,
      stalePruneReady: true,
    })).toBe(true);
  });
});

describe("recordGossipResult", () => {
  const SUMMARY_INTERVAL_MS = 5 * 60 * 1000;
  const T0 = 1_000_000_000_000;

  it("healthy stays silent", () => {
    const result = recordGossipResult(null, true, "", "node-b", T0, SUMMARY_INTERVAL_MS);
    expect(result.state).toBeNull();
    expect(result.logLine).toBeNull();
  });

  it("first failure logs immediately and initializes state", () => {
    const result = recordGossipResult(null, false, "The operation timed out.", "node-c", T0, SUMMARY_INTERVAL_MS);
    expect(result.state).toEqual({
      firstFailureAt: T0,
      lastSummaryAt: T0,
      failureCount: 1,
    });
    expect(result.logLine).toBe("Gossip to node-c failed: The operation timed out.");
  });

  it("continuing failure within summary interval is silent", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 1 };
    const result = recordGossipResult(prev, false, "timeout", "node-c", T0 + 5_000, SUMMARY_INTERVAL_MS);
    expect(result.state).toEqual({
      firstFailureAt: T0,
      lastSummaryAt: T0,
      failureCount: 2,
    });
    expect(result.logLine).toBeNull();
  });

  it("continuing failure past summary interval logs a summary and updates lastSummaryAt", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 60 };
    const result = recordGossipResult(prev, false, "timeout", "node-c", T0 + SUMMARY_INTERVAL_MS, SUMMARY_INTERVAL_MS);
    expect(result.state?.lastSummaryAt).toBe(T0 + SUMMARY_INTERVAL_MS);
    expect(result.state?.failureCount).toBe(61);
    expect(result.logLine).toBe("Gossip to node-c still failing: 61 failures over 5m (latest: timeout)");
  });

  it("recovery logs and clears state", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 60 };
    const result = recordGossipResult(prev, true, "", "node-c", T0 + 5 * 60_000, SUMMARY_INTERVAL_MS);
    expect(result.state).toBeNull();
    expect(result.logLine).toBe("Gossip to node-c recovered after 60 failures over 5m");
  });

  it("recovery after a single failure pluralizes correctly", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 1 };
    const result = recordGossipResult(prev, true, "", "node-b", T0 + 5_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toBe("Gossip to node-b recovered after 1 failure over 5s");
  });

  it("formats sub-minute durations in seconds", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 5 };
    const result = recordGossipResult(prev, true, "", "node-b", T0 + 30_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 30s");
  });

  it("formats sub-hour durations in minutes", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 50 };
    const result = recordGossipResult(prev, true, "", "node-b", T0 + 47 * 60_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 47m");
  });

  it("formats multi-hour durations in hours with one decimal", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 999 };
    const result = recordGossipResult(prev, true, "", "node-b", T0 + 90 * 60_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 1.5h");
  });

  it("formats just-under-a-minute as Xs, never rounding up to 60s", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 5 };
    const result = recordGossipResult(prev, true, "", "node-b", T0 + 59_999, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 59s");
    expect(result.logLine).not.toContain("over 60s");
  });

  it("formats just-under-an-hour as Xm, never rounding up to 60m", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 5 };
    const result = recordGossipResult(prev, true, "", "node-b", T0 + 3_599_999, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 59m");
    expect(result.logLine).not.toContain("over 60m");
  });

  it("formats exactly-one-minute as 1m (boundary into minute branch)", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 5 };
    const result = recordGossipResult(prev, true, "", "node-b", T0 + 60_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 1m");
  });

  it("formats exactly-one-hour as 1.0h (boundary into hour branch)", () => {
    const prev = { firstFailureAt: T0, lastSummaryAt: T0, failureCount: 5 };
    const result = recordGossipResult(prev, true, "", "node-b", T0 + 3_600_000, SUMMARY_INTERVAL_MS);
    expect(result.logLine).toContain("over 1.0h");
  });
});

describe("resolveTargetBroker", () => {
  let db: Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  const siblings = [
    { machine: "node-b", url: "http://100.64.0.2:7899" },
    { machine: "node-c", url: "http://100.64.0.3:7899" },
  ];

  it("returns sibling URL for a known remote peer", () => {
    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["bet-target11", "node-b", "100.64.0.2", 1000, "/tmp", "", new Date().toISOString(), new Date().toISOString()]);

    expect(resolveTargetBroker(db, "bet-target11", siblings)).toBe("http://100.64.0.2:7899");
  });

  it("returns null for unknown peer ID", () => {
    expect(resolveTargetBroker(db, "xxx-unknown1", siblings)).toBeNull();
  });

  // Regression: issue #17. A peer is visible in list_peers but every send_message
  // bounces "Peer not found" because the sibling config's machine casing differs
  // from the name the remote broker broadcasts in its gossip.
  it("resolves when sibling config casing differs from the broadcast machine name", () => {
    // The NODE-D (2026-06-04) broadcasts machine "NODE-D"; the sibling was configured "node-d".
    const lowercaseSiblings = [{ machine: "node-d", url: "http://100.64.0.4:7899" }];
    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["win-8qp0moq4", "NODE-D", "100.64.0.4", 3000, "C:\\WINDOWS\\system32", "", new Date().toISOString(), new Date().toISOString()]);

    expect(resolveTargetBroker(db, "win-8qp0moq4", lowercaseSiblings)).toBe("http://100.64.0.4:7899");
  });

  it("matches machine names case-insensitively regardless of which side is uppercase", () => {
    const uppercaseSiblings = [{ machine: "NODE-B", url: "http://100.64.0.2:7899" }];
    db.run("INSERT INTO remote_peers (id, machine, tailscale_ip, pid, cwd, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["bet-mixed111", "node-b", "100.64.0.2", 4000, "/tmp", "", new Date().toISOString(), new Date().toISOString()]);

    expect(resolveTargetBroker(db, "bet-mixed111", uppercaseSiblings)).toBe("http://100.64.0.2:7899");
  });
});
