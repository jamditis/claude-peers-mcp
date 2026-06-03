// tests/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

async function brokerFetch(port: number, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`brokerFetch ${path} failed: ${res.status} ${res.statusText} - ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`brokerFetch non-JSON response from ${path}: ${text}`);
  }
}

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
  });

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
  });

  it("registers a peer on broker B", async () => {
    const result = await brokerFetch(BROKER_B_PORT, "/register", {
      pid: process.pid,
      cwd: "/tmp/test-b",
      git_root: null,
      tty: null,
      summary: "test peer on B",
      machine: "broker-b",
      tailscale_ip: "127.0.0.1",
    });
    expect(result.id).toMatch(/^brb-/);
  });

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
        return;
      }

      if (Date.now() - start > maxWaitMs) {
        throw new Error(
          `Timed out waiting for gossip sync. Peers on A: ${JSON.stringify(peersOnA)}`
        );
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
  });

  it("sends a cross-broker message", async () => {
    const peersOnA = await brokerFetch(BROKER_A_PORT, "/list-peers", { scope: "machine", cwd: "/", git_root: null }) as any[];
    const peersOnB = await brokerFetch(BROKER_B_PORT, "/list-peers", { scope: "machine", cwd: "/", git_root: null }) as any[];

    const localA = peersOnA.find((p: any) => p.machine === "broker-a" && !p.is_remote);
    const localB = peersOnB.find((p: any) => p.machine === "broker-b" && !p.is_remote);

    const sendResult = await brokerFetch(BROKER_A_PORT, "/send-message", {
      from_id: localA.id,
      to_id: localB.id,
      text: "hello from broker A",
    }) as any;
    expect(sendResult.ok).toBe(true);
    expect(sendResult.routed).toBe("remote");

    const pollResult = await brokerFetch(BROKER_B_PORT, "/poll-messages", { id: localB.id }) as any;
    expect(pollResult.messages).toHaveLength(1);
    expect(pollResult.messages[0].text).toBe("hello from broker A");
    expect(pollResult.messages[0].from_id).toBe(localA.id);
  });

  it("reports error when forwarding to unknown remote peer", async () => {
    const peersOnA = await brokerFetch(BROKER_A_PORT, "/list-peers", { scope: "machine", cwd: "/", git_root: null }) as any[];
    const localA = peersOnA.find((p: any) => !p.is_remote);

    const sendResult = await brokerFetch(BROKER_A_PORT, "/send-message", {
      from_id: localA.id,
      to_id: "brb-nonexist",
      text: "this should fail",
    }) as any;
    expect(sendResult.ok).toBe(false);
  });

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
  });
}, { timeout: 30_000 });

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
    const send = await brokerFetch(PORT, "/send-message", {
      from_id: "dla-sender0", to_id: reg.id, text: "hello tmux",
    }) as any;
    expect(send.ok).toBe(true);
    expect(send.delivery).toBe("accepted");
    const poll = await brokerFetch(PORT, "/poll-messages", { id: reg.id }) as any;
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
    const send = await brokerFetch(PORT, "/send-message", {
      from_id: "dla-sender0", to_id: reg.id, text: "floor me",
    }) as any;
    expect(send.delivery).toBe("queued");
    const poll = await brokerFetch(PORT, "/poll-messages", { id: reg.id }) as any;
    expect(poll.messages).toHaveLength(1);
    expect(poll.messages[0].text).toBe("floor me");
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
    const send = await brokerFetch(PORT, "/send-message", { from_id: "rga-x", to_id: reg.id, text: "must not vanish" }) as any;
    expect(send.delivery).toBe("queued"); // push failed => not accepted
    // The push was actually attempted (not short-circuited by an absent tmux).
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("%4");
    expect(log).toContain("must not vanish");
    // And the message is still retrievable — it was NOT silently consumed.
    const poll = await brokerFetch(PORT, "/poll-messages", { id: reg.id }) as any;
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
    expect(h.protocol_version).toBe(2);
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
