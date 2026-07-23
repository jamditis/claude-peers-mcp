import { expect, test } from "bun:test";
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

  await Bun.write(configPath, JSON.stringify({
    machine: "recovery-test",
    tailscale_ip: "127.0.0.1",
    port: PORT,
    id_prefix: "rct",
    siblings: [],
    allowed_ips: ["127.0.0.1"],
    db_path: join(workDir, "broker.db"),
    auto_summary: false,
  }));

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
    // longer know this server's capability. Reproduce that path with a fresh DB:
    // the first authenticated call gets a side-effect-free 401, then the server
    // must re-register and retry with its new id/token.
    await retireBroker();
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(join(workDir, `broker.db${suffix}`), { force: true });
    }
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
    rmSync(workDir, { recursive: true, force: true });
  }
}, 20_000);
