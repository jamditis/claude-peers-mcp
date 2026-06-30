// tests/doorbell.test.ts — broker side of the doorbell + /peek feature (issue #49).
//
// Spins up a real broker (with a stub tmux so a tmux recipient genuinely registers as 'tmux')
// and asserts: a send to a delivery_kind='none' recipient writes the marker with the new row
// id; a send to a tmux recipient writes no marker (it already gets an active push); /peek
// reports the backlog without consuming it; and /peek is token-gated to the caller's id.

import { afterAll, beforeAll, describe as bunDescribe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorbellPath, readDoorbell, writeDoorbell } from "../shared/notify.ts";

// #22: this suite spins up a real broker with a shell-based `tmux` stub (shebang +
// `chmodSync` executable bit), which native Windows cannot exec. Gate it behind a
// platform check: on win32 it skips instead of failing at exec time; on POSIX
// `skipIf(false)` is a no-op. This removes the bash-stub-exec failure class only;
// the remaining unit suites still hardcode `/tmp` paths, tracked in #53.
const describe = bunDescribe.skipIf(process.platform === "win32");

const PORT = 17940;
const work = mkdtempSync(join(tmpdir(), "doorbell-it-"));
const DB_PATH = join(work, "broker.db");
const CONFIG_PATH = join(work, "config.json");
let proc: any;

async function call(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${PORT}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function ok(path: string, body: unknown, token?: string) {
  const res = await call(path, body, token);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json() as any;
}
// A recipient must be a LIVE pid (sends check recipient liveness), so it uses this process's
// pid. A same-pid re-register supersedes the prior row, so only one live recipient exists at a
// time — fine, since each test uses its own and never references a prior test's recipient.
function regRcpt(overrides: Record<string, unknown> = {}) {
  return ok("/register", {
    pid: process.pid, cwd: "/tmp/db", git_root: null, tty: null, summary: "",
    machine: "db-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null, ...overrides,
  });
}
// A sender is never a delivery target and its liveness is never probed, so it can use a unique
// fake pid — which also keeps it from superseding the live recipient's same-pid row.
let fakePid = 900_000;
function regSender(overrides: Record<string, unknown> = {}) {
  return ok("/register", {
    pid: ++fakePid, cwd: "/tmp/db-s", git_root: null, tty: null, summary: "",
    machine: "db-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null, ...overrides,
  });
}

beforeAll(async () => {
  // #22: the suites below are gated off win32, but Bun runs a file-scoped beforeAll even when
  // every suite in the file is skipped. This setup is POSIX-only (it writes a `#!/usr/bin/env bash`
  // tmux stub, chmods it executable, and spawns a broker), so guard it too: on win32 the gated
  // suites do not run, so nothing needs it; on POSIX this returns false and the setup runs as before.
  if (process.platform === "win32") return;
  // Stub tmux: reports a version (so the broker sees tmux available and a %pane registers as
  // 'tmux'), records argv, exits 0 — enough for a tmux recipient to take the push path.
  const stub = join(work, "tmux");
  writeFileSync(stub, `#!/usr/bin/env bash\nif [ "$1" = "-V" ]; then echo "tmux 3.4"; exit 0; fi\nexit 0\n`);
  chmodSync(stub, 0o755);
  writeFileSync(CONFIG_PATH, JSON.stringify({
    machine: "db-a", tailscale_ip: "127.0.0.1", port: PORT,
    id_prefix: "dba", siblings: [], allowed_ips: ["127.0.0.1"], db_path: DB_PATH,
  }));
  proc = Bun.spawn(["bun", "broker.ts"], {
    env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG_PATH, PATH: `${work}:${process.env.PATH}` },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 20; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
});

afterAll(() => {
  proc?.kill();
  try { rmSync(work, { recursive: true, force: true }); } catch {}
});

describe("doorbell marker", () => {
  it("rings the doorbell for a none recipient with the new row id", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/none-1" });
    const sender = await regSender({ cwd: "/tmp/none-1-s" });
    expect(existsSync(doorbellPath(DB_PATH, rcpt.id) as string)).toBe(false); // none yet

    const send = await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "ring" }, sender.token);
    expect(send.delivery).toBe("queued"); // no pane -> floor

    const peek = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(readDoorbell(DB_PATH, rcpt.id)).toBe(peek.max_id); // marker == max pending id
    expect(peek.max_id).toBeGreaterThan(0);
  });

  it("advances the marker on each subsequent message (monotonic)", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/none-2" });
    const sender = await regSender({ cwd: "/tmp/none-2-s" });
    await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "one" }, sender.token);
    const first = readDoorbell(DB_PATH, rcpt.id);
    await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "two" }, sender.token);
    const second = readDoorbell(DB_PATH, rcpt.id);
    expect(second).toBeGreaterThan(first);
  });

  it("does not ring for a tmux recipient (it gets an active push instead)", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/tmux-1", tmux_pane: "%9" });
    const sender = await regSender({ cwd: "/tmp/tmux-1-s" });
    const send = await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "push" }, sender.token);
    expect(send.delivery).toBe("accepted");
    expect(existsSync(doorbellPath(DB_PATH, rcpt.id) as string)).toBe(false);
  });
});

describe("/peek (non-consuming read)", () => {
  it("reports count and max_id without flipping rows to delivered", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/peek-1" });
    const sender = await regSender({ cwd: "/tmp/peek-1-s" });
    await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "a" }, sender.token);
    await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "b" }, sender.token);

    const peek = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(peek.id).toBe(rcpt.id);
    expect(peek.count).toBe(2);
    expect(peek.max_id).toBeGreaterThan(0);

    // A peek must not consume: the mail is still retrievable, and a second peek is identical.
    const peek2 = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(peek2.count).toBe(2);
    const poll = await ok("/poll-messages", { id: rcpt.id }, rcpt.token);
    expect(poll.messages).toHaveLength(2);
    // After consuming, peek reports an empty backlog.
    const peek3 = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(peek3.count).toBe(0);
    expect(peek3.max_id).toBeNull();
  });

  it("is token-gated to the caller's id", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/peek-auth" });
    expect((await call("/peek", { id: rcpt.id })).status).toBe(401); // no token
    expect((await call("/peek", { id: rcpt.id }, "wrong-token")).status).toBe(401); // wrong token
    expect((await call("/peek", { id: rcpt.id }, rcpt.token)).status).toBe(200); // own token
  });
});

describe("cli.ts doorbell watcher", () => {
  it("blocks until the marker advances past the baseline, then prints and exits 0", async () => {
    const id = "dba-watchme";
    writeDoorbell(DB_PATH, id, 3); // an existing marker; --since 3 means only >3 wakes us
    const watcher = Bun.spawn(["bun", "cli.ts", "doorbell", id, "--since", "3", "--poll-ms", "300"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG_PATH },
      stdout: "pipe", stderr: "ignore",
    });
    // Give it a beat to arm the watch, then ring with a higher counter.
    await new Promise((r) => setTimeout(r, 600));
    writeDoorbell(DB_PATH, id, 7);
    const exited = await Promise.race([
      watcher.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 6000)),
    ]);
    const out = await new Response(watcher.stdout).text();
    if (exited === "timeout") { watcher.kill(); throw new Error("doorbell did not wake within 6s"); }
    expect(exited).toBe(0);
    expect(out).toContain(`mail for ${id} (mark=7)`);
  }, 12_000);
});
