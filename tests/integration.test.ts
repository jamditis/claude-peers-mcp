// tests/integration.test.ts

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe as bunDescribe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../shared/types.ts";

// #22: this suite drives a live broker through a shell-based `tmux` stub (a
// `#!/usr/bin/env bash` script made executable with `chmodSync(..., 0o755)`, see
// makeStubTmux below), which native Windows cannot exec, so the tmux-stub
// delivery tests fail there. Gate the whole broker+tmux integration suite behind
// a platform check: on win32 it skips instead of failing at exec time; on POSIX
// `skipIf(false)` is a no-op and every test runs exactly as before. This removes
// the bash-stub-exec failure class only. It is not on its own enough to make
// `bun test` pass on native Windows, because the remaining unit suites still
// hardcode `/tmp` paths (config/broker/delivery); that is tracked in #53.
const describe = bunDescribe.skipIf(process.platform === "win32");

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

const BROKER_A_PORT = 17899;
const BROKER_B_PORT = 17900;

const configA = {
  machine: "broker-a",
  tailscale_ip: "127.0.0.1",
  port: BROKER_A_PORT,
  id_prefix: "bra",
  siblings: [{ machine: "broker-b", url: `http://127.0.0.1:${BROKER_B_PORT}` }],
  allowed_ips: ["127.0.0.1"]
};

const configB = {
  machine: "broker-b",
  tailscale_ip: "127.0.0.1",
  port: BROKER_B_PORT,
  id_prefix: "brb",
  siblings: [{ machine: "broker-a", url: `http://127.0.0.1:${BROKER_A_PORT}` }],
  allowed_ips: ["127.0.0.1"]
};

let procA: any;
let procB: any;
// Captured at each broker's registration `it` so the later send/poll tests can authenticate as
// that real local peer (the control plane now binds each call to the session's token).
let fedAToken = "", fedBToken = "";

async function brokerFetch(port: number, path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`brokerFetch ${path} failed: ${res.status} ${res.statusText} - ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`brokerFetch non-JSON response from ${path}: ${text}`);
  }
}

// Distinct synthetic pids so co-registered peers in one test don't collide on the broker's
// same-pid supersede (handleRegister removes an existing row with the caller's pid). Based
// above Linux pid_max so each probes dead — fine for a sender, which only needs a token row.
// A peer that must actually RECEIVE a queued delivery needs a live pid: pass pid: process.pid.
let fakePid = 7_000_000;

// Register a peer and return { id, token } — the sender credential most send/unregister
// tests need now that the control plane authenticates the principal. Pass overrides to
// shape the row (e.g. pid: process.pid for a live delivery target; default is a queued-only
// peer on a distinct synthetic pid).
async function registerAndGetToken(port: number, overrides: Record<string, unknown> = {}) {
  const reg = await brokerFetch(port, "/register", {
    pid: ++fakePid, cwd: "/tmp/sender", git_root: null, tty: null, summary: "",
    machine: "x", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null,
    ...overrides,
  }) as { id: string; token: string };
  return reg;
}

// Raw POST that returns status + parsed body without throwing — for asserting 401s.
async function rawPost(port: number, path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = JSON.parse(await res.text()); } catch {}
  return { status: res.status, json };
}

// Insert a peer row with a NULL token straight into a broker's SQLite file, modelling a v2 peer
// whose row migrated forward before tokens existed. This is the only principal the unsigned grace
// may wave through without a token. The broker reads tokens per-call (a fresh SELECT), so it sees
// this NULL token immediately; a dead pid is fine because a sender is never a delivery target.
function insertLegacyPeer(dbPath: string, id: string, machine: string): void {
  const db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout=3000");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO peers (id, pid, machine, tailscale_ip, cwd, git_root, tty, summary, registered_at, last_seen, tmux_pane, tmux_socket, delivery_kind, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
  ).run(id, 999_999, machine, "127.0.0.1", "/tmp/legacy", null, null, "", now, now, null, null, "none");
  db.close();
}

// These federation cases spawn two real broker subprocesses and wait on cross-broker
// gossip, so they need a longer budget than the default per-test timeout. Bun takes the
// timeout as a numeric arg on each hook/test (describe itself takes no options object).
const FED_TIMEOUT_MS = 30_000;

describe("two-broker federation", () => {
  beforeAll(async () => {
    await Bun.write("/tmp/config-a.json", JSON.stringify(configA));
    await Bun.write("/tmp/config-b.json", JSON.stringify(configB));

    try { unlinkSync("/tmp/broker-a.db"); } catch {}
    try { unlinkSync("/tmp/broker-b.db"); } catch {}

    procA = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-a.json", CLAUDE_PEERS_DB: "/tmp/broker-a.db" },
      stdout: "ignore",
      stderr: "inherit",
    });

    procB = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-b.json", CLAUDE_PEERS_DB: "/tmp/broker-b.db" },
      stdout: "ignore",
      stderr: "inherit",
    });

    // Wait for both brokers to be ready
    let brokersReady = false;
    for (let i = 0; i < 20; i++) {
      try {
        const resA = await fetch(`http://127.0.0.1:${BROKER_A_PORT}/health`);
        const resB = await fetch(`http://127.0.0.1:${BROKER_B_PORT}/health`);
        if (resA.ok && resB.ok) {
          brokersReady = true;
          break;
        }
      } catch {
        // ignore, retry
      }
      await new Promise(r => setTimeout(r, 300));
    }
    if (!brokersReady) {
      throw new Error("Brokers failed to become ready within allotted time");
    }
  }, FED_TIMEOUT_MS);

  afterAll(() => {
    procA?.kill();
    procB?.kill();
    // Clean up temp files
    try { unlinkSync("/tmp/broker-a.db"); } catch {}
    try { unlinkSync("/tmp/broker-b.db"); } catch {}
    try { unlinkSync("/tmp/config-a.json"); } catch {}
    try { unlinkSync("/tmp/config-b.json"); } catch {}
  });

  it("registers a peer on broker A", async () => {
    const result = await brokerFetch(BROKER_A_PORT, "/register", {
      pid: process.pid,
      cwd: "/tmp/test-a",
      git_root: null,
      tty: null,
      summary: "test peer on A",
      machine: "broker-a",
      tailscale_ip: "127.0.0.1",
    });
    expect(result.id).toMatch(/^bra-/);
    fedAToken = result.token;
  }, FED_TIMEOUT_MS);

  it("registers a peer on broker B", async () => {
    const result = await brokerFetch(BROKER_B_PORT, "/register", {
      pid: process.pid,
      cwd: "/tmp/test-b",
      git_root: null,
      tty: null,
      summary: "test peer on B",
      machine: "broker-b",
      tailscale_ip: "127.0.0.1",
      name: "billing-b",
    });
    expect(result.id).toMatch(/^brb-/);
    fedBToken = result.token;
  }, FED_TIMEOUT_MS);

  it("gossip syncs peers between brokers", async () => {
    const maxWaitMs = 15_000;
    const pollIntervalMs = 300;
    const start = Date.now();

    while (true) {
      const peersOnA = await brokerFetch(BROKER_A_PORT, "/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      }) as any[];

      const remotePeer = peersOnA.find((p: any) => p.machine === "broker-b");
      if (remotePeer) {
        expect(remotePeer.is_remote).toBeTruthy();
        // The friendly name registered on B federated across the gossip boundary to A.
        expect(remotePeer.name).toBe("billing-b");
        return;
      }

      if (Date.now() - start > maxWaitMs) {
        throw new Error(
          `Timed out waiting for gossip sync. Peers on A: ${JSON.stringify(peersOnA)}`
        );
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
  }, FED_TIMEOUT_MS);

  it("sends a cross-broker message", async () => {
    const peersOnA = await brokerFetch(BROKER_A_PORT, "/list-peers", { scope: "machine", cwd: "/", git_root: null }) as any[];
    const peersOnB = await brokerFetch(BROKER_B_PORT, "/list-peers", { scope: "machine", cwd: "/", git_root: null }) as any[];

    const localA = peersOnA.find((p: any) => p.machine === "broker-a" && !p.is_remote);
    const localB = peersOnB.find((p: any) => p.machine === "broker-b" && !p.is_remote);

    const sendResult = await brokerFetch(BROKER_A_PORT, "/send-message", {
      from_id: localA.id,
      to_id: localB.id,
      text: "hello from broker A",
    }, fedAToken) as any;
    expect(sendResult.ok).toBe(true);
    expect(sendResult.routed).toBe("remote");

    const pollResult = await brokerFetch(BROKER_B_PORT, "/poll-messages", { id: localB.id }, fedBToken) as any;
    expect(pollResult.messages).toHaveLength(1);
    expect(pollResult.messages[0].text).toBe("hello from broker A");
    expect(pollResult.messages[0].from_id).toBe(localA.id);
  }, FED_TIMEOUT_MS);

  it("reports error when forwarding to unknown remote peer", async () => {
    const peersOnA = await brokerFetch(BROKER_A_PORT, "/list-peers", { scope: "machine", cwd: "/", git_root: null }) as any[];
    const localA = peersOnA.find((p: any) => !p.is_remote);

    const sendResult = await brokerFetch(BROKER_A_PORT, "/send-message", {
      from_id: localA.id,
      to_id: "brb-nonexist",
      text: "this should fail",
    }, fedAToken) as any;
    expect(sendResult.ok).toBe(false);
  }, FED_TIMEOUT_MS);

  it("graceful shutdown clears remote peers on sibling", async () => {
    const beforePeers = await brokerFetch(BROKER_A_PORT, "/list-peers", { scope: "machine", cwd: "/", git_root: null }) as any[];
    const remoteBefore = beforePeers.filter((p: any) => p.is_remote);
    expect(remoteBefore.length).toBeGreaterThan(0);

    // Kill broker B with SIGTERM (triggers graceful shutdown with empty gossip)
    procB?.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 2000));

    const afterPeers = await brokerFetch(BROKER_A_PORT, "/list-peers", { scope: "machine", cwd: "/", git_root: null }) as any[];
    const remoteAfter = afterPeers.filter((p: any) => p.machine === "broker-b");
    expect(remoteAfter).toHaveLength(0);
  }, FED_TIMEOUT_MS);
});

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
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/d1-s" });
    const send = await brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: reg.id, text: "hello tmux",
    }, sender.token) as any;
    expect(send.ok).toBe(true);
    expect(send.delivery).toBe("accepted");
    const poll = await brokerFetch(PORT, "/poll-messages", { id: reg.id }, reg.token) as any;
    expect(poll.messages).toHaveLength(0);
    const log = readFileSync(stub.logFile, "utf-8");
    expect(log).toContain("%9");
    expect(log).toContain("hello tmux");
  });

  it("leaves a none peer queued and retrievable via check_messages", async () => {
    const reg = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/d2", git_root: null, tty: null, summary: "",
      machine: "del-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null,
    }) as any;
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/d2-s" });
    const send = await brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: reg.id, text: "floor me",
    }, sender.token) as any;
    expect(send.delivery).toBe("queued");
    const poll = await brokerFetch(PORT, "/poll-messages", { id: reg.id }, reg.token) as any;
    expect(poll.messages).toHaveLength(1);
    expect(poll.messages[0].text).toBe("floor me");
  });

  it("resolves a shared session name to the one visible peer, excluding the sender (#38)", async () => {
    // Bug guard: the name-resolution candidate set must drop the caller (body.from_id), exactly
    // as list_peers hides the caller via exclude_id. A sender that shares a session name with one
    // visible target sees a single match in list_peers, so send_message must resolve that name to
    // the target — not count the caller's own hidden row and report a false "ambiguous".
    const target = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/twin-t", git_root: null, tty: null, summary: "",
      machine: "del-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null,
      name: "twin",
    }) as any;
    // The sender must itself be a live, visible peer for the false ambiguity to be possible, so
    // give it a real, distinct pid (a throwaway child) rather than the default dead synthetic one.
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      const sender = await registerAndGetToken(PORT, { pid: child.pid, cwd: "/tmp/twin-s", name: "twin" });
      const send = await brokerFetch(PORT, "/send-message", {
        from_id: sender.id, to_id: "twin", text: "resolve me",
      }, sender.token) as any;
      expect(send.ok).toBe(true); // not the "matches N peers by name" ambiguity error
      expect(send.routed).toBe("local");
      const poll = await brokerFetch(PORT, "/poll-messages", { id: target.id }, target.token) as any;
      expect(poll.messages).toHaveLength(1);
      expect(poll.messages[0].text).toBe("resolve me");
    } finally {
      child.kill();
    }
  });
});

// The invariant the whole feature exists to protect: a push that tmux rejects must
// never mark the message delivered. It stays queued and stays retrievable. This
// reproduces the original silent-consume bug and must stay green forever.
describe("silent-consume regression", () => {
  const PORT = 17907;
  let proc: any;
  let dir: string;
  let logFile: string;

  beforeAll(async () => {
    // A stub tmux that reports a version (so the broker sees tmux as available and
    // attempts the push) but fails every send-keys. This drives the real failure
    // path — push tried, push rejected — rather than the trivial tmux-absent path.
    dir = mkdtempSync(join(tmpdir(), "fail-tmux-"));
    logFile = join(dir, "calls.log");
    const stub = join(dir, "tmux");
    writeFileSync(stub, `#!/usr/bin/env bash\nif [ "$1" = "-V" ]; then echo "tmux 3.4"; exit 0; fi\nprintf '%s\\0' "$@" >> "${logFile}"\nexit 1\n`);
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
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/reg1-s" });
    const send = await brokerFetch(PORT, "/send-message", { from_id: sender.id, to_id: reg.id, text: "must not vanish" }, sender.token) as any;
    expect(send.delivery).toBe("queued"); // push failed => not accepted
    // The push was actually attempted (not short-circuited by an absent tmux).
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("%4");
    expect(log).toContain("must not vanish");
    // And the message is still retrievable — it was NOT silently consumed.
    const poll = await brokerFetch(PORT, "/poll-messages", { id: reg.id }, reg.token) as any;
    expect(poll.messages).toHaveLength(1);
    expect(poll.messages[0].text).toBe("must not vanish");
  });
});

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
    expect(h.protocol_version).toBe(PROTOCOL_VERSION);
  });

  it("retire drains and exits even with a peer registered", async () => {
    await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/v1", git_root: null, tty: null, summary: "",
      machine: "ver-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null,
    });
    const r = await brokerFetch(PORT, "/retire", {}) as any;
    expect(r.ok).toBe(true);
    let down = false;
    for (let i = 0; i < 20; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) }); }
      catch { down = true; break; }
      await new Promise((res) => setTimeout(res, 200));
    }
    expect(down).toBe(true);
  });
});

describe("dead push path removed", () => {
  it("server.ts has no poll loop, channel push, or CLAUDE_PEERS_CHANNEL", () => {
    const src = readFileSync("server.ts", "utf-8");
    expect(src).not.toContain("pollAndPushMessages");
    expect(src).not.toContain("CLAUDE_PEERS_CHANNEL");
    expect(src).not.toContain("notifications/claude/channel");
  });
  it("broker.ts no longer serves /peek-messages or /ack-messages", () => {
    const src = readFileSync("broker.ts", "utf-8");
    expect(src).not.toContain("/peek-messages");
    expect(src).not.toContain("/ack-messages");
  });
  it("server.ts cleans up when the stdio host disconnects", () => {
    const src = readFileSync("server.ts", "utf-8");
    expect(src).toContain('process.stdin.once("end"');
    expect(src).toContain('process.stdin.once("close"');
    expect(src).toContain("cleanupStarted");
  });
});

// Empty-broker self-exit (Task 14). Opt-in via a positive CLAUDE_PEERS_IDLE_EXIT_MS;
// disabled by default so a Restart=always systemd unit never self-exits into a loop.
describe("empty-broker self-exit", () => {
  it("comes up, then self-exits after the idle window with no peers", async () => {
    const PORT = 17908;
    await Bun.write("/tmp/config-exit.json", JSON.stringify({
      machine: "exit-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "exa",
      siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync("/tmp/broker-exit.db"); } catch {}
    const proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-exit.json",
             CLAUDE_PEERS_DB: "/tmp/broker-exit.db", CLAUDE_PEERS_IDLE_EXIT_MS: "2500" },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      // Phase 1: prove the broker actually launched. Without this, a broker that
      // failed to start looks identical to one that self-exited (both: /health
      // refused), which is a false pass. /health does not count as activity, so
      // these probes do not extend the idle window.
      let up = false;
      for (let i = 0; i < 30; i++) {
        try { if ((await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) })).ok) { up = true; break; } } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(up).toBe(true);
      // Phase 2: with no peers and no activity, it self-exits after the idle window.
      let down = false;
      for (let i = 0; i < 40; i++) {
        try { await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) }); }
        catch { down = true; break; }
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(down).toBe(true);
    } finally {
      proc.kill();
      try { unlinkSync("/tmp/broker-exit.db"); } catch {}
      try { unlinkSync("/tmp/config-exit.json"); } catch {}
    }
  }, 25_000);

  it("stays up while a heartbeat-stale live peer is inside prune grace", async () => {
    const PORT = 17933;
    const CONFIG = "/tmp/config-exit-stale-grace.json";
    const DB = "/tmp/broker-exit-stale-grace.db";
    const PEER_ID = "exg-stale00";
    await Bun.write(CONFIG, JSON.stringify({
      machine: "exg-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "exg",
      siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync(DB); } catch {}

    const db = new Database(DB);
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, pid INTEGER NOT NULL, machine TEXT NOT NULL,
      tailscale_ip TEXT NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
      summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL,
      tmux_pane TEXT, tmux_socket TEXT, delivery_kind TEXT NOT NULL DEFAULT 'none', token TEXT
    )`);
    const stale = new Date(Date.now() - 120_000).toISOString();
    db.prepare(
      "INSERT INTO peers (id, pid, machine, tailscale_ip, cwd, git_root, tty, summary, registered_at, last_seen, tmux_pane, tmux_socket, delivery_kind, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(PEER_ID, process.pid, "exg-a", "127.0.0.1", "/tmp/exit-stale-grace", null, null, "stale", stale, stale, null, null, "none", "stale-token");
    db.close();

    const proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG,
             CLAUDE_PEERS_DB: DB, CLAUDE_PEERS_IDLE_EXIT_MS: "2500",
             CLAUDE_PEERS_STALE_PRUNE_GRACE_MS: "10000" },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      let up = false;
      for (let i = 0; i < 30; i++) {
        try { if ((await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) })).ok) { up = true; break; } } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(up).toBe(true);

      await new Promise((r) => setTimeout(r, 3_500));
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(500) });
      expect(res.ok).toBe(true);
    } finally {
      proc.kill();
      try { unlinkSync(DB); } catch {}
      try { unlinkSync(CONFIG); } catch {}
    }
  }, 15_000);

  it("self-exits when only prune-ready heartbeat-stale peers remain", async () => {
    const PORT = 17932;
    const CONFIG = "/tmp/config-exit-stale.json";
    const DB = "/tmp/broker-exit-stale.db";
    const PEER_ID = "exs-stale00";
    await Bun.write(CONFIG, JSON.stringify({
      machine: "exs-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "exs",
      siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync(DB); } catch {}

    const db = new Database(DB);
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, pid INTEGER NOT NULL, machine TEXT NOT NULL,
      tailscale_ip TEXT NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
      summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL,
      tmux_pane TEXT, tmux_socket TEXT, delivery_kind TEXT NOT NULL DEFAULT 'none', token TEXT
    )`);
    const stale = new Date(Date.now() - 120_000).toISOString();
    db.prepare(
      "INSERT INTO peers (id, pid, machine, tailscale_ip, cwd, git_root, tty, summary, registered_at, last_seen, tmux_pane, tmux_socket, delivery_kind, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(PEER_ID, process.pid, "exs-a", "127.0.0.1", "/tmp/exit-stale", null, null, "stale", stale, stale, null, null, "none", "stale-token");
    db.close();

    const proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG,
             CLAUDE_PEERS_DB: DB, CLAUDE_PEERS_IDLE_EXIT_MS: "2500",
             CLAUDE_PEERS_STALE_PRUNE_GRACE_MS: "1000" },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      let up = false;
      for (let i = 0; i < 30; i++) {
        try { if ((await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) })).ok) { up = true; break; } } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(up).toBe(true);

      let down = false;
      for (let i = 0; i < 40; i++) {
        try { await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) }); }
        catch { down = true; break; }
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(down).toBe(true);
    } finally {
      proc.kill();
      try { unlinkSync(DB); } catch {}
      try { unlinkSync(CONFIG); } catch {}
    }
  }, 25_000);

  it("stays up with CLAUDE_PEERS_IDLE_EXIT_MS=0 even when idle (systemd-safe default)", async () => {
    const PORT = 17909;
    await Bun.write("/tmp/config-noexit.json", JSON.stringify({
      machine: "noexit-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "nxa",
      siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync("/tmp/broker-noexit.db"); } catch {}
    const proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-noexit.json",
             CLAUDE_PEERS_DB: "/tmp/broker-noexit.db", CLAUDE_PEERS_IDLE_EXIT_MS: "0" },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      let up = false;
      for (let i = 0; i < 25; i++) {
        try { if ((await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) })).ok) { up = true; break; } } catch {}
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(up).toBe(true);
      // Wait well past any plausible short idle window, then confirm still alive.
      await new Promise((r) => setTimeout(r, 4_000));
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(500) });
      expect(res.ok).toBe(true);
    } finally {
      proc.kill();
      try { unlinkSync("/tmp/broker-noexit.db"); } catch {}
      try { unlinkSync("/tmp/config-noexit.json"); } catch {}
    }
  }, 15_000);
});

// A recipient's own /unregister must not tear down a delivery already in flight to it.
// If it deletes the peer row while a tmux send-keys is mid-spawn, the lease resolves
// against a now-missing peer: peerStillLive() rejects, releaseToQueued() requeues the
// row under the deleted id, and nothing — no heartbeat, no check_messages — can ever
// drain it until the 24h prune. So the whole unregister defers the row's deletion while
// mid-delivery, but the peer is logically gone: hidden from listings and refusing new
// mail (a fresh send would be queued under a doomed id and dropped when the deferred
// delete fires). The row is kept ONLY so the in-flight lease can settle; deliverNext's
// finally then reaps it. A tmux stub that parks on a fifo makes the in-flight window
// deterministic (marker file + fifo handshake — no sleeps, no timing guesses).
describe("unregister during in-flight delivery defers peer deletion", () => {
  const PORT = 17910;
  let proc: any;
  let dir: string;
  let fifo: string;
  let marker: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "block-tmux-"));
    fifo = join(dir, "gate.fifo");
    marker = join(dir, "started");
    Bun.spawnSync(["mkfifo", fifo]);
    const stub = join(dir, "tmux");
    // -V answers the availability probe and returns at once; display-message answers the
    // pre-send readiness probe with a Claude-like foreground (node) so the inject proceeds.
    // Only the real send-keys invocation signals it started (marker), then blocks reading
    // the fifo until the test releases it, holding the delivery in flight as long as needed.
    writeFileSync(stub,
      `#!/usr/bin/env bash\n` +
      `if [ "$1" = "-V" ]; then echo "tmux 3.4"; exit 0; fi\n` +
      `if [ "$1" = "display-message" ]; then echo node; exit 0; fi\n` +
      `echo started > "${marker}"\n` +
      `cat "${fifo}" > /dev/null\n` +
      `exit 0\n`);
    chmodSync(stub, 0o755);
    await Bun.write(join(dir, "config.json"), JSON.stringify({
      machine: "unreg-a", tailscale_ip: "127.0.0.1", port: PORT,
      id_prefix: "ura", siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: {
        ...process.env,
        CLAUDE_PEERS_CONFIG: join(dir, "config.json"),
        CLAUDE_PEERS_DB: join(dir, "broker.db"),
        PATH: `${dir}:${process.env.PATH}`, // stub tmux wins
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
  });

  it("hides the unregistered peer and refuses new mail, but settles the in-flight lease", async () => {
    // pid = this live process so list-peers does not filter the peer for being dead.
    const reg = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/u1", git_root: null, tty: null, summary: "",
      machine: "unreg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%5", tmux_socket: null,
    }) as any;

    // A registered sender (distinct pid so it does not supersede reg) authenticates both sends.
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/u1-s" });

    // Fire the send WITHOUT awaiting: the broker claims the lease, spawns the stub, and
    // parks on the fifo — the delivery is now in flight and /send-message stays pending.
    const sendPromise = brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: reg.id, text: "in flight",
    }, sender.token);

    let inflight: any;
    try {
      // Wait for the stub to signal start: a deterministic "now in flight" edge.
      for (let i = 0; i < 60 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(marker)).toBe(true);

      // Recipient unregisters mid-delivery. The row is deferred (kept for the lease), but the
      // peer is logically gone from this point.
      await brokerFetch(PORT, "/unregister", { id: reg.id }, reg.token);

      // It must not appear in listings — a peer that said "I'm leaving" should not be offered.
      const peers = await brokerFetch(PORT, "/list-peers", {
        scope: "machine", cwd: "/tmp/u1", git_root: null,
      }) as any[];
      expect(peers.some((p) => p.id === reg.id)).toBe(false);

      // And a NEW send to it must be refused, not accepted-then-dropped: the deferred delete
      // would wipe the row plus any mail queued under it, so an ok here would be a silent loss.
      const newSend = await brokerFetch(PORT, "/send-message", {
        from_id: sender.id, to_id: reg.id, text: "after unregister",
      }, sender.token) as any;
      expect(newSend.ok).toBe(false);
    } finally {
      // Release the parked delivery so the broker is not left holding it for teardown.
      if (existsSync(marker)) {
        writeFileSync(fifo, "go");
        inflight = await sendPromise.catch((e) => ({ error: String(e) }));
      }
    }

    // The in-flight lease still resolved against the kept row — proof the deferral protected
    // the active delivery (had the row been deleted on unregister, it would have requeued).
    expect(inflight?.delivery).toBe("accepted");
  }, 15_000);
});

// Finding #58/P2: the post-send confirmation must not requeue an already-pasted message just
// because the recipient's heartbeat aged past the TTL during the ~2s send. peerStillLive() folded
// heartbeat staleness into the confirm check, so a live peer whose last_seen crossed the TTL while
// send-keys was in flight had its delivered message released back to 'queued' — and redelivered
// once it heartbeated again (a duplicate). peerConfirmable() checks only row-presence + a live pid,
// so the send confirms. The fifo stub holds the delivery in flight while the test ages last_seen
// past the TTL in the broker DB, making the race deterministic without a real 45s wait.
describe("post-send confirm ignores heartbeat aging (no duplicate delivery)", () => {
  const PORT = 17934;
  let proc: any;
  let dir: string;
  let fifo: string;
  let marker: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "block-tmux-confirm-"));
    fifo = join(dir, "gate.fifo");
    marker = join(dir, "started");
    Bun.spawnSync(["mkfifo", fifo]);
    const stub = join(dir, "tmux");
    writeFileSync(stub,
      `#!/usr/bin/env bash\n` +
      `if [ "$1" = "-V" ]; then echo "tmux 3.4"; exit 0; fi\n` +
      `if [ "$1" = "display-message" ]; then echo node; exit 0; fi\n` +
      `echo started > "${marker}"\n` +
      `cat "${fifo}" > /dev/null\n` +
      `exit 0\n`);
    chmodSync(stub, 0o755);
    await Bun.write(join(dir, "config.json"), JSON.stringify({
      machine: "confirm-a", tailscale_ip: "127.0.0.1", port: PORT,
      id_prefix: "cfa", siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: {
        ...process.env,
        CLAUDE_PEERS_CONFIG: join(dir, "config.json"),
        CLAUDE_PEERS_DB: join(dir, "broker.db"),
        PATH: `${dir}:${process.env.PATH}`, // stub tmux wins
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
  });

  it("confirms a delivery whose recipient heartbeat crossed the TTL mid-send", async () => {
    // pid = this live process so peerConfirmable() sees a live pid and list-peers does not filter it.
    const reg = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/cf1", git_root: null, tty: null, summary: "",
      machine: "confirm-a", tailscale_ip: "127.0.0.1", tmux_pane: "%5", tmux_socket: null,
    }) as any;
    // A registered sender (distinct pid so it does not supersede reg) authenticates the send.
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/cf1-s" });

    // Fire the send WITHOUT awaiting: last_seen is fresh, so the ingress liveness gate passes, the
    // broker claims the lease, spawns the stub, and parks on the fifo — the delivery is in flight.
    const sendPromise = brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: reg.id, text: "in flight",
    }, sender.token);

    let inflight: any;
    try {
      for (let i = 0; i < 60 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(marker)).toBe(true);

      // While the send is parked mid-flight, age the recipient's heartbeat past the 45s TTL: the
      // deterministic stand-in for "last_seen crossed the TTL during the send". The text is already
      // being pasted; only the post-send confirm has yet to run. recipientsInFlight protects the
      // row from the cleanup sweep, and the pid stays alive, so this is purely a heartbeat-age flip.
      const db = new Database(join(dir, "broker.db"));
      db.exec("PRAGMA busy_timeout=3000");
      const staleIso = new Date(Date.now() - 60_000).toISOString();
      db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run(staleIso, reg.id);
      db.close();
    } finally {
      if (existsSync(marker)) {
        writeFileSync(fifo, "go");
        inflight = await sendPromise.catch((e) => ({ error: String(e) }));
      }
    }

    // Live pid + present row: the aged heartbeat must not requeue the already-pasted message. Under
    // the old peerStillLive() confirm this returned "queued" and the message would be delivered a
    // second time once the peer heartbeated again.
    expect(inflight?.delivery).toBe("accepted");
  }, 15_000);
});

// Same orphan race as unregister, but via the other teardown path: a same-pid re-register
// supersedes the old peer row. If it deletes that row while a delivery to the old id is in
// flight, the lease resolves against a missing peer and the message orphans under a dead id.
// The fix defers the old peer's removal (removePeerOrDefer) until the lease frees. The fifo
// stub holds the delivery in flight while the re-register lands, deterministically.
describe("same-pid re-register during in-flight delivery defers old-peer deletion", () => {
  const PORT = 17911;
  let proc: any;
  let dir: string;
  let fifo: string;
  let marker: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "block-tmux-rereg-"));
    fifo = join(dir, "gate.fifo");
    marker = join(dir, "started");
    Bun.spawnSync(["mkfifo", fifo]);
    const stub = join(dir, "tmux");
    writeFileSync(stub,
      `#!/usr/bin/env bash\n` +
      `if [ "$1" = "-V" ]; then echo "tmux 3.4"; exit 0; fi\n` +
      `if [ "$1" = "display-message" ]; then echo node; exit 0; fi\n` +
      `echo started > "${marker}"\n` +
      `cat "${fifo}" > /dev/null\n` +
      `exit 0\n`);
    chmodSync(stub, 0o755);
    await Bun.write(join(dir, "config.json"), JSON.stringify({
      machine: "rereg-a", tailscale_ip: "127.0.0.1", port: PORT,
      id_prefix: "rra", siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: {
        ...process.env,
        CLAUDE_PEERS_CONFIG: join(dir, "config.json"),
        CLAUDE_PEERS_DB: join(dir, "broker.db"),
        PATH: `${dir}:${process.env.PATH}`, // stub tmux wins
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
  });

  it("hides the superseded old id and refuses new mail to it, but settles its in-flight lease", async () => {
    const reg1 = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/rr1", git_root: null, tty: null, summary: "",
      machine: "rereg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%5", tmux_socket: null,
    }) as any;

    // A registered sender (distinct pid so it does not collide with reg1/reg2's pid) authenticates.
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/rr1-s" });

    // In-flight delivery to the first id, parked on the fifo.
    const sendPromise = brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: reg1.id, text: "in flight",
    }, sender.token);

    let reg2: any;
    let inflight: any;
    try {
      for (let i = 0; i < 60 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(marker)).toBe(true);

      // Same pid re-registers mid-delivery, superseding the old id. The old row is deferred
      // (kept for the in-flight lease) but logically gone — the live session is now reg2.
      reg2 = await brokerFetch(PORT, "/register", {
        pid: process.pid, cwd: "/tmp/rr1", git_root: null, tty: null, summary: "",
        machine: "rereg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%6", tmux_socket: null,
      }) as any;
      expect(reg2.id).not.toBe(reg1.id); // a genuinely new session id

      const during = await brokerFetch(PORT, "/list-peers", {
        scope: "machine", cwd: "/tmp/rr1", git_root: null,
      }) as any[];
      expect(during.some((p) => p.id === reg1.id)).toBe(false); // old id superseded, hidden
      expect(during.some((p) => p.id === reg2.id)).toBe(true);  // new id is the live session

      // A NEW send to the superseded old id must be refused. It shares the pid/pane with reg2,
      // so peerStillLive() alone would wrongly accept it; the deferred-delete guard rejects it
      // instead, so mail is not queued under a doomed id and dropped when the row is reaped.
      const newSend = await brokerFetch(PORT, "/send-message", {
        from_id: sender.id, to_id: reg1.id, text: "to the old id",
      }, sender.token) as any;
      expect(newSend.ok).toBe(false);
    } finally {
      if (existsSync(marker)) {
        writeFileSync(fifo, "go");
        inflight = await sendPromise.catch((e) => ({ error: String(e) }));
      }
    }

    // The original in-flight delivery still resolved against the kept row (deferral protected
    // the active lease), then the deferred old peer is reaped while the new session remains.
    expect(inflight?.delivery).toBe("accepted");
    const after = await brokerFetch(PORT, "/list-peers", {
      scope: "machine", cwd: "/tmp/rr1", git_root: null,
    }) as any[];
    expect(after.some((p) => p.id === reg1.id)).toBe(false);
    expect(after.some((p) => p.id === reg2.id)).toBe(true);
  }, 15_000);
});

// Shutdown (retire / idle self-exit) must drain an in-flight cross-machine forward, not
// only tmux deliveries. handleSendMessage awaits fetch(sibling/forward-message); if the
// shutdown predicate ignores that send, a concurrent retire (an upgrade handshake or
// SIGTERM) stops the server and process.exit(0)s mid-forward, so the message can be lost
// before it reaches the sibling. The broker must stay up draining while the forward runs.
describe("retire waits for an in-flight remote forward", () => {
  const PORT = 17912;
  const STUB_PORT = 17913;
  let proc: any;
  let stub: any;
  let marker: string;

  beforeAll(async () => {
    marker = join(mkdtempSync(join(tmpdir(), "fwd-inflight-")), "hit");
    // A sibling stub that parks the /forward-message request forever (the broker's own 5s
    // AbortSignal bounds it). It touches a marker the instant the forward lands so the test
    // can confirm the send is in flight before triggering retire — no arbitrary sleep. Other
    // paths (the broker's periodic gossip) get a fast ok so they do not pile up parked.
    stub = Bun.serve({
      port: STUB_PORT,
      fetch(req) {
        if (new URL(req.url).pathname === "/forward-message") {
          writeFileSync(marker, "1");
          return new Promise<Response>(() => {}); // never resolves
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });

    await Bun.write("/tmp/config-fwd.json", JSON.stringify({
      machine: "fwd-s", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "fws",
      siblings: [{ machine: "hang-m", url: `http://127.0.0.1:${STUB_PORT}` }],
      allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync("/tmp/broker-fwd.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-fwd.json", CLAUDE_PEERS_DB: "/tmp/broker-fwd.db" },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  });

  afterAll(() => {
    proc?.kill();
    stub?.stop(true);
    try { unlinkSync("/tmp/broker-fwd.db"); } catch {}
    try { unlinkSync("/tmp/config-fwd.json"); } catch {}
  });

  it("stays up draining while a forward to a sibling is in flight", async () => {
    // Teach the broker about a remote peer on the hanging sibling so a send to it forwards
    // there instead of resolving locally.
    await brokerFetch(PORT, "/gossip", {
      protocol_version: 2, machine: "hang-m", tailscale_ip: "127.0.0.1",
      peers: [{ id: "hang-peer0", pid: 999999, cwd: "/tmp/h", git_root: null, tty: null,
        summary: "", registered_at: new Date().toISOString() }],
    });

    // A registered local sender authenticates the originating /send-message (the forward to the
    // sibling is federation-exempt, but the local accept is token-gated).
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/fwd-s" });

    // Fire the send WITHOUT awaiting: it parks inside handleSendMessage on the forward fetch.
    const sendPromise = brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: "hang-peer0", text: "in flight",
    }, sender.token).catch(() => {});

    // Wait until the stub confirms the forward is in flight, then retire.
    for (let i = 0; i < 60 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(marker)).toBe(true);
    await brokerFetch(PORT, "/retire", {});

    const stillUp = async () => {
      try { return (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) })).ok; }
      catch { return false; }
    };

    // ~900ms after retire the forward is still parked (bounded only by its abort timeout). A
    // broker that counts in-flight forwards is still in its drain loop and answers /health; a
    // broker that waited only on tmux deliveries has already exited.
    await new Promise((r) => setTimeout(r, 900));
    expect(await stillUp()).toBe(true);

    // ~4s in, past the old 3s drain deadline: the broker must STILL be draining, because the
    // forward's own timeout is 5s and a slow-but-successful forward must not be cut off. A
    // deadline that stopped at 3s would have exited by now and dropped a deliverable message.
    await new Promise((r) => setTimeout(r, 3_100));
    expect(await stillUp()).toBe(true);

    await sendPromise;
  }, 20_000);
});

// Idle self-exit (Task 14) reaps a broker with no LOCAL work. Sibling federation traffic
// (/gossip, /forward-message) must not refresh the idle clock, or a federated broker with no
// local peers would be kept alive forever by a sibling's periodic gossip and never reap itself.
describe("federation traffic does not defeat idle self-exit", () => {
  it("self-exits on the idle window despite a steady stream of sibling gossip", async () => {
    const PORT = 17914;
    await Bun.write("/tmp/config-fedidle.json", JSON.stringify({
      machine: "fed-idle", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "fdi",
      siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync("/tmp/broker-fedidle.db"); } catch {}
    const proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-fedidle.json",
             CLAUDE_PEERS_DB: "/tmp/broker-fedidle.db", CLAUDE_PEERS_IDLE_EXIT_MS: "2500" },
      stdout: "ignore", stderr: "ignore",
    });
    let gossiping = true;
    try {
      // Prove it launched (a broker that failed to start also refuses /health — a false pass).
      let up = false;
      for (let i = 0; i < 30; i++) {
        try { if ((await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) })).ok) { up = true; break; } } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(up).toBe(true);

      // Hammer it with sibling gossip faster than the idle window the whole time. Under the bug
      // each /gossip refreshes lastActivityAt, so the broker never goes idle; with the fix the
      // federation route does not count, so it reaps itself ~one idle window after startup.
      (async () => {
        while (gossiping) {
          try {
            await fetch(`http://127.0.0.1:${PORT}/gossip`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ protocol_version: 2, machine: "ghost-m", tailscale_ip: "127.0.0.1", peers: [] }),
              signal: AbortSignal.timeout(300),
            });
          } catch {}
          await new Promise((r) => setTimeout(r, 400));
        }
      })();

      // Despite the gossip stream it must self-exit (no local peers, no local activity).
      let down = false;
      for (let i = 0; i < 40; i++) {
        try { await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) }); }
        catch { down = true; break; }
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(down).toBe(true);
    } finally {
      gossiping = false;
      proc.kill();
      try { unlinkSync("/tmp/broker-fedidle.db"); } catch {}
      try { unlinkSync("/tmp/config-fedidle.json"); } catch {}
    }
  }, 25_000);
});

// A peer's row outlives its process between cleanup sweeps (Task 10 decoupled deletion from
// listing). A send or forward to that stale row must not be accepted-then-silently-dropped:
// the recipient is gone, the queued message is unreachable, and the next sweep deletes it, so
// an ok:true here is a false positive. Both accept paths re-check liveness, not just row
// existence, and report honestly.
describe("send/forward to a dead-but-unswept local peer is honest", () => {
  const PORT = 17915;
  let proc: any;

  beforeAll(async () => {
    await Bun.write("/tmp/config-deadlocal.json", JSON.stringify({
      machine: "dl-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "dla",
      siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync("/tmp/broker-deadlocal.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-deadlocal.json", CLAUDE_PEERS_DB: "/tmp/broker-deadlocal.db" },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  });

  afterAll(() => {
    proc?.kill();
    try { unlinkSync("/tmp/broker-deadlocal.db"); } catch {}
    try { unlinkSync("/tmp/config-deadlocal.json"); } catch {}
  });

  // Register a peer whose process is already dead, so its row exists but no live session can
  // ever poll the id. The next cleanup sweep is ~15s away, leaving the stale-row window open.
  async function registerDeadPeer(): Promise<string> {
    const dead = Bun.spawn(["sleep", "60"]);
    dead.kill();
    await dead.exited; // pid is now dead and reaped
    const reg = await brokerFetch(PORT, "/register", {
      pid: dead.pid, cwd: "/tmp/dl", git_root: null, tty: null, summary: "",
      machine: "dl-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null,
    }) as any;
    return reg.id;
  }

  it("does not falsely accept a /send-message to a local peer whose process is gone", async () => {
    const deadId = await registerDeadPeer();
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/dl-s" });
    const result = await brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: deadId, text: "to a ghost",
    }, sender.token) as any;
    expect(result.ok).toBe(false);
  }, 15_000);

  it("does not falsely accept a /forward-message to a local peer whose process is gone", async () => {
    const deadId = await registerDeadPeer();
    const result = await brokerFetch(PORT, "/forward-message", {
      protocol_version: 2, from_id: "remote-sender0", to_id: deadId,
      text: "forwarded to a ghost", from_machine: "other-machine",
    }) as any;
    expect(result.ok).toBe(false);
  }, 15_000);
});

describe("broker restart preserves live peers until they can heartbeat", () => {
  const PORT = 17930;
  const CONFIG = "/tmp/config-restartlive.json";
  const DB = "/tmp/broker-restartlive.db";
  const PEER_ID = "rst-live000";
  const TOKEN = "survivor-token";
  let proc: any;

  beforeAll(async () => {
    await Bun.write(CONFIG, JSON.stringify({
      machine: "rst-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "rst",
      siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync(DB); } catch {}

    const db = new Database(DB);
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, pid INTEGER NOT NULL, machine TEXT NOT NULL,
      tailscale_ip TEXT NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
      summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL,
      tmux_pane TEXT, tmux_socket TEXT, delivery_kind TEXT NOT NULL DEFAULT 'none', token TEXT
    )`);
    const stale = new Date(Date.now() - 120_000).toISOString();
    db.prepare(
      "INSERT INTO peers (id, pid, machine, tailscale_ip, cwd, git_root, tty, summary, registered_at, last_seen, tmux_pane, tmux_socket, delivery_kind, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(PEER_ID, process.pid, "rst-a", "127.0.0.1", "/tmp/restart-live", null, null, "survivor", stale, stale, null, null, "none", TOKEN);
    db.close();

    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG, CLAUDE_PEERS_DB: DB },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  afterAll(() => {
    proc?.kill();
    try { unlinkSync(DB); } catch {}
    try { unlinkSync(CONFIG); } catch {}
  });

  it("keeps the stale row hidden and unroutable but heartbeatable until the survivor refreshes it", async () => {
    const beforeHeartbeat = await brokerFetch(PORT, "/list-peers", {
      scope: "machine", cwd: "/tmp/restart-live", git_root: null,
    }) as any[];
    expect(beforeHeartbeat.some((p) => p.id === PEER_ID)).toBe(false);

    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/restart-sender" });
    const sendBeforeHeartbeat = await brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: PEER_ID, text: "not yet",
    }, sender.token) as any;
    expect(sendBeforeHeartbeat.ok).toBe(false);

    const heartbeat = await rawPost(PORT, "/heartbeat", { id: PEER_ID }, TOKEN);
    expect(heartbeat.status).toBe(200);

    const afterHeartbeat = await brokerFetch(PORT, "/list-peers", {
      scope: "machine", cwd: "/tmp/restart-live", git_root: null,
    }) as any[];
    expect(afterHeartbeat.some((p) => p.id === PEER_ID)).toBe(true);
  }, 15_000);
});

// A peer's tmux delivery coordinates (tmux_pane/tmux_socket/delivery_kind) are how THIS host
// injects into THIS host's panes. They are meaningless on another machine and must never ride
// along in a gossip payload (shared/types.ts marks them local-only). gossipToSiblings projects
// every peer through the federated allow-list before serializing, so a future local-only column
// is excluded by default instead of silently leaking.
describe("gossip omits local-only tmux delivery coordinates", () => {
  const PORT = 17916;
  const STUB_PORT = 17917;
  let proc: any;
  let stub: any;
  const captured: any[] = []; // every gossip body the stub sibling receives

  beforeAll(async () => {
    stub = Bun.serve({
      port: STUB_PORT,
      async fetch(req) {
        if (new URL(req.url).pathname === "/gossip") {
          try { captured.push(await req.json()); } catch {}
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });
    await Bun.write("/tmp/config-gossipproj.json", JSON.stringify({
      machine: "gp-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "gpa",
      siblings: [{ machine: "gp-stub", url: `http://127.0.0.1:${STUB_PORT}` }],
      allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync("/tmp/broker-gossipproj.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-gossipproj.json", CLAUDE_PEERS_DB: "/tmp/broker-gossipproj.db" },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  });

  afterAll(() => {
    proc?.kill();
    stub?.stop(true);
    try { unlinkSync("/tmp/broker-gossipproj.db"); } catch {}
    try { unlinkSync("/tmp/config-gossipproj.json"); } catch {}
  });

  it("strips tmux_pane/tmux_socket/delivery_kind from gossiped peers", async () => {
    // Register a LOCAL peer that carries a tmux delivery target. Its pid is this test process, so
    // the gossip liveness filter (process.kill(pid, 0)) keeps it in the outbound payload.
    const reg = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/gp1", git_root: null, tty: null, summary: "s",
      machine: "gp-a", tailscale_ip: "127.0.0.1", tmux_pane: "%7", tmux_socket: "/tmp/sock",
    }) as any;
    expect(reg.id).toBeTruthy();

    // Wait for a periodic gossip tick (GOSSIP_INTERVAL_MS = 5s) that carries the peer.
    let gossipWithPeer: any = null;
    for (let i = 0; i < 30 && !gossipWithPeer; i++) {
      gossipWithPeer = captured.find(g => Array.isArray(g.peers) && g.peers.some((p: any) => p.id === reg.id));
      if (!gossipWithPeer) await new Promise((r) => setTimeout(r, 300));
    }
    expect(gossipWithPeer).toBeTruthy();
    const peer = gossipWithPeer.peers.find((p: any) => p.id === reg.id);
    // The federated identity fields survive the projection...
    expect(peer.id).toBe(reg.id);
    expect(peer.pid).toBe(process.pid);
    // ...but the local-only delivery coordinates must never cross the wire.
    expect(peer.tmux_pane).toBeUndefined();
    expect(peer.tmux_socket).toBeUndefined();
    expect(peer.delivery_kind).toBeUndefined();
  }, 15_000);
});

// Idle self-exit must not vanish silently from the federation: a broker that reaps itself while a
// sibling still holds its peers leaves those peers stale until the sibling's own sweep. Routing
// idle-exit through retire() means the teardown announces an empty peer list first, so siblings
// drop this broker's peers immediately. IDLE_EXIT_MS (1500) < GOSSIP_INTERVAL_MS (5000) guarantees
// the broker reaps itself before any PERIODIC gossip fires, so the only gossip the stub can see is
// retire()'s empty-peer teardown announcement.
describe("idle self-exit announces an empty peer list to siblings", () => {
  const PORT = 17918;
  const STUB_PORT = 17919;
  let proc: any;
  let stub: any;
  const captured: any[] = [];

  beforeAll(async () => {
    stub = Bun.serve({
      port: STUB_PORT,
      async fetch(req) {
        if (new URL(req.url).pathname === "/gossip") {
          try { captured.push(await req.json()); } catch {}
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });
    await Bun.write("/tmp/config-idgamossip.json", JSON.stringify({
      machine: "ig-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "iga",
      siblings: [{ machine: "ig-stub", url: `http://127.0.0.1:${STUB_PORT}` }],
      allowed_ips: ["127.0.0.1"],
    }));
    try { unlinkSync("/tmp/broker-idgamossip.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-idgamossip.json",
             CLAUDE_PEERS_DB: "/tmp/broker-idgamossip.db", CLAUDE_PEERS_IDLE_EXIT_MS: "1500" },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 20; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) })).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  });

  afterAll(() => {
    proc?.kill();
    stub?.stop(true);
    try { unlinkSync("/tmp/broker-idgamossip.db"); } catch {}
    try { unlinkSync("/tmp/config-idgamossip.json"); } catch {}
  });

  it("posts an empty-peer gossip on idle teardown", async () => {
    // No peer ever registers, so after the ~1.5s idle window the broker self-exits. Polling /health
    // is a GET and never refreshes the idle clock, so the loop cannot keep the broker alive.
    let down = false;
    for (let i = 0; i < 30; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) }); }
      catch { down = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(down).toBe(true);
    // Let the in-flight teardown gossip settle at the stub.
    await new Promise((r) => setTimeout(r, 400));
    // The teardown announced the broker is empty; under the bug idle-exit tore down without any
    // gossip and the stub stays empty.
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured.every(g => Array.isArray(g.peers) && g.peers.length === 0)).toBe(true);
  }, 20_000);
});

// Per-session capability tokens: the control plane binds every mutating call to the
// session that registered it. A peer may act only as the id it holds the token for,
// closing the forged-from_id -> pane-injection vector. /register mints the token;
// /retire and /list-peers stay token-free; federation routes are exempt (token never
// crosses a machine boundary).
describe("per-session capability tokens (enforced)", () => {
  const PORT = 17920;
  let proc: any;
  const cfg = { machine: "tok-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "tka", siblings: [], allowed_ips: ["127.0.0.1"] };

  beforeAll(async () => {
    await Bun.write("/tmp/config-tok.json", JSON.stringify(cfg));
    try { unlinkSync("/tmp/broker-tok.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-tok.json", CLAUDE_PEERS_DB: "/tmp/broker-tok.db" },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  });
  afterAll(() => { proc?.kill(); try { unlinkSync("/tmp/broker-tok.db"); } catch {} try { unlinkSync("/tmp/config-tok.json"); } catch {} });

  it("register mints a non-empty capability token", async () => {
    const reg = await registerAndGetToken(PORT, { cwd: "/tmp/t-mint" });
    expect(typeof reg.token).toBe("string");
    expect(reg.token.length).toBeGreaterThanOrEqual(32);
  });

  it("accepts a send when the token matches the from_id", async () => {
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/t-s1" });
    const recip = await registerAndGetToken(PORT, { cwd: "/tmp/t-r1", pid: process.pid });
    const send = await brokerFetch(PORT, "/send-message",
      { from_id: sender.id, to_id: recip.id, text: "authed hello" }, sender.token) as any;
    expect(send.ok).toBe(true);
    const poll = await brokerFetch(PORT, "/poll-messages", { id: recip.id }, recip.token) as any;
    expect(poll.messages).toHaveLength(1);
    expect(poll.messages[0].text).toBe("authed hello");
  });

  it("rejects a send carrying no token", async () => {
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/t-s2" });
    const recip = await registerAndGetToken(PORT, { cwd: "/tmp/t-r2" });
    const r = await rawPost(PORT, "/send-message", { from_id: sender.id, to_id: recip.id, text: "no token" });
    expect(r.status).toBe(401);
    const poll = await brokerFetch(PORT, "/poll-messages", { id: recip.id }, recip.token) as any;
    expect(poll.messages).toHaveLength(0);
  });

  it("rejects a send carrying the wrong token", async () => {
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/t-s3" });
    const recip = await registerAndGetToken(PORT, { cwd: "/tmp/t-r3" });
    const r = await rawPost(PORT, "/send-message",
      { from_id: sender.id, to_id: recip.id, text: "wrong token" }, "deadbeef-not-a-real-token");
    expect(r.status).toBe(401);
    const poll = await brokerFetch(PORT, "/poll-messages", { id: recip.id }, recip.token) as any;
    expect(poll.messages).toHaveLength(0);
  });

  it("rejects forging from_id with a valid token for a different peer", async () => {
    const attacker = await registerAndGetToken(PORT, { cwd: "/tmp/t-atk" });
    const victim = await registerAndGetToken(PORT, { cwd: "/tmp/t-vic" });
    const recip = await registerAndGetToken(PORT, { cwd: "/tmp/t-r4" });
    // attacker holds its own valid token but claims to be the victim
    const r = await rawPost(PORT, "/send-message",
      { from_id: victim.id, to_id: recip.id, text: "spoofed" }, attacker.token);
    expect(r.status).toBe(401);
    const poll = await brokerFetch(PORT, "/poll-messages", { id: recip.id }, recip.token) as any;
    expect(poll.messages).toHaveLength(0);
  });

  it("requires the peer's own token to unregister it", async () => {
    const a = await registerAndGetToken(PORT, { cwd: "/tmp/t-u1" });
    const b = await registerAndGetToken(PORT, { cwd: "/tmp/t-u2" });
    // b cannot unregister a with b's token
    const bad = await rawPost(PORT, "/unregister", { id: a.id }, b.token);
    expect(bad.status).toBe(401);
    // a unregisters itself with its own token
    const ok = await rawPost(PORT, "/unregister", { id: a.id }, a.token);
    expect(ok.status).toBe(200);
  });

  it("never serializes the capability token into the token-exempt /list-peers", async () => {
    // /list-peers is read-only and token-exempt, so leaking the token column here would hand any
    // loopback caller every peer's credential and defeat the whole gate. Register a live peer so
    // the listing has a real row carrying a (secret) token, then assert no row exposes it.
    const p = await registerAndGetToken(PORT, { cwd: "/tmp/t-list", pid: process.pid });
    const r = await rawPost(PORT, "/list-peers", { scope: "machine", cwd: "/", git_root: null });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
    const me = (r.json as any[]).find((x) => x.id === p.id);
    expect(me).toBeDefined();
    expect("token" in me).toBe(false);
    expect((r.json as any[]).every((x) => !("token" in x))).toBe(true);
  });
});

describe("per-session capability tokens (CLAUDE_PEERS_ALLOW_UNSIGNED grace)", () => {
  const PORT = 17921;
  let proc: any;
  const cfg = { machine: "tkg-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "tkg", siblings: [], allowed_ips: ["127.0.0.1"] };

  beforeAll(async () => {
    await Bun.write("/tmp/config-tkg.json", JSON.stringify(cfg));
    try { unlinkSync("/tmp/broker-tkg.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-tkg.json", CLAUDE_PEERS_DB: "/tmp/broker-tkg.db", CLAUDE_PEERS_ALLOW_UNSIGNED: "1" },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  });
  afterAll(() => { proc?.kill(); try { unlinkSync("/tmp/broker-tkg.db"); } catch {} try { unlinkSync("/tmp/config-tkg.json"); } catch {} });

  it("accepts an unsigned send only from a genuine pre-v3 (NULL-token) row", async () => {
    const recip = await registerAndGetToken(PORT, { cwd: "/tmp/g-r1", pid: process.pid });
    // A real migrated v2 peer: a row that exists but whose token was never minted.
    const legacyId = "legacy-null-token-sender";
    insertLegacyPeer("/tmp/broker-tkg.db", legacyId, "tkg-a");
    const r = await rawPost(PORT, "/send-message", { from_id: legacyId, to_id: recip.id, text: "grace hello" });
    expect(r.status).toBe(200);
    const poll = await brokerFetch(PORT, "/poll-messages", { id: recip.id }, recip.token) as any;
    expect(poll.messages).toHaveLength(1);
    expect(poll.messages[0].text).toBe("grace hello");
  });

  it("rejects an unsigned send from a principal that already holds a token, even under grace", async () => {
    // The grace flag must not let header omission impersonate a token-bearing peer — otherwise the
    // from_id forgery this commit closes would reopen for the whole upgrade window. Only NULL-token
    // legacy rows get the pass; a minted-token principal must always present its token.
    const holder = await registerAndGetToken(PORT, { cwd: "/tmp/g-holder" });
    const recip = await registerAndGetToken(PORT, { cwd: "/tmp/g-r3", pid: process.pid });
    const r = await rawPost(PORT, "/send-message", { from_id: holder.id, to_id: recip.id, text: "should not pass" });
    expect(r.status).toBe(401);
    const poll = await brokerFetch(PORT, "/poll-messages", { id: recip.id }, recip.token) as any;
    expect(poll.messages).toHaveLength(0);
  });

  it("rejects an unsigned unregister of a token-holding peer, even under grace", async () => {
    const victim = await registerAndGetToken(PORT, { cwd: "/tmp/g-victim", pid: process.pid });
    const r = await rawPost(PORT, "/unregister", { id: victim.id });
    expect(r.status).toBe(401);
    // The victim still has a token row and a live pid, so it remains listed: it was not removed.
    const list = await rawPost(PORT, "/list-peers", { scope: "machine", cwd: "/", git_root: null });
    expect((list.json as any[]).some((x) => x.id === victim.id)).toBe(true);
  });

  it("still rejects a wrong token even under the grace flag", async () => {
    const recip = await registerAndGetToken(PORT, { cwd: "/tmp/g-r2" });
    const r = await rawPost(PORT, "/send-message", { from_id: "legacy-sender", to_id: recip.id, text: "bad" }, "nope-wrong");
    expect(r.status).toBe(401);
  });
});

// The CLI send path: `bun cli.ts send` is no longer a synthetic unauthenticated "cli" sender.
// It registers an ephemeral queued-only peer to obtain a token, sends as that id, then
// unregisters — so the message arrives and no sender row lingers afterward.
describe("cli send authenticates via an ephemeral registration", () => {
  const PORT = 17922;
  let proc: any;
  const cfg = { machine: "cli-a", tailscale_ip: "127.0.0.1", port: PORT, id_prefix: "cli", siblings: [], allowed_ips: ["127.0.0.1"] };

  beforeAll(async () => {
    await Bun.write("/tmp/config-cli.json", JSON.stringify(cfg));
    try { unlinkSync("/tmp/broker-cli.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-cli.json", CLAUDE_PEERS_DB: "/tmp/broker-cli.db" },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  });
  afterAll(() => { proc?.kill(); try { unlinkSync("/tmp/broker-cli.db"); } catch {} try { unlinkSync("/tmp/config-cli.json"); } catch {} });

  it("delivers a CLI message and leaves no lingering ephemeral sender", async () => {
    const recip = await registerAndGetToken(PORT, { cwd: "/tmp/cli-r", pid: process.pid });
    const sent = Bun.spawnSync(["bun", "cli.ts", "send", recip.id, "from the cli"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-cli.json" },
    });
    const out = new TextDecoder().decode(sent.stdout) + new TextDecoder().decode(sent.stderr);
    expect(out).toContain(`Message sent to ${recip.id}`);

    const poll = await brokerFetch(PORT, "/poll-messages", { id: recip.id }, recip.token) as any;
    expect(poll.messages).toHaveLength(1);
    expect(poll.messages[0].text).toBe("from the cli");

    // The ephemeral sender unregistered itself in its finally — only the recipient remains.
    const peers = await brokerFetch(PORT, "/list-peers", { scope: "machine", cwd: "/", git_root: null }) as any[];
    expect(peers.filter((p) => !p.is_remote).length).toBe(1);
  }, 15_000);
});

// Issue #14: a cross-broker send must report the sibling's per-message delivery disposition,
// not a blanket "queued". When the receiving broker pushes the forward into a live tmux pane the
// originator should learn "accepted"; when the receiving broker floors the forward it should
// learn the honest "queued". Two broker pairs because floor_remote_forwards is a broker-wide
// config: pair (A,B) leaves B unfloored with a stub tmux to exercise the accepted path; pair
// (C,D) leaves D floored (the default) to exercise the queued path.
describe("cross-broker send reports the remote delivery disposition", () => {
  const A_PORT = 17923, B_PORT = 17924; // unfloored sibling -> accepted
  const C_PORT = 17925, D_PORT = 17926; // floored sibling   -> queued
  let pA: any, pB: any, pC: any, pD: any;
  let stub: { dir: string; logFile: string };

  const cfgA = {
    machine: "fwd-a", tailscale_ip: "127.0.0.1", port: A_PORT, id_prefix: "fwa",
    siblings: [{ machine: "fwd-b", url: `http://127.0.0.1:${B_PORT}` }], allowed_ips: ["127.0.0.1"],
  };
  const cfgB = {
    machine: "fwd-b", tailscale_ip: "127.0.0.1", port: B_PORT, id_prefix: "fwb",
    siblings: [{ machine: "fwd-a", url: `http://127.0.0.1:${A_PORT}` }], allowed_ips: ["127.0.0.1"],
    floor_remote_forwards: false,
  };
  const cfgC = {
    machine: "fwd-c", tailscale_ip: "127.0.0.1", port: C_PORT, id_prefix: "fwc",
    siblings: [{ machine: "fwd-d", url: `http://127.0.0.1:${D_PORT}` }], allowed_ips: ["127.0.0.1"],
  };
  const cfgD = {
    machine: "fwd-d", tailscale_ip: "127.0.0.1", port: D_PORT, id_prefix: "fwd",
    siblings: [{ machine: "fwd-c", url: `http://127.0.0.1:${C_PORT}` }], allowed_ips: ["127.0.0.1"],
    // floor_remote_forwards omitted -> defaults to true (floored).
  };

  async function waitHealth(port: number) {
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`broker on ${port} not ready`);
  }

  // Poll broker `port` until a remote peer with the given id shows up via gossip, so
  // resolveTargetBroker on the originating broker can route the forward.
  async function waitRemotePeer(port: number, id: string) {
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      const peers = await brokerFetch(port, "/list-peers", { scope: "machine", cwd: "/", git_root: null }) as any[];
      const found = peers.find((p: any) => p.id === id);
      if (found?.is_remote) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`remote peer ${id} never gossiped to ${port}`);
  }

  beforeAll(async () => {
    stub = makeStubTmux();
    // Config/DB paths must be unique across the whole file: the "retire waits for an
    // in-flight remote forward" block owns /tmp/{config,broker}-fwd.*, and overwriting its
    // config + unlinking its DB while that broker's handle is still open races into
    // SQLITE_IOERR_SHORT_READ. This block uses a disp* prefix that no other block touches.
    await Bun.write("/tmp/config-dispa.json", JSON.stringify(cfgA));
    await Bun.write("/tmp/config-dispb.json", JSON.stringify(cfgB));
    await Bun.write("/tmp/config-dispc.json", JSON.stringify(cfgC));
    await Bun.write("/tmp/config-dispd.json", JSON.stringify(cfgD));
    for (const f of ["dispa", "dispb", "dispc", "dispd"]) {
      try { unlinkSync(`/tmp/broker-${f}.db`); } catch {}
    }

    pA = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-dispa.json", CLAUDE_PEERS_DB: "/tmp/broker-dispa.db" },
      stdout: "ignore", stderr: "inherit",
    });
    // Broker B pushes the forward, so its tmux backend must be the deterministic stub.
    pB = Bun.spawn(["bun", "broker.ts"], {
      env: {
        ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-dispb.json", CLAUDE_PEERS_DB: "/tmp/broker-dispb.db",
        PATH: `${stub.dir}:${process.env.PATH}`,
      },
      stdout: "ignore", stderr: "inherit",
    });
    pC = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-dispc.json", CLAUDE_PEERS_DB: "/tmp/broker-dispc.db" },
      stdout: "ignore", stderr: "inherit",
    });
    pD = Bun.spawn(["bun", "broker.ts"], {
      env: {
        ...process.env, CLAUDE_PEERS_CONFIG: "/tmp/config-dispd.json", CLAUDE_PEERS_DB: "/tmp/broker-dispd.db",
        PATH: `${stub.dir}:${process.env.PATH}`,
      },
      stdout: "ignore", stderr: "inherit",
    });

    await Promise.all([waitHealth(A_PORT), waitHealth(B_PORT), waitHealth(C_PORT), waitHealth(D_PORT)]);
  }, FED_TIMEOUT_MS);

  afterAll(() => {
    pA?.kill(); pB?.kill(); pC?.kill(); pD?.kill();
    for (const f of ["dispa", "dispb", "dispc", "dispd"]) {
      try { unlinkSync(`/tmp/broker-${f}.db`); } catch {}
      try { unlinkSync(`/tmp/config-${f}.json`); } catch {}
    }
  });

  it("reports accepted when the sibling pushes the forward into a live tmux pane", async () => {
    const sender = await registerAndGetToken(A_PORT, { pid: process.pid, cwd: "/tmp/fwa-s", machine: "fwd-a" });
    const recip = await brokerFetch(B_PORT, "/register", {
      pid: process.pid, cwd: "/tmp/fwb-r", git_root: null, tty: null, summary: "",
      machine: "fwd-b", tailscale_ip: "127.0.0.1", tmux_pane: "%7", tmux_socket: null,
    }) as any;

    await waitRemotePeer(A_PORT, recip.id);

    const send = await brokerFetch(A_PORT, "/send-message", {
      from_id: sender.id, to_id: recip.id, text: "push me across",
    }, sender.token) as any;
    expect(send.ok).toBe(true);
    expect(send.routed).toBe("remote");
    // The load-bearing assertion: the sibling pushed the message, so the disposition is accepted.
    expect(send.delivery).toBe("accepted");

    // Corroborate the push really landed in the recipient's pane.
    const log = readFileSync(stub.logFile, "utf-8");
    expect(log).toContain("%7");
    expect(log).toContain("push me across");
  }, FED_TIMEOUT_MS);

  it("reports poll_only for an fyi forward even to a push-eligible unfloored sibling (#39)", async () => {
    // An fyi stores push_after NULL, so nextDeliverable/hasDuePush never auto-push it: it
    // is poll-only even though floor is off and the recipient has a live pane. The signal
    // must say so, not the "heartbeat pushes it once due" wording a push-eligible row gets.
    const sender = await registerAndGetToken(A_PORT, { pid: process.pid, cwd: "/tmp/fwa-fyi-s", machine: "fwd-a" });
    const recip = await brokerFetch(B_PORT, "/register", {
      pid: process.pid, cwd: "/tmp/fwb-fyi-r", git_root: null, tty: null, summary: "",
      machine: "fwd-b", tailscale_ip: "127.0.0.1", tmux_pane: "%9", tmux_socket: null,
    }) as any;

    await waitRemotePeer(A_PORT, recip.id);

    const send = await brokerFetch(A_PORT, "/send-message", {
      from_id: sender.id, to_id: recip.id, text: "fyi across, no push", urgency: "fyi",
    }, sender.token) as any;
    expect(send.ok).toBe(true);
    expect(send.routed).toBe("remote");
    // Queued and poll-only: the sibling will never auto-push an fyi, so the sender must not
    // be told the heartbeat will deliver it.
    expect(send.delivery).toBe("queued");
    expect(send.poll_only).toBe(true);

    // And it really was not pushed into the recipient's pane.
    const log = existsSync(stub.logFile) ? readFileSync(stub.logFile, "utf-8") : "";
    expect(log).not.toContain("fyi across, no push");
  }, FED_TIMEOUT_MS);

  it("reports queued when the sibling floors the forward", async () => {
    const sender = await registerAndGetToken(C_PORT, { pid: process.pid, cwd: "/tmp/fwc-s", machine: "fwd-c" });
    const recip = await brokerFetch(D_PORT, "/register", {
      pid: process.pid, cwd: "/tmp/fwd-r", git_root: null, tty: null, summary: "",
      machine: "fwd-d", tailscale_ip: "127.0.0.1", tmux_pane: "%8", tmux_socket: null,
    }) as any;

    await waitRemotePeer(C_PORT, recip.id);

    const send = await brokerFetch(C_PORT, "/send-message", {
      from_id: sender.id, to_id: recip.id, text: "hold me for pickup",
    }, sender.token) as any;
    expect(send.ok).toBe(true);
    expect(send.routed).toBe("remote");
    expect(send.delivery).toBe("queued");

    // The floor must hold against the deadline-push path too: a heartbeat drain on the
    // recipient must not auto-paste a floored forward into the pane. Before push_after,
    // the floor only skipped the immediate inject and the next heartbeat pushed anyway.
    await brokerFetch(D_PORT, "/heartbeat", { id: recip.id }, recip.token);
    const log = existsSync(stub.logFile) ? readFileSync(stub.logFile, "utf-8") : "";
    expect(log).not.toContain("hold me for pickup");

    // A floored forward stays retrievable on the receiving broker.
    const poll = await brokerFetch(D_PORT, "/poll-messages", { id: recip.id }, recip.token) as any;
    expect(poll.messages).toHaveLength(1);
    expect(poll.messages[0].text).toBe("hold me for pickup");
  }, FED_TIMEOUT_MS);
});

// Urgency tiers: "interrupt" pushes at once (and flushes pending pushable mail with it),
// "normal" queues until the recipient polls or the push deadline passes (the heartbeat
// drain enforces the deadline), "fyi" never auto-pushes and is poll-only.
describe("urgency tiers and deadline push", () => {
  const PORT = 17931;
  const PUSH_DELAY_MS = 500;
  let proc: any;
  let stub: { dir: string; logFile: string };

  const cfg = {
    machine: "urg-a", tailscale_ip: "127.0.0.1", port: PORT,
    id_prefix: "urg", siblings: [], allowed_ips: ["127.0.0.1"],
    push_delay_ms: PUSH_DELAY_MS,
  };

  beforeAll(async () => {
    stub = makeStubTmux();
    await Bun.write("/tmp/config-urg.json", JSON.stringify(cfg));
    try { unlinkSync("/tmp/broker-urg.db"); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: {
        ...process.env,
        CLAUDE_PEERS_CONFIG: "/tmp/config-urg.json",
        CLAUDE_PEERS_DB: "/tmp/broker-urg.db",
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
    try { unlinkSync("/tmp/broker-urg.db"); } catch {}
    try { unlinkSync("/tmp/config-urg.json"); } catch {}
  });

  it("normal urgency queues instead of pushing", async () => {
    const recip = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/u1", git_root: null, tty: null, summary: "",
      machine: "urg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%21", tmux_socket: null,
    }) as any;
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/u1-s" });
    const send = await brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: recip.id, text: "calm normal note", urgency: "normal",
    }, sender.token) as any;
    expect(send.ok).toBe(true);
    expect(send.delivery).toBe("queued");
    const log = readFileSync(stub.logFile, "utf-8");
    expect(log).not.toContain("calm normal note");
    // And it is retrievable by poll before the deadline — the cheap path.
    const poll = await brokerFetch(PORT, "/poll-messages", { id: recip.id }, recip.token) as any;
    expect(poll.messages).toHaveLength(1);
    expect(poll.messages[0].text).toBe("calm normal note");
  });

  it("a normal row past its deadline is pushed by the recipient's heartbeat", async () => {
    const recip = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/u2", git_root: null, tty: null, summary: "",
      machine: "urg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%22", tmux_socket: null,
    }) as any;
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/u2-s" });
    await brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: recip.id, text: "deadline note", urgency: "normal",
    }, sender.token);
    await new Promise((r) => setTimeout(r, PUSH_DELAY_MS + 300));
    await brokerFetch(PORT, "/heartbeat", { id: recip.id }, recip.token);
    const log = readFileSync(stub.logFile, "utf-8");
    expect(log).toContain("deadline note");
    const poll = await brokerFetch(PORT, "/poll-messages", { id: recip.id }, recip.token) as any;
    expect(poll.messages).toHaveLength(0);
  });

  it("an interrupt send flushes pending pushable mail with it, in order", async () => {
    const recip = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/u3", git_root: null, tty: null, summary: "",
      machine: "urg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%23", tmux_socket: null,
    }) as any;
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/u3-s" });
    await brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: recip.id, text: "older normal rides along", urgency: "normal",
    }, sender.token);
    const send = await brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: recip.id, text: "urgent now", urgency: "interrupt",
    }, sender.token) as any;
    // The disposition reports THIS message's own fate — it rode out behind the flushed backlog.
    expect(send.delivery).toBe("accepted");
    const log = readFileSync(stub.logFile, "utf-8");
    expect(log).toContain("older normal rides along");
    expect(log).toContain("urgent now");
    expect(log.indexOf("older normal rides along")).toBeLessThan(log.indexOf("urgent now"));
  });

  it("fyi is never auto-pushed but is pollable with its urgency", async () => {
    const recip = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/u4", git_root: null, tty: null, summary: "",
      machine: "urg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%24", tmux_socket: null,
    }) as any;
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/u4-s" });
    const send = await brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: recip.id, text: "fyi only", urgency: "fyi",
    }, sender.token) as any;
    expect(send.delivery).toBe("queued");
    await new Promise((r) => setTimeout(r, PUSH_DELAY_MS + 300));
    await brokerFetch(PORT, "/heartbeat", { id: recip.id }, recip.token);
    const log = readFileSync(stub.logFile, "utf-8");
    expect(log).not.toContain("fyi only");
    const poll = await brokerFetch(PORT, "/poll-messages", { id: recip.id }, recip.token) as any;
    expect(poll.messages).toHaveLength(1);
    expect(poll.messages[0].urgency).toBe("fyi");
  });

  it("a send without urgency behaves as interrupt (wire back-compat)", async () => {
    const recip = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/u5", git_root: null, tty: null, summary: "",
      machine: "urg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%25", tmux_socket: null,
    }) as any;
    const sender = await registerAndGetToken(PORT, { cwd: "/tmp/u5-s" });
    const send = await brokerFetch(PORT, "/send-message", {
      from_id: sender.id, to_id: recip.id, text: "legacy push",
    }, sender.token) as any;
    expect(send.delivery).toBe("accepted");
    const log = readFileSync(stub.logFile, "utf-8");
    expect(log).toContain("legacy push");
  });
});
