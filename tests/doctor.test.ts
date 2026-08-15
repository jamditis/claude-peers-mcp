import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { LOCAL_PEER_TTL_MS } from "../broker.ts";
import { classifyPaneReadiness, ensureMessagesTable } from "../delivery.ts";
import {
  buildDoctorReport, type ConfigFacts, DOCTOR_PEER_STALE_MS, type DoctorFacts,
  doctorExitCode, formatDoctorReport, partitionSiblings, probeBroker, probeSiblings,
  readStoredPeers, readStoreFacts, redact, resolveDoctorDbPath, resolvePeerFacts,
  resolveQueueStaleMs, type StoreFacts,
} from "../shared/doctor.ts";
import { PROTOCOL_VERSION } from "../shared/types.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE peers (
    id TEXT PRIMARY KEY, pid INTEGER NOT NULL, machine TEXT NOT NULL,
    tailscale_ip TEXT NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
    summary TEXT NOT NULL DEFAULT '', name TEXT, registered_at TEXT NOT NULL, last_seen TEXT NOT NULL,
    tmux_pane TEXT, tmux_socket TEXT, delivery_kind TEXT NOT NULL DEFAULT 'none', token TEXT
  )`);
  ensureMessagesTable(db);
  return db;
}

function addPeer(db: Database, over: Partial<Record<string, unknown>> = {}): void {
  const p = {
    id: "abc-11111111", pid: 4242, machine: "node-a", tailscale_ip: "100.0.0.1",
    cwd: "/work", git_root: null, tty: null, summary: "doing things", name: "alpha",
    registered_at: new Date(NOW - 60_000).toISOString(), last_seen: new Date(NOW).toISOString(),
    tmux_pane: null, tmux_socket: null, delivery_kind: "none",
    token: "e".repeat(64),
    ...over,
  };
  db.run(
    `INSERT INTO peers (id, pid, machine, tailscale_ip, cwd, git_root, tty, summary, name,
      registered_at, last_seen, tmux_pane, tmux_socket, delivery_kind, token)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [p.id, p.pid, p.machine, p.tailscale_ip, p.cwd, p.git_root, p.tty, p.summary, p.name,
      p.registered_at, p.last_seen, p.tmux_pane, p.tmux_socket, p.delivery_kind, p.token] as never[],
  );
}

function addMessage(db: Database, over: Partial<Record<string, unknown>> = {}): void {
  const m = {
    from_id: "zzz-1", to_id: "abc-11111111", text: "SECRET-BODY-TEXT",
    sent_at: new Date(NOW - 1000).toISOString(), delivery_state: "queued",
    lease_expires_at: null, lease_token: null, urgency: "normal", push_after: NOW,
    channel_push_attempts: 0,
    ...over,
  };
  db.run(
    `INSERT INTO messages (from_id, to_id, text, sent_at, delivery_state, lease_expires_at,
      lease_token, urgency, push_after, channel_push_attempts) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [m.from_id, m.to_id, m.text, m.sent_at, m.delivery_state, m.lease_expires_at,
      m.lease_token, m.urgency, m.push_after, m.channel_push_attempts] as never[],
  );
}

const okConfig: ConfigFacts = {
  path: "/etc/claude-peers.json", loaded: true, defaulted: false, siblings_invalid: [], error: null,
};
const emptyStore: StoreFacts = {
  path: "/tmp/peers.db", integrity: "ok", integrity_detail: "quick_check ok",
  queues_read: true, read_error: null, queues: [], stalled_leases: [], push_capped: [],
};

function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    now_ms: NOW,
    expected_protocol: PROTOCOL_VERSION,
    push_delay_ms: 120_000,
    peers_read: true,
    config: okConfig,
    broker: {
      url: "http://127.0.0.1:7899", reachable: true, error: null, status: "ok",
      protocol_version: PROTOCOL_VERSION, machine: "node-a", local_peer_count: 1,
      remote_peer_count: 0, serves_peers: true, serve_error: null,
    },
    siblings: [],
    peers: [],
    store: emptyStore,
    ...over,
  };
}

function codeFor(report: ReturnType<typeof buildDoctorReport>, id: string): string | undefined {
  return report.checks.find((c) => c.id === id)?.code;
}

/** A fetch double: maps a URL suffix to a canned response, or throws for a dead endpoint. */
function fakeFetch(routes: Record<string, { ok?: boolean; status?: number; body?: unknown }>) {
  return async (url: string) => {
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (key === undefined) throw new Error("connection refused");
    const r = routes[key] ?? {};
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body ?? {} };
  };
}

describe("doctor: stale-threshold parity", () => {
  it("uses the broker's own local-peer TTL as the stale threshold", () => {
    expect(DOCTOR_PEER_STALE_MS).toBe(LOCAL_PEER_TTL_MS);
  });
});

describe("doctor: broker probe", () => {
  it("reports an unreachable broker as a failure with remediation, without throwing", async () => {
    const broker = await probeBroker(fakeFetch({}), "http://127.0.0.1:7899");
    expect(broker.reachable).toBe(false);
    const report = buildDoctorReport(facts({ broker }));
    expect(codeFor(report, "broker.process")).toBe("BROKER_UNREACHABLE");
    const c = report.checks.find((x) => x.id === "broker.process");
    expect(c?.severity).toBe("fail");
    expect(c?.remediation).toBeTruthy();
    expect(doctorExitCode(report)).toBe(2);
  });

  it("separates a live process from one that cannot serve peer operations", async () => {
    const broker = await probeBroker(
      fakeFetch({
        "/health": { body: { status: "ok", peers: 1, protocol_version: PROTOCOL_VERSION } },
        "/list-peers": { ok: false, status: 500 },
      }),
      "http://127.0.0.1:7899",
    );
    const report = buildDoctorReport(facts({ broker }));
    expect(codeFor(report, "broker.process")).toBe("BROKER_OK");
    expect(codeFor(report, "broker.serving")).toBe("BROKER_NOT_SERVING");
  });

  it("reports an older broker's protocol version instead of refusing to run", async () => {
    const broker = await probeBroker(
      fakeFetch({ "/health": { body: { status: "ok", peers: 0, protocol_version: 5 } }, "/list-peers": { body: [] } }),
      "http://127.0.0.1:7899",
    );
    const report = buildDoctorReport(facts({ broker }));
    expect(codeFor(report, "broker.protocol")).toBe("BROKER_PROTOCOL_OUTDATED");
    expect(codeFor(report, "broker.serving")).toBe("BROKER_SERVING");
  });

  it("exercises /list-peers as a real POST peer read, not a second liveness ping", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    await probeBroker(async (url, body) => {
      seen.push({ url, body });
      return { ok: true, status: 200, json: async () => (url.endsWith("/health") ? { status: "ok", peers: 0, protocol_version: PROTOCOL_VERSION } : []) };
    }, "http://127.0.0.1:7899");
    const listCall = seen.find((c) => c.url.endsWith("/list-peers"));
    expect(listCall?.body).toMatchObject({ scope: "machine" });
  });

  it("resolves a version-less /health to protocol 1 rather than unknown", async () => {
    const broker = await probeBroker(
      fakeFetch({ "/health": { body: { status: "ok", peers: 0 } }, "/list-peers": { body: [] } }),
      "http://127.0.0.1:7899",
    );
    expect(broker.protocol_version).toBe(1);
  });
});

describe("doctor: siblings", () => {
  it("flags an unreachable sibling and reports a reachable one's protocol version", async () => {
    let t = 0;
    const probes = await probeSiblings(
      fakeFetch({ "up/health": { body: { status: "ok", peers: 2, protocol_version: PROTOCOL_VERSION } } }),
      [{ machine: "up", url: "http://up" }, { machine: "down", url: "http://down" }],
      () => (t += 5),
    );
    const report = buildDoctorReport(facts({ siblings: probes }));
    expect(codeFor(report, "sibling.up")).toBe("SIBLING_OK");
    expect(codeFor(report, "sibling.down")).toBe("SIBLING_UNREACHABLE");
  });

  it("flags a sibling running an older protocol", async () => {
    const probes = await probeSiblings(
      fakeFetch({ "/health": { body: { status: "ok", peers: 0, protocol_version: 4 } } }),
      [{ machine: "old", url: "http://old" }],
      () => 0,
    );
    const report = buildDoctorReport(facts({ siblings: probes }));
    expect(codeFor(report, "sibling.old")).toBe("SIBLING_PROTOCOL_MISMATCH");
  });
});

describe("doctor: peer backend readiness", () => {
  const alive = () => true;

  it("reports a shell-only tmux pane as live-but-unready, distinct from a dead process", async () => {
    const db = makeDb();
    addPeer(db, { delivery_kind: "tmux", tmux_pane: "%3" });
    const peers = await resolvePeerFacts(readStoredPeers(db), {
      nowMs: NOW,
      isPidAlive: alive,
      probePane: async () => classifyPaneReadiness("bash"),
    });
    expect(peers[0]?.backend).toBe("unready");
    const report = buildDoctorReport(facts({ peers }));
    expect(codeFor(report, "peer.abc-11111111")).toBe("PEER_BACKEND_UNREADY");
    db.close();
  });

  it("reports a dead process separately from an unready backend", async () => {
    const db = makeDb();
    addPeer(db, { delivery_kind: "tmux", tmux_pane: "%3" });
    const peers = await resolvePeerFacts(readStoredPeers(db), {
      nowMs: NOW,
      isPidAlive: () => false,
      probePane: async () => classifyPaneReadiness("bash"),
    });
    const report = buildDoctorReport(facts({ peers }));
    expect(codeFor(report, "peer.abc-11111111")).toBe("PEER_PROCESS_DEAD");
    db.close();
  });

  it("reports a stale peer whose process is alive but stopped heartbeating", async () => {
    const db = makeDb();
    addPeer(db, { last_seen: new Date(NOW - DOCTOR_PEER_STALE_MS - 10_000).toISOString() });
    const peers = await resolvePeerFacts(readStoredPeers(db), { nowMs: NOW, isPidAlive: alive });
    const report = buildDoctorReport(facts({ peers }));
    expect(codeFor(report, "peer.abc-11111111")).toBe("PEER_STALE");
    db.close();
  });

  it("treats a tmux peer with no pane recorded as a missing backend", async () => {
    const db = makeDb();
    addPeer(db, { delivery_kind: "tmux", tmux_pane: null });
    const peers = await resolvePeerFacts(readStoredPeers(db), { nowMs: NOW, isPidAlive: alive });
    const report = buildDoctorReport(facts({ peers }));
    expect(codeFor(report, "peer.abc-11111111")).toBe("PEER_BACKEND_MISSING");
    db.close();
  });

  it("says unknown, not ready, when the pane probe faults", async () => {
    const db = makeDb();
    addPeer(db, { delivery_kind: "tmux", tmux_pane: "%3" });
    const peers = await resolvePeerFacts(readStoredPeers(db), {
      nowMs: NOW,
      isPidAlive: alive,
      probePane: async () => { throw new Error("tmux probe exited 1"); },
    });
    expect(peers[0]?.backend).toBe("unknown");
    const report = buildDoctorReport(facts({ peers }));
    expect(codeFor(report, "peer.abc-11111111")).toBe("PEER_BACKEND_UNKNOWN");
    db.close();
  });

  it("treats a delivery_kind=none session as healthy and poll-only", async () => {
    const db = makeDb();
    addPeer(db);
    const peers = await resolvePeerFacts(readStoredPeers(db), { nowMs: NOW, isPidAlive: alive });
    const report = buildDoctorReport(facts({ peers }));
    expect(codeFor(report, "peer.abc-11111111")).toBe("PEER_POLL_ONLY");
    db.close();
  });
});

describe("doctor: store and queue facts", () => {
  it("counts queued, delivering, poll-only, and oldest-pending per recipient", () => {
    const db = makeDb();
    addMessage(db);
    addMessage(db, { push_after: null, sent_at: new Date(NOW - 5000).toISOString() });
    addMessage(db, { delivery_state: "delivering", lease_expires_at: NOW + 5000, lease_token: "live" });
    addMessage(db, { to_id: "other-1" });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(store.integrity).toBe("ok");
    const q = store.queues.find((x) => x.to_id === "abc-11111111");
    expect(q).toMatchObject({ queued: 2, delivering: 1, never_push: 1 });
    expect(q?.oldest_age_ms).toBe(5000);
    expect(store.stalled_leases).toEqual([]);
    db.close();
  });

  it("detects a stalled lease (delivering past expiry)", () => {
    const db = makeDb();
    addMessage(db, { delivery_state: "delivering", lease_expires_at: NOW - 30_000, lease_token: "expired" });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(store.stalled_leases).toHaveLength(1);
    expect(store.stalled_leases[0]).toMatchObject({ to_id: "abc-11111111", expired_ms: 30_000, holderless: false });
    const report = buildDoctorReport(facts({ store }));
    expect(codeFor(report, "queue.leases")).toBe("QUEUE_LEASE_STALLED");
    expect(doctorExitCode(report)).toBe(2);
    db.close();
  });

  it("flags pending mail addressed to an id no peer holds", () => {
    const db = makeDb();
    addMessage(db, { to_id: "ghost-1" });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    const report = buildDoctorReport(facts({ store }));
    expect(codeFor(report, "queue.ghost-1")).toBe("QUEUE_ORPHANED");
    db.close();
  });

  it("flags a backlog older than every automatic push window", async () => {
    const db = makeDb();
    addPeer(db);
    addMessage(db, { sent_at: new Date(NOW - 60 * 60_000).toISOString(), push_after: NOW - 60 * 60_000 });
    const peers = await resolvePeerFacts(readStoredPeers(db), { nowMs: NOW, isPidAlive: () => true });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    const report = buildDoctorReport(facts({ peers, store }));
    expect(codeFor(report, "queue.abc-11111111")).toBe("QUEUE_BACKLOG_STALE");
    db.close();
  });

  it("attributes a backlog behind an unready pane to the deferring backend", async () => {
    const db = makeDb();
    addPeer(db, { delivery_kind: "tmux", tmux_pane: "%3" });
    addMessage(db);
    const peers = await resolvePeerFacts(readStoredPeers(db), {
      nowMs: NOW, isPidAlive: () => true, probePane: async () => classifyPaneReadiness("zsh"),
    });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    const report = buildDoctorReport(facts({ peers, store }));
    expect(codeFor(report, "queue.abc-11111111")).toBe("QUEUE_DELIVERY_DEFERRED");
    db.close();
  });

  it("reports rows that have exhausted their channel push cap", () => {
    const db = makeDb();
    addMessage(db, { channel_push_attempts: 3 });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    const report = buildDoctorReport(facts({ store }));
    expect(codeFor(report, "delivery.attempts")).toBe("DELIVERY_PUSH_CAP_REACHED");
    db.close();
  });

  it("reads a store with no messages table as an empty queue, not an unreadable store", () => {
    const db = new Database(":memory:");
    const store = readStoreFacts(db, "/tmp/fresh.db", NOW, 3);
    expect(store.integrity).toBe("ok");
    expect(store.queues).toEqual([]);
    expect(readStoredPeers(db)).toEqual([]);
    db.close();
  });
});

// Review follow-ups (PR #95). Each case below is a state an earlier version of these checks got
// wrong: a jam it called healthy, a healthy store it called broken, or a value it printed raw.
describe("doctor: review follow-ups", () => {
  /** A legacy messages table: the pre-CHECK schema, so a holderless delivering row can exist. */
  function legacyMessagesDb(): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
      text TEXT NOT NULL, sent_at TEXT NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'queued',
      lease_expires_at INTEGER, lease_token TEXT,
      urgency TEXT NOT NULL DEFAULT 'interrupt', push_after INTEGER DEFAULT 0
    )`);
    return db;
  }

  it("flags a holderless delivering row whose lease has not expired yet", () => {
    const db = legacyMessagesDb();
    // Future expiry, no token: nextDeliverable reads the timestamp as a live attempt and blocks
    // the recipient forever, so an expiry-only predicate would call this jam QUEUE_LEASE_OK.
    db.run(
      "INSERT INTO messages (from_id, to_id, text, sent_at, delivery_state, lease_expires_at, lease_token, urgency, push_after) VALUES ('z','abc-11111111','body',?,'delivering',?,NULL,'normal',?)",
      [new Date(NOW - 1000).toISOString(), NOW + 3_600_000, NOW] as never[],
    );
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(store.stalled_leases).toHaveLength(1);
    expect(store.stalled_leases[0]).toMatchObject({ holderless: true });
    const report = buildDoctorReport(facts({ store }));
    expect(codeFor(report, "queue.leases")).toBe("QUEUE_LEASE_STALLED");
    db.close();
  });

  it("never reports a lease token value, only whether one exists", () => {
    const db = makeDb();
    addMessage(db, { delivery_state: "delivering", lease_expires_at: NOW - 1, lease_token: "leasetok12345678" });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(JSON.stringify(store)).not.toContain("leasetok12345678");
    db.close();
  });

  it("reads a legacy peers table missing name and delivery columns instead of failing the store", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, pid INTEGER NOT NULL, machine TEXT NOT NULL,
      tailscale_ip TEXT NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
      summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL
    )`);
    db.run(
      "INSERT INTO peers (id, pid, machine, tailscale_ip, cwd, git_root, tty, summary, registered_at, last_seen) VALUES ('old-1', 7, 'node-a', '100.0.0.1', '/w', NULL, NULL, '', ?, ?)",
      [new Date(NOW - 1000).toISOString(), new Date(NOW).toISOString()] as never[],
    );
    const stored = readStoredPeers(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "old-1", name: null, delivery_kind: "none", tmux_pane: null });
    db.close();
  });

  it("scales backlog staleness to a configured push_delay_ms instead of a fixed window", async () => {
    const db = makeDb();
    addPeer(db);
    // A node told to hold normal mail for 30 minutes: a 20-minute-old row is inside its policy,
    // and its stored deadline says so.
    addMessage(db, { sent_at: new Date(NOW - 20 * 60_000).toISOString(), push_after: NOW + 10 * 60_000 });
    const peers = await resolvePeerFacts(readStoredPeers(db), { nowMs: NOW, isPidAlive: () => true });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(resolveQueueStaleMs(30 * 60_000)).toBe(60 * 60_000);
    expect(codeFor(buildDoctorReport(facts({ peers, store, push_delay_ms: 30 * 60_000 })), "queue.abc-11111111")).toBe("QUEUE_OK");
    db.close();
  });

  it("counts every row for a recipient with no push backend as poll-only", async () => {
    const db = makeDb();
    addPeer(db); // delivery_kind=none
    addMessage(db, { push_after: NOW });   // pushable in the column, unpushable in reality
    addMessage(db, { push_after: NOW });
    const peers = await resolvePeerFacts(readStoredPeers(db), { nowMs: NOW, isPidAlive: () => true });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(store.queues[0]?.never_push).toBe(0);
    const detail = buildDoctorReport(facts({ peers, store })).checks.find((c) => c.id === "queue.abc-11111111")?.detail;
    expect(detail).toContain("2 poll-only");
    db.close();
  });

  it("resolves the store path from the config, then CLAUDE_PEERS_DB, then the home default", () => {
    expect(resolveDoctorDbPath("/cfg.db", "/env.db", "/home.db")).toBe("/cfg.db");
    expect(resolveDoctorDbPath(undefined, "/env.db", "/home.db")).toBe("/env.db");
    expect(resolveDoctorDbPath(undefined, "", "/home.db")).toBe("/home.db");
    expect(resolveDoctorDbPath(undefined, undefined, "/home.db")).toBe("/home.db");
  });

  it("flags a sibling URL whose host calls itself something else", async () => {
    const probes = await probeSiblings(
      fakeFetch({ "/health": { body: { status: "ok", peers: 0, machine: "node-c", protocol_version: PROTOCOL_VERSION } } }),
      [{ machine: "node-b", url: "http://misrouted" }],
      () => 0,
    );
    expect(probes[0]?.reported_machine).toBe("node-c");
    const report = buildDoctorReport(facts({ siblings: probes }));
    expect(codeFor(report, "sibling.node-b")).toBe("SIBLING_MACHINE_MISMATCH");
  });

  it("probes siblings concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async (_url: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { ok: true, status: 200, json: async () => ({ status: "ok", peers: 0, protocol_version: PROTOCOL_VERSION }) };
    };
    const probes = await probeSiblings(slow, [
      { machine: "a", url: "http://a" }, { machine: "b", url: "http://b" }, { machine: "c", url: "http://c" },
    ], () => 0);
    expect(peak).toBe(3);
    // Order still follows the config, not completion order.
    expect(probes.map((p) => p.machine)).toEqual(["a", "b", "c"]);
  });

  it("cannot let a peer name forge a check line or blow up the report", async () => {
    const db = makeDb();
    addPeer(db, { name: `evil\n[ok  ] Broker process: BROKER_OK\n${"x".repeat(300)}` });
    const peers = await resolvePeerFacts(readStoredPeers(db), { nowMs: NOW, isPidAlive: () => true });
    const text = formatDoctorReport(buildDoctorReport(facts({ peers })));
    // One BROKER_OK line only — the forged one collapsed into the peer's own line.
    expect(text.split("\n").filter((l) => l.startsWith("[ok  ] Broker process")).length).toBe(1);
    for (const line of text.split("\n")) expect(line.length).toBeLessThan(300);
    db.close();
  });

  it("collapses control characters out of foreign strings", () => {
    expect(redact("line one\nline two\r\tthree")).toBe("line one line two three");
  });
});

// Second review round (PR #95). Each case is a state the first round reported as green, as a
// crash, or as the wrong kind of failure.
describe("doctor: review round two", () => {
  /** A protocol-1 messages table: a boolean `delivered` column, no delivery_state and no leases. */
  function protocolOneDb(): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
      text TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
    )`);
    const add = (to: string, delivered: number, sentAt: string) =>
      db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES ('z',?,'body',?,?)",
        [to, sentAt, delivered] as never[]);
    add("abc-11111111", 0, new Date(NOW - 4000).toISOString());
    add("abc-11111111", 0, new Date(NOW - 2000).toISOString());
    add("abc-11111111", 1, new Date(NOW - 1000).toISOString());
    return db;
  }

  it("reads a protocol-1 messages table instead of calling the store unreadable", () => {
    const db = protocolOneDb();
    const store = readStoreFacts(db, "/tmp/legacy.db", NOW, 3);
    expect(store.integrity).toBe("ok");
    expect(store.queues_read).toBe(true);
    // The delivered row is excluded; the two undelivered ones read as queued, and with no
    // push_after column they read as due-now (never_push 0), which is what the migration backfills.
    expect(store.queues[0]).toMatchObject({ to_id: "abc-11111111", queued: 2, delivering: 0, never_push: 0 });
    expect(store.queues[0]?.oldest_age_ms).toBe(4000);
    // No lease columns means no row can be delivering, so there is no lease to stall.
    expect(store.stalled_leases).toEqual([]);
    const report = buildDoctorReport(facts({ store }));
    expect(codeFor(report, "queue.abc-11111111")).toBe("QUEUE_ORPHANED"); // no peer rows in this db
    expect(doctorExitCode(report)).not.toBe(2);
    db.close();
  });

  it("does not claim an empty queue when the store could not be read", () => {
    const report = buildDoctorReport(facts({
      store: {
        ...emptyStore, integrity: "unreadable", integrity_detail: "disk I/O error", queues_read: false,
      },
    }));
    expect(codeFor(report, "queue")).toBe("QUEUE_UNAVAILABLE");
    // The success codes the old version emitted over unread data must not appear at all.
    expect(report.checks.map((c) => c.code)).not.toContain("QUEUE_EMPTY");
    expect(report.checks.map((c) => c.code)).not.toContain("QUEUE_LEASE_OK");
  });

  it("treats an absent store as an absent queue rather than a failure", () => {
    const report = buildDoctorReport(facts({
      store: { ...emptyStore, integrity: "missing", integrity_detail: "no store file", queues_read: false },
    }));
    const c = report.checks.find((x) => x.id === "queue");
    expect(c?.code).toBe("QUEUE_UNAVAILABLE");
    expect(c?.severity).toBe("ok");
  });

  it("probes panes concurrently, preserving peer order", async () => {
    const db = makeDb();
    for (const id of ["p-1", "p-2", "p-3"]) {
      addPeer(db, { id, delivery_kind: "tmux", tmux_pane: `%${id}` });
    }
    let inFlight = 0;
    let peak = 0;
    const peers = await resolvePeerFacts(readStoredPeers(db), {
      nowMs: NOW,
      isPidAlive: () => true,
      probePane: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return classifyPaneReadiness("node");
      },
    });
    expect(peak).toBe(3);
    expect(peers.map((p) => p.id)).toEqual(["p-1", "p-2", "p-3"]);
    db.close();
  });

  it("reports a process that answers with an HTTP error as alive-but-broken, not unreachable", async () => {
    const broker = await probeBroker(
      fakeFetch({ "/health": { ok: false, status: 500 }, "/list-peers": { ok: false, status: 500 } }),
      "http://127.0.0.1:7899",
    );
    expect(broker.reachable).toBe(true);
    const report = buildDoctorReport(facts({ broker }));
    expect(codeFor(report, "broker.process")).toBe("BROKER_HEALTH_ERROR");
    // The remediation must not be "start the broker" — one is already running on that port.
    expect(report.checks.find((c) => c.id === "broker.process")?.remediation).not.toContain("auto-launches");
  });

  it("still reports unreachable when nothing answers at all", async () => {
    const broker = await probeBroker(fakeFetch({}), "http://127.0.0.1:7899");
    expect(broker.reachable).toBe(false);
    expect(codeFor(buildDoctorReport(facts({ broker })), "broker.process")).toBe("BROKER_UNREACHABLE");
  });

  it("redacts the status and machine strings the local broker reports", async () => {
    const broker = await probeBroker(
      fakeFetch({
        "/health": { body: { status: "ok\n[ok  ] Broker process: BROKER_OK", peers: 0, machine: "a\nb", protocol_version: PROTOCOL_VERSION } },
        "/list-peers": { body: [] },
      }),
      "http://127.0.0.1:7899",
    );
    expect(broker.status).not.toContain("\n");
    expect(broker.machine).not.toContain("\n");
    const report = buildDoctorReport(facts({ broker }));
    // The doctored status does not equal "ok", so it reads as unhealthy — and the forged line it
    // tried to smuggle in is now inside that check's own detail line, not a line of its own.
    expect(codeFor(report, "broker.process")).toBe("BROKER_UNHEALTHY");
    const text = formatDoctorReport(report);
    expect(text.split("\n").filter((l) => l.startsWith("[ok  ] Broker process")).length).toBe(0);
  });

  it("reports a non-array siblings field as a config failure instead of throwing", () => {
    const report = buildDoctorReport(facts({
      config: { ...okConfig, siblings_invalid: ['entry 0 is not an object'] },
      siblings: [],
    }));
    expect(codeFor(report, "config.source")).toBe("CONFIG_SIBLINGS_INVALID");
    expect(doctorExitCode(report)).toBe(2);
    // Still a complete, serializable report — the point of degrading rather than throwing.
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it("judges lease expiry against the observation time, not a pre-probe clock", () => {
    const db = makeDb();
    // A lease that is live at NOW and expired 3s later, the span a slow network probe burns.
    addMessage(db, { delivery_state: "delivering", lease_expires_at: NOW + 2000, lease_token: "live" });
    expect(readStoreFacts(db, "/tmp/peers.db", NOW, 3).stalled_leases).toEqual([]);
    const later = readStoreFacts(db, "/tmp/peers.db", NOW + 3000, 3);
    expect(later.stalled_leases).toHaveLength(1);
    expect(codeFor(buildDoctorReport(facts({ store: later })), "queue.leases")).toBe("QUEUE_LEASE_STALLED");
    db.close();
  });
});

// Third review round (PR #95): polish. Mostly cases where doctor reported a fault that was not
// one, or a clean result it had not earned.
describe("doctor: review round three", () => {
  it("partitions malformed sibling entries instead of throwing on them", () => {
    const { valid, invalid } = partitionSiblings([
      { machine: "good", url: "http://good" },
      null,
      "nope",
      { machine: "b" },
      { url: "http://c" },
      { machine: "  ", url: "http://d" },
    ]);
    expect(valid).toEqual([{ machine: "good", url: "http://good" }]);
    expect(invalid).toHaveLength(5);
    expect(invalid[0]).toContain("entry 1");
    expect(partitionSiblings({}).invalid).toEqual(['"siblings" is not an array']);
    expect(partitionSiblings(undefined)).toEqual({ valid: [], invalid: [] });
  });

  it("still probes the usable siblings when one entry is malformed", async () => {
    const raw = [null, { machine: "up", url: "http://up" }];
    const { valid, invalid } = partitionSiblings(raw);
    const probes = await probeSiblings(
      fakeFetch({ "/health": { body: { status: "ok", peers: 0, machine: "up", protocol_version: PROTOCOL_VERSION } } }),
      valid,
      () => 0,
    );
    const report = buildDoctorReport(facts({
      siblings: probes,
      config: { ...okConfig, siblings_invalid: invalid },
    }));
    expect(codeFor(report, "config.source")).toBe("CONFIG_SIBLINGS_INVALID");
    expect(codeFor(report, "sibling.up")).toBe("SIBLING_OK");
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it("compares sibling machine names case-insensitively, like the broker's own routing", async () => {
    const probes = await probeSiblings(
      fakeFetch({ "/health": { body: { status: "ok", peers: 0, machine: "NODE-B", protocol_version: PROTOCOL_VERSION } } }),
      [{ machine: "node-b", url: "http://b" }],
      () => 0,
    );
    expect(codeFor(buildDoctorReport(facts({ siblings: probes })), "sibling.node-b")).toBe("SIBLING_OK");
  });

  it("evaluates a sibling's own reported status, not just its HTTP code", async () => {
    const probes = await probeSiblings(
      fakeFetch({ "/health": { body: { status: "degraded", peers: 0, machine: "node-b", protocol_version: PROTOCOL_VERSION } } }),
      [{ machine: "node-b", url: "http://b" }],
      () => 0,
    );
    expect(codeFor(buildDoctorReport(facts({ siblings: probes })), "sibling.node-b")).toBe("SIBLING_UNHEALTHY");
  });

  it("judges a backlog by each row's stored push deadline, not the current setting", async () => {
    const db = makeDb();
    // A pushable recipient: the stored deadline is what governs when its mail moves.
    addPeer(db, { delivery_kind: "tmux", tmux_pane: "%3" });
    // Enqueued long ago under a much longer delay, so its stored deadline is still in the
    // future: hasDuePush would refuse to push it, and doctor must agree rather than cry stale.
    addMessage(db, { sent_at: new Date(NOW - 90 * 60_000).toISOString(), push_after: NOW + 60_000 });
    const peers = await resolvePeerFacts(readStoredPeers(db), {
      nowMs: NOW, isPidAlive: () => true, probePane: async () => classifyPaneReadiness("node"),
    });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(store.queues[0]?.oldest_due_ms).toBe(0);
    expect(codeFor(buildDoctorReport(facts({ peers, store })), "queue.abc-11111111")).toBe("QUEUE_OK");
    db.close();
  });

  it("falls back to message age for a backlog with no push deadline at all", async () => {
    const db = makeDb();
    addPeer(db);
    addMessage(db, { sent_at: new Date(NOW - 90 * 60_000).toISOString(), push_after: null });
    const peers = await resolvePeerFacts(readStoredPeers(db), { nowMs: NOW, isPidAlive: () => true });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(store.queues[0]?.oldest_due_ms).toBeNull();
    expect(codeFor(buildDoctorReport(facts({ peers, store })), "queue.abc-11111111")).toBe("QUEUE_BACKLOG_STALE");
    db.close();
  });

  it("does not claim there are no peers when the peer table was never read", () => {
    const report = buildDoctorReport(facts({ peers: [], peers_read: false }));
    expect(codeFor(report, "peers")).toBe("PEERS_UNAVAILABLE");
    expect(report.checks.map((c) => c.code)).not.toContain("PEERS_NONE");
  });

  it("collapses a store path that carries newlines", () => {
    const report = buildDoctorReport(facts({
      store: { ...emptyStore, path: "/db\n[ok  ] Broker process: BROKER_OK" },
    }));
    const text = formatDoctorReport(report);
    expect(text.split("\n").filter((l) => l.startsWith("[ok  ] Broker process")).length).toBe(1);
  });

  it("treats the zero-config single-host default as healthy, so a default install exits 0", () => {
    const report = buildDoctorReport(facts({
      config: { ...okConfig, defaulted: true },
    }));
    const c = report.checks.find((x) => x.id === "config.source");
    expect(c?.code).toBe("CONFIG_DEFAULTED");
    expect(c?.severity).toBe("ok");
    expect(doctorExitCode(report)).toBe(0);
  });
});

// Fourth review round (PR #95): four ways a partial failure produced a confident wrong answer.
describe("doctor: review round four", () => {
  it("reports a sibling that answers with an HTTP error as reachable but unhealthy", async () => {
    const probes = await probeSiblings(
      fakeFetch({ "/health": { ok: false, status: 503 } }),
      [{ machine: "node-b", url: "http://b" }],
      () => 0,
    );
    expect(probes[0]?.reachable).toBe(true);
    const report = buildDoctorReport(facts({ siblings: probes }));
    expect(codeFor(report, "sibling.node-b")).toBe("SIBLING_HEALTH_ERROR");
    // Not a network problem, so the remediation must not send anyone to the tailnet.
    expect(report.checks.find((c) => c.id === "sibling.node-b")?.remediation).not.toContain("tailnet");
  });

  it("still reports a sibling that answers nothing at all as unreachable", async () => {
    const probes = await probeSiblings(fakeFetch({}), [{ machine: "node-b", url: "http://b" }], () => 0);
    expect(probes[0]?.reachable).toBe(false);
    expect(codeFor(buildDoctorReport(facts({ siblings: probes })), "sibling.node-b")).toBe("SIBLING_UNREACHABLE");
  });

  it("does not call live recipients' mail orphaned when the peer table was not read", () => {
    const db = makeDb();
    addPeer(db);
    addMessage(db);
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    // Queue rows read fine; the peer read did not. The recipient is alive — calling its mail
    // unreachable would invite an operator to delete it.
    const report = buildDoctorReport(facts({ store, peers: [], peers_read: false }));
    expect(codeFor(report, "queue.abc-11111111")).toBe("QUEUE_OK");
    expect(report.checks.map((c) => c.code)).not.toContain("QUEUE_ORPHANED");
    db.close();
  });

  it("still flags genuinely orphaned mail when the peer table was read", () => {
    const db = makeDb();
    addMessage(db, { to_id: "ghost-1" });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(codeFor(buildDoctorReport(facts({ store, peers: [], peers_read: true })), "queue.ghost-1")).toBe("QUEUE_ORPHANED");
    db.close();
  });

  it("keeps a corrupt verdict when a later query trips over the same damage", () => {
    // quick_check passes on an in-memory db, so simulate the ordering directly: a store already judged corrupt
    // whose queue read then failed must not be downgraded to "unreadable".
    const store: StoreFacts = {
      ...emptyStore, integrity: "corrupt", integrity_detail: "page 4 is never used",
      queues_read: false, read_error: "database disk image is malformed",
    };
    const report = buildDoctorReport(facts({ store }));
    expect(codeFor(report, "store.integrity")).toBe("STORE_CORRUPT");
    // The remediation must be the recovery one, not "check file permissions".
    expect(report.checks.find((c) => c.id === "store.integrity")?.remediation).toContain("recover");
    // And the queue section reports the read failure it actually hit.
    const queue = report.checks.find((c) => c.id === "queue");
    expect(queue?.code).toBe("QUEUE_UNAVAILABLE");
    expect(queue?.detail).toContain("malformed");
  });

  it("reclassifies only a store that passed quick_check when its queue read fails", () => {
    const db = makeDb();
    db.run("DROP TABLE messages");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT)"); // no sent_at: query throws
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(store.integrity).toBe("unreadable");
    expect(store.queues_read).toBe(false);
    expect(store.read_error).not.toBeNull();
    db.close();
  });

  it("flags an ancient poll-only row hiding behind a not-yet-due pushable one", async () => {
    const db = makeDb();
    addPeer(db, { delivery_kind: "tmux", tmux_pane: "%3" });
    // An fyi from six hours ago that nothing will ever push...
    addMessage(db, { sent_at: new Date(NOW - 6 * 3_600_000).toISOString(), push_after: null, urgency: "fyi" });
    // ...alongside a fresh pushable row whose deadline has not arrived, which used to mask it.
    addMessage(db, { sent_at: new Date(NOW - 1000).toISOString(), push_after: NOW + 60_000 });
    const peers = await resolvePeerFacts(readStoredPeers(db), {
      nowMs: NOW, isPidAlive: () => true, probePane: async () => classifyPaneReadiness("node"),
    });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(store.queues[0]?.oldest_due_ms).toBe(0);                       // the pushable row is not due
    expect(store.queues[0]?.oldest_poll_only_age_ms).toBe(6 * 3_600_000); // the fyi is ancient
    expect(codeFor(buildDoctorReport(facts({ peers, store })), "queue.abc-11111111")).toBe("QUEUE_BACKLOG_STALE");
    db.close();
  });

  it("leaves a fresh poll-only row alone", async () => {
    const db = makeDb();
    addPeer(db, { delivery_kind: "tmux", tmux_pane: "%3" });
    addMessage(db, { sent_at: new Date(NOW - 5000).toISOString(), push_after: null, urgency: "fyi" });
    const peers = await resolvePeerFacts(readStoredPeers(db), {
      nowMs: NOW, isPidAlive: () => true, probePane: async () => classifyPaneReadiness("node"),
    });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    expect(codeFor(buildDoctorReport(facts({ peers, store })), "queue.abc-11111111")).toBe("QUEUE_OK");
    db.close();
  });
});

describe("doctor: healthy state", () => {
  it("passes every check on a healthy node and exits 0", async () => {
    const db = makeDb();
    addPeer(db, { delivery_kind: "tmux", tmux_pane: "%3" });
    addMessage(db);
    const peers = await resolvePeerFacts(readStoredPeers(db), {
      nowMs: NOW, isPidAlive: () => true, probePane: async () => classifyPaneReadiness("node"),
    });
    const store = readStoreFacts(db, "/tmp/peers.db", NOW, 3);
    const report = buildDoctorReport(facts({ peers, store }));
    expect(report.checks.filter((c) => c.severity !== "ok")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
    expect(codeFor(report, "peer.abc-11111111")).toBe("PEER_OK");
    expect(codeFor(report, "queue.abc-11111111")).toBe("QUEUE_OK");
    db.close();
  });

  it("gives every non-ok check a stable code and a remediation", () => {
    const report = buildDoctorReport(facts({
      config: { path: "/nope.json", loaded: false, defaulted: false, siblings_invalid: [], error: "boom" },
      broker: {
        url: "http://127.0.0.1:7899", reachable: false, error: "refused", status: null,
        protocol_version: null, machine: null, local_peer_count: null, remote_peer_count: null,
        serves_peers: null, serve_error: null,
      },
      store: { ...emptyStore, integrity: "corrupt", integrity_detail: "page 3 malformed" },
    }));
    for (const c of report.checks) {
      expect(c.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      if (c.severity !== "ok") expect(c.remediation).toBeTruthy();
    }
  });

  it("renders text output with one line per check", () => {
    const text = formatDoctorReport(buildDoctorReport(facts()));
    expect(text).toContain("claude-peers doctor");
    expect(text).toContain("BROKER_OK");
    expect(text).toContain("check(s) passed");
  });
});

describe("doctor: redaction", () => {
  it("scrubs bearer tokens and token-shaped hex out of foreign strings", () => {
    expect(redact(`failed with Authorization: Bearer ${"a".repeat(64)}`)).not.toContain("a".repeat(64));
    expect(redact(`store token ${"f".repeat(64)} rejected`)).toContain("[redacted]");
  });

  it("truncates an over-long foreign string", () => {
    expect(redact("x".repeat(500)).length).toBeLessThanOrEqual(201);
  });
});
