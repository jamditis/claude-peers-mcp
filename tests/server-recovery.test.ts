import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = 17935;
const BROKER_URL = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = join(import.meta.dir, "..");

async function brokerIsAlive(): Promise<boolean> {
  try {
    return (await fetch(`${BROKER_URL}/health`)).ok;
  } catch {
    return false;
  }
}

async function waitForBroker(alive: boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await brokerIsAlive() === alive) return;
    await Bun.sleep(50);
  }
  throw new Error(`Broker did not become ${alive ? "alive" : "stopped"}`);
}

async function retireBroker(): Promise<void> {
  if (!await brokerIsAlive()) return;
  const response = await fetch(`${BROKER_URL}/retire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.ok).toBe(true);
  await waitForBroker(false);
}

test("a live MCP server recovers after its broker exits", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "claude-peers-recovery-"));
  const configPath = join(workDir, "config.json");
  const initialDbPath = join(workDir, "broker.db");
  const freshDbPath = join(workDir, "broker-fresh.db");
  const brokerConfig = {
    machine: "recovery-test",
    tailscale_ip: "127.0.0.1",
    port: PORT,
    id_prefix: "rct",
    siblings: [],
    allowed_ips: ["127.0.0.1"],
    db_path: initialDbPath,
    auto_summary: false,
  };
  const client = new Client({ name: "recovery-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["server.ts"],
    cwd: REPO_ROOT,
    env: {
      ...getDefaultEnvironment(),
      CLAUDE_PEERS_CONFIG: configPath,
      CLAUDE_PEERS_IDLE_EXIT_MS: "0",
      CLAUDE_PEERS_SESSION_NAME: "recovery-test",
    },
    stderr: "ignore",
  });

  await Bun.write(configPath, JSON.stringify(brokerConfig));

  try {
    await client.connect(transport);
    await waitForBroker(true);

    const initialPeersResponse = await fetch(`${BROKER_URL}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "machine", cwd: "/", git_root: null }),
    });
    const initialPeers = await initialPeersResponse.json() as Array<{
      id: string;
    }>;
    expect(initialPeers).toHaveLength(1);
    const initialPeerId = initialPeers[0]?.id;
    expect(initialPeerId).toBeTruthy();
    if (!initialPeerId) throw new Error("Initial peer did not register");

    const senderResponse = await fetch(`${BROKER_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pid: process.pid,
        cwd: workDir,
        git_root: null,
        tty: null,
        summary: "",
        machine: "recovery-test",
        tailscale_ip: "127.0.0.1",
        name: "test-sender",
        tmux_pane: null,
        tmux_socket: null,
      }),
    });
    const sender = await senderResponse.json() as {
      id: string;
      token: string;
    };
    const sendResponse = await fetch(`${BROKER_URL}/send-message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sender.token}`,
      },
      body: JSON.stringify({
        from_id: sender.id,
        to_id: initialPeerId,
        text: "mail queued before broker restart",
        urgency: "fyi",
      }),
    });
    expect(sendResponse.ok).toBe(true);
    const unregisterSenderResponse = await fetch(`${BROKER_URL}/unregister`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sender.token}`,
      },
      body: JSON.stringify({ id: sender.id }),
    });
    expect(unregisterSenderResponse.ok).toBe(true);

    // Model a broker outage longer than the peer TTL without making the test
    // sleep for 45 seconds. The restarted broker must refresh this row before
    // list/send quarantine it as stale.
    const staleDb = new Database(initialDbPath);
    try {
      staleDb.run("PRAGMA busy_timeout = 3000");
      staleDb.prepare(
        "UPDATE peers SET last_seen = ? WHERE id = ?",
      ).run(new Date(0).toISOString(), initialPeerId);
    } finally {
      staleDb.close();
    }

    await retireBroker();

    const result = await client.callTool({
      name: "list_peers",
      arguments: { scope: "machine" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual({
      type: "text",
      text: "No other Claude Code instances found (scope: machine).",
    });
    const queuedMail = await client.callTool({
      name: "check_messages",
      arguments: {},
    });
    expect(queuedMail.isError).not.toBe(true);
    expect(queuedMail.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("mail queued before broker restart"),
    });
    await waitForBroker(true);

    const peersResponse = await fetch(`${BROKER_URL}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "machine", cwd: "/", git_root: null }),
    });
    expect(peersResponse.ok).toBe(true);
    const peers = await peersResponse.json() as Array<{
      id: string;
      name?: string | null;
    }>;
    expect(peers).toHaveLength(1);
    expect(peers[0]?.id).toBe(initialPeerId);
    expect(peers[0]?.name).toBe("recovery-test");

    // A broker replaced by another supervisor may already be alive but no
    // longer know this server's capability. Use another DB path rather than
    // unlinking SQLite files: Windows keeps the retired process's file handles
    // locked for a short window after the HTTP listener has stopped.
    await retireBroker();
    await Bun.write(configPath, JSON.stringify({
      ...brokerConfig,
      db_path: freshDbPath,
    }));
    Bun.spawn(["bun", "broker.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...getDefaultEnvironment(),
        CLAUDE_PEERS_CONFIG: configPath,
        CLAUDE_PEERS_IDLE_EXIT_MS: "0",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
    await waitForBroker(true);

    // The first call is deliberately token-exempt at the broker. Recovery must
    // probe before the read so the fresh broker learns this session immediately
    // instead of waiting for the next 15-second heartbeat.
    const freshListResult = await client.callTool({
      name: "list_peers",
      arguments: { scope: "machine" },
    });
    expect(freshListResult.isError).not.toBe(true);

    const freshPeersResponse = await fetch(`${BROKER_URL}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "machine", cwd: "/", git_root: null }),
    });
    const freshPeers = await freshPeersResponse.json() as Array<{
      id: string;
    }>;
    expect(freshPeers).toHaveLength(1);
    expect(freshPeers[0]?.id).not.toBe(initialPeerId);

    const summaryResult = await client.callTool({
      name: "set_summary",
      arguments: { summary: "recovered from an unknown token" },
    });
    expect(summaryResult.isError).not.toBe(true);

    const recoveredPeersResponse = await fetch(`${BROKER_URL}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "machine", cwd: "/", git_root: null }),
    });
    const recoveredPeers = await recoveredPeersResponse.json() as Array<{
      summary: string;
    }>;
    expect(recoveredPeers).toHaveLength(1);
    expect(recoveredPeers[0]?.summary).toBe("recovered from an unknown token");

    await retireBroker();
    const postSummaryRecovery = await client.callTool({
      name: "list_peers",
      arguments: { scope: "machine" },
    });
    expect(postSummaryRecovery.isError).not.toBe(true);

    const preservedSummaryResponse = await fetch(`${BROKER_URL}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "machine", cwd: "/", git_root: null }),
    });
    const preservedSummaryPeers = await preservedSummaryResponse.json() as Array<{
      summary: string;
    }>;
    expect(preservedSummaryPeers).toHaveLength(1);
    expect(preservedSummaryPeers[0]?.summary).toBe(
      "recovered from an unknown token",
    );
  } finally {
    await client.close().catch(() => {});
    await retireBroker().catch(() => {});
    rmSync(workDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  }
}, 20_000);
