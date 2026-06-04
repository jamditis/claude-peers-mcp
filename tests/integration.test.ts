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

// A recipient's own /unregister must not tear down a delivery already in flight to it.
// If it deletes the peer row while a tmux send-keys is mid-spawn, the lease resolves
// against a now-missing peer: peerStillLive() rejects, releaseToQueued() requeues the
// row under the deleted id, and nothing — no heartbeat, no check_messages — can ever
// drain it until the 24h prune. So the whole unregister defers while mid-delivery; the
// peer stays addressable until the lease resolves, then cleanStalePeers reaps it once
// the pid probes dead. A tmux stub that parks on a fifo makes the in-flight window
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
    // -V answers the availability probe and returns at once. The real send-keys
    // invocation signals it started (marker), then blocks reading the fifo until the
    // test releases it — holding the delivery in flight for as long as the test wants.
    writeFileSync(stub,
      `#!/usr/bin/env bash\n` +
      `if [ "$1" = "-V" ]; then echo "tmux 3.4"; exit 0; fi\n` +
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

  it("keeps the peer registered while a delivery to it is in flight", async () => {
    // pid = this live process so list-peers does not filter the peer for being dead.
    const reg = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/u1", git_root: null, tty: null, summary: "",
      machine: "unreg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%5", tmux_socket: null,
    }) as any;

    // Fire the send WITHOUT awaiting: the broker claims the lease, spawns the stub, and
    // parks on the fifo — the delivery is now in flight and /send-message stays pending.
    const sendPromise = brokerFetch(PORT, "/send-message", {
      from_id: "ura-sender0", to_id: reg.id, text: "in flight",
    });

    try {
      // Wait for the stub to signal start: a deterministic "now in flight" edge.
      for (let i = 0; i < 60 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(marker)).toBe(true);

      // Recipient unregisters mid-delivery. The fix defers and keeps the peer; without
      // it deletePeer ran unconditionally and the peer would be gone here.
      await brokerFetch(PORT, "/unregister", { id: reg.id });

      const peers = await brokerFetch(PORT, "/list-peers", {
        scope: "machine", cwd: "/tmp/u1", git_root: null,
      }) as any[];
      expect(peers.some((p) => p.id === reg.id)).toBe(true);
    } finally {
      // Release the parked delivery so the broker is not left holding it for teardown.
      if (existsSync(marker)) {
        writeFileSync(fifo, "go");
        await sendPromise.catch(() => {});
      }
    }
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

  it("keeps the old peer addressable until the in-flight lease resolves, then reaps it", async () => {
    const reg1 = await brokerFetch(PORT, "/register", {
      pid: process.pid, cwd: "/tmp/rr1", git_root: null, tty: null, summary: "",
      machine: "rereg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%5", tmux_socket: null,
    }) as any;

    // In-flight delivery to the first id, parked on the fifo.
    const sendPromise = brokerFetch(PORT, "/send-message", {
      from_id: "rra-sender0", to_id: reg1.id, text: "in flight",
    });

    let reg2: any;
    try {
      for (let i = 0; i < 60 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(marker)).toBe(true);

      // Same pid re-registers mid-delivery. Without the fix the old peer row is deleted here
      // and the in-flight message orphans; with it the old id stays addressable (deferred).
      reg2 = await brokerFetch(PORT, "/register", {
        pid: process.pid, cwd: "/tmp/rr1", git_root: null, tty: null, summary: "",
        machine: "rereg-a", tailscale_ip: "127.0.0.1", tmux_pane: "%6", tmux_socket: null,
      }) as any;
      expect(reg2.id).not.toBe(reg1.id); // a genuinely new session id

      const during = await brokerFetch(PORT, "/list-peers", {
        scope: "machine", cwd: "/tmp/rr1", git_root: null,
      }) as any[];
      expect(during.some((p) => p.id === reg1.id)).toBe(true); // old id deferred, still present
      expect(during.some((p) => p.id === reg2.id)).toBe(true); // new id registered
    } finally {
      if (existsSync(marker)) {
        writeFileSync(fifo, "go");
        await sendPromise.catch(() => {});
      }
    }

    // Lease resolved: the deferred old peer is reaped promptly (deliverNext's finally), while
    // the new session remains. No row is left orphaned under the dead old id.
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

    // Fire the send WITHOUT awaiting: it parks inside handleSendMessage on the forward fetch.
    const sendPromise = brokerFetch(PORT, "/send-message", {
      from_id: "fws-sender0", to_id: "hang-peer0", text: "in flight",
    }).catch(() => {});

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
    const result = await brokerFetch(PORT, "/send-message", {
      from_id: "dla-sender0", to_id: deadId, text: "to a ghost",
    }) as any;
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
