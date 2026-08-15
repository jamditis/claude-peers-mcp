import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { classifyPaneReadiness, ensureMessagesTable } from "../delivery.ts";
import {
  buildDoctorReport, formatDoctorReport, readStoredPeers, readStoreFacts, resolvePeerFacts,
} from "../shared/doctor.ts";
import { PROTOCOL_VERSION } from "../shared/types.ts";

const textExtensions = new Set([
  ".json",
  ".md",
  ".ps1",
  ".sh",
  ".service",
  ".ts",
  ".yml",
  ".yaml",
  "",
]);

function trackedFiles(): string[] {
  const proc = Bun.spawnSync({ cmd: ["git", "ls-files", "-z"], stdout: "pipe", stderr: "pipe" });
  if (!proc.success) {
    throw new Error(`git ls-files failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().split("\0").filter(Boolean);
}

function isTextFile(path: string): boolean {
  if (path === "bun.lock") return false;
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot);
  return textExtensions.has(ext);
}

// The repo owner and the upstream fork it credits are public by design — the
// project is published under that account and OSS attribution requires naming
// the upstream. Only genuinely private fleet identifiers (node names, the user
// home path, host-specific installer scripts) belong on this blocklist. The
// home-path entry below still catches the user dir as a leak; the bare owner
// handle on its own is not private.
const blockedLiterals = [
  ["old node name", ["house", "of", "jawn"].join("")],
  ["old node name", ["legion", "2025"].join("")],
  ["old user home", ["/home/", "jam", "ditis"].join("")],
  ["old windows installer name", ["install", "-", "host", "-", "d", ".ps1"].join("")],
  ["old windows task installer name", ["install", "-", "host", "-", "d", "-", "broker", "-", "task", ".ps1"].join("")],
] as const;

const blockedPatterns = [
  ["old alp node prefix", `\\b${["h", "oj"].join("")}-[a-z0-9]+\\b`],
  ["old beta node prefix", `\\b${["o", "fj"].join("")}-[a-z0-9]+\\b`],
  ["old windows node prefix", `\\b${["a", "40"].join("")}-[a-z0-9]+\\b`],
  ["old gam node prefix", `\\b${["l", "eg"].join("")}-[a-z0-9]+\\b`],
] as const;

describe("privacy scrub", () => {
  it("keeps known private names and host-specific examples out of tracked text files", async () => {
    const leaks: string[] = [];

    for (const path of trackedFiles().filter(isTextFile)) {
      const text = await Bun.file(path).text();
      const lower = text.toLowerCase();

      for (const [label, literal] of blockedLiterals) {
        if (lower.includes(literal.toLowerCase())) leaks.push(`${path}: ${label}`);
      }

      for (const [label, source] of blockedPatterns) {
        if (new RegExp(source, "i").test(text)) leaks.push(`${path}: ${label}`);
      }
    }

    expect(leaks).toEqual([]);
  });
});

// `bun cli.ts doctor` (issue #73) reads the same store the broker writes, so it sits one careless
// SELECT away from printing a capability token or a message body onto an operator's terminal (and
// into whatever paste or ticket that output lands in). These are the standing guards on that: the
// report is built from a store deliberately seeded with secrets, then both renderings are searched
// for them. A future check that widens a projection fails here.
describe("doctor output privacy", () => {
  const PEER_TOKEN = "d3adbeef".repeat(8);          // 64 hex chars, a real capability-token shape
  const LEASE_TOKEN = "leasetok12345678";
  const MESSAGE_TEXT = "launch codes and other message body text";
  const SUMMARY = "peer summary that is nobody else's business";
  const ENV_SECRET = "s3cr3t-env-value";

  async function renderDoctorOutput(): Promise<{ json: string; text: string }> {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, pid INTEGER NOT NULL, machine TEXT NOT NULL,
      tailscale_ip TEXT NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
      summary TEXT NOT NULL DEFAULT '', name TEXT, registered_at TEXT NOT NULL, last_seen TEXT NOT NULL,
      tmux_pane TEXT, tmux_socket TEXT, delivery_kind TEXT NOT NULL DEFAULT 'none', token TEXT
    )`);
    ensureMessagesTable(db);
    db.run(
      `INSERT INTO peers (id, pid, machine, tailscale_ip, cwd, git_root, tty, summary, name,
        registered_at, last_seen, tmux_pane, tmux_socket, delivery_kind, token)
       VALUES ('p-1', 999, 'node-a', '100.0.0.1', '/work', NULL, NULL, ?, 'alpha',
        ?, ?, '%1', NULL, 'tmux', ?)`,
      [SUMMARY, new Date(now - 1000).toISOString(), new Date(now).toISOString(), PEER_TOKEN] as never[],
    );
    db.run(
      `INSERT INTO messages (from_id, to_id, text, sent_at, delivery_state, lease_expires_at,
        lease_token, urgency, push_after) VALUES ('p-2', 'p-1', ?, ?, 'delivering', ?, ?, 'normal', ?)`,
      [MESSAGE_TEXT, new Date(now - 60_000).toISOString(), now - 30_000, LEASE_TOKEN, now] as never[],
    );

    // A private value that exists in the environment doctor runs in. Nothing in the report is
    // built from process.env, and this pins that: a check that started echoing the environment
    // (a "here is your config" dump, say) would surface it.
    process.env.CLAUDE_PEERS_TEST_SECRET = ENV_SECRET;

    const peers = await resolvePeerFacts(readStoredPeers(db), {
      nowMs: now,
      isPidAlive: () => true,
      probePane: async () => classifyPaneReadiness("node"),
    });
    const store = readStoreFacts(db, "/tmp/peers.db", now, 3);
    db.close();

    const report = buildDoctorReport({
      now_ms: now,
      expected_protocol: PROTOCOL_VERSION,
      push_delay_ms: 120_000,
      config: { path: "/etc/claude-peers.json", loaded: true, defaulted: false, error: null },
      broker: {
        url: "http://127.0.0.1:7899", reachable: true, error: null,
        status: "ok", protocol_version: PROTOCOL_VERSION, machine: "node-a",
        local_peer_count: 1, remote_peer_count: 0, serves_peers: true, serve_error: null,
      },
      siblings: [],
      peers,
      store,
    });
    return { json: JSON.stringify(report), text: formatDoctorReport(report) };
  }

  it("never prints a capability token, a lease token, a message body, or a peer summary", async () => {
    const { json, text } = await renderDoctorOutput();
    for (const secret of [PEER_TOKEN, LEASE_TOKEN, MESSAGE_TEXT, SUMMARY, ENV_SECRET]) {
      expect(json).not.toContain(secret);
      expect(text).not.toContain(secret);
    }
  });

  it("still reports the queue state those rows represent", async () => {
    const { json } = await renderDoctorOutput();
    // The stalled lease is diagnosed by id and age — the point of withholding the body is that
    // the diagnosis does not need it.
    expect(json).toContain("QUEUE_LEASE_STALLED");
  });
});
