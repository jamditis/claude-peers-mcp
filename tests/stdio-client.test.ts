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
    const tools = await sender.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["list_peers", "send_message", "check_messages"]));

    const peek = toolText(await receiver.callTool({ name: "peek_messages", arguments: {} }));
    const recipientId = peek.match(/^You are peer ([\w-]+);/)?.[1];
    expect(recipientId).toBeDefined();
    const peers = toolText(await sender.callTool({ name: "list_peers", arguments: { scope: "machine" } }));
    expect(peers).toContain(recipientId as string);

    toolText(await sender.callTool({ name: "send_message", arguments: {
      to_id: recipientId,
      message: "generic stdio round trip",
      urgency: "fyi",
    } }));
    expect(toolText(await receiver.callTool({ name: "check_messages", arguments: {} }))).toContain("generic stdio round trip");
    expect(toolText(await receiver.callTool({ name: "check_messages", arguments: {} }))).toBe("No new messages.");
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    broker.kill();
    await broker.exited;
    rmSync(work, { recursive: true, force: true });
  }
}, 15_000);
