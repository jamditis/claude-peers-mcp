// tests/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "fs";

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
        await new Promise(r => setTimeout(r, 300));
      }
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

  it("gossip syncs peers between brokers (wait for gossip cycle)", async () => {
    // Wait for at least one gossip cycle (5s + buffer)
    await new Promise(r => setTimeout(r, 7000));

    const peersOnA = await brokerFetch(BROKER_A_PORT, "/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    }) as any[];

    // Broker A should see broker B's peer as remote
    const remotePeer = peersOnA.find((p: any) => p.machine === "broker-b");
    expect(remotePeer).toBeDefined();
    expect(remotePeer.is_remote).toBeTruthy();
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
