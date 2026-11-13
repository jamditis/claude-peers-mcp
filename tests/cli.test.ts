import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("CLI help exits promptly and option-shaped peer IDs are refused", async () => {
  const work = mkdtempSync(join(tmpdir(), "cli-help-"));
  const configPath = join(work, "config.json");
  const sent: string[] = [];
  const broker = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/register": return Response.json({ id: "test-sender", token: "test-token" });
        case "/send-message": {
          const body = await request.json() as { text: string };
          sent.push(body.text);
          return Response.json({ ok: true });
        }
        case "/unregister": return Response.json({ ok: true });
        default: return new Response("unexpected request", { status: 404 });
      }
    },
  });
  writeFileSync(configPath, JSON.stringify({ machine: "test", tailscale_ip: "127.0.0.1",
    port: broker.port, id_prefix: "test", siblings: [], allowed_ips: ["127.0.0.1"], db_path: join(work, "store.db") }));

  async function run(args: string[], exitCode: number, output = "Usage:") {
    const child = Bun.spawn([process.execPath, "cli.ts", ...args], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, CLAUDE_PEERS_CONFIG: configPath },
      stdout: "pipe", stderr: "pipe", timeout: 1000,
    });
    expect(await child.exited).toBe(exitCode);
    expect(await new Response(child.stdout).text()).toContain(output);
  }

  try {
    for (const command of ["status", "peers", "send", "doorbell", "doctor", "ping-siblings", "kill-broker"]) {
      for (const flag of ["--help", "-h"]) await run([command, flag], 0);
    }
    await run(["doorbell", "-x"], 2);
    await run(["doorbell", "test-peer", "-x"], 2);
    await run(["send", "-x", "message"], 2);
    expect(sent).toEqual([]);
    await run(["send", "test-peer", "try", "-h", "and", "--help"], 0, "Message sent to test-peer");
    expect(sent).toEqual(["try -h and --help"]);
  } finally {
    broker.stop(true);
    rmSync(work, { recursive: true, force: true });
  }
}, 10_000);
