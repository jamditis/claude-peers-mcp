import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dir, "..");

async function unusedLoopbackPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No test port assigned");
  await new Promise<void>((done) => socket.close(() => done()));
  return address.port;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  expect(result.isError).toBeFalsy();
  if (!Array.isArray(result.content)) throw new Error("MCP tool returned no content array");
  const lines: string[] = [];
  for (const item of result.content as unknown[]) {
    if (typeof item === "object" && item !== null && "type" in item && item.type === "text"
      && "text" in item && typeof item.text === "string") lines.push(item.text);
  }
  return lines.join("\n");
}

test.skipIf(process.platform === "win32")("generic MCP clients exchange queued mail over stdio", async () => {
  const work = mkdtempSync(join(tmpdir(), "peers-stdio-"));
  const port = await unusedLoopbackPort();
  const configPath = join(work, "config.json");
  writeFileSync(configPath, JSON.stringify({
    machine: "stdio-test",
    tailscale_ip: "127.0.0.1",
    port,
    id_prefix: "std",
    siblings: [],
    allowed_ips: ["127.0.0.1"],
    db_path: join(work, "peers.db"),
    auto_summary: false,
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CLAUDE_PEERS_SESSION_NAME;
  env.CLAUDE_PEERS_CONFIG = configPath;
  env.CLAUDE_PEERS_DB = join(work, "peers.db");
  env.CLAUDE_PEERS_IDLE_EXIT_MS = "0";

  const broker = Bun.spawn(["bun", join(root, "broker.ts")], { cwd: work, env, stdout: "ignore", stderr: "ignore" });
  const clients: Client[] = [];
  const watchers: ReturnType<typeof Bun.spawn>[] = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch { /* broker still starting */ }
      if (ready) break;
      await Bun.sleep(100);
    }
    expect(ready).toBe(true);

    async function connectClient(name: string): Promise<Client> {
      const client = new Client({ name, version: "1.0.0" });
      clients.push(client);
      await client.connect(new StdioClientTransport({
        command: "bun",
        args: [join(root, "server.ts")],
        cwd: work,
        env,
        stderr: "ignore",
      }));
      return client;
    }

    const sender = await connectClient("generic-sender");
    const receiver = await connectClient("generic-receiver");
    expect(receiver.getInstructions()).toContain("At session startup");
    const tools = await sender.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["list_peers", "send_message", "check_messages"]));

    const peek = toolText(await receiver.callTool({ name: "peek_messages", arguments: {} }));
    const recipientId = peek.match(/^You are peer ([\w-]+);/)?.[1];
    expect(recipientId).toBeDefined();
    if (!recipientId) throw new Error("Missing authenticated peer ID");
    const peers = toolText(await sender.callTool({ name: "list_peers", arguments: { scope: "machine" } }));
    expect(peers).toContain(recipientId as string);

    toolText(await sender.callTool({ name: "send_message", arguments: {
      to_id: recipientId,
      message: "generic stdio round trip",
      urgency: "fyi",
    } }));
    const queued = await receiver.callTool({ name: "peek_messages", arguments: {} });
    toolText(queued);
    const payload = queued.structuredContent as { count: number; doorbell: { peer_id: string; state: string; argv: string[] } };
    expect(payload.count).toBe(1);
    expect(payload.doorbell.peer_id).toBe(recipientId);
    expect(payload.doorbell.state).toBe("requires_host_launch");
    const watcher = Bun.spawn([...payload.doorbell.argv, "--timeout", "5"], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
    watchers.push(watcher);
    const reader = watcher.stdout.getReader();
    let output = "";
    while (!output.includes("doorbell armed")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Watcher failed before readiness: ${output}`);
      output += new TextDecoder().decode(chunk.value);
    }
    expect(toolText(await receiver.callTool({ name: "check_messages", arguments: {} }))).toContain("generic stdio round trip");
    expect(toolText(await receiver.callTool({ name: "check_messages", arguments: {} }))).toBe("No new messages.");
    toolText(await sender.callTool({ name: "send_message", arguments: {
      to_id: recipientId, message: "mail after startup drain", urgency: "fyi",
    } }));
    expect(await watcher.exited).toBe(0);
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    expect(output).toContain(`mail for ${recipientId}`);
    // Completion observes mail; it does not consume it on the host's behalf.
    const pending = await receiver.callTool({ name: "peek_messages", arguments: {} });
    expect((pending.structuredContent as { count: number }).count).toBe(1);
    expect(toolText(await receiver.callTool({ name: "check_messages", arguments: {} }))).toContain("mail after startup drain");
  } finally {
    for (const watcher of watchers) { if (watcher.exitCode === null) watcher.kill(); await watcher.exited; }
    await Promise.allSettled(clients.map((client) => client.close()));
    broker.kill();
    await broker.exited;
    rmSync(work, { recursive: true, force: true });
  }
}, 15_000);
