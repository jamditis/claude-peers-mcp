import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { doorbellPath, readDoorbell, readDrainedDoorbell, removeDoorbell, writeDoorbell, writeDrainedDoorbell } from "../shared/notify.ts";
import { handleTool, type ToolContext } from "../shared/tool-results.ts";
import type { doorbellRecipe } from "../shared/doorbell-session.ts";
import { singleHostDefault } from "../shared/config.ts";
import { PROTOCOL_VERSION } from "../shared/types.ts";

const root = resolve(import.meta.dir, "..");
const children: ReturnType<typeof Bun.spawn>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const work = mkdtempSync(join(tmpdir(), "doorbell-startup-"));
  directories.push(work);
  const dbPath = join(work, "store with spaces.db");
  const configPath = join(work, "config.json");
  // Deliberately different from the MCP server's resolved DB: --db-path must win.
  writeFileSync(configPath, JSON.stringify({ machine: "test", tailscale_ip: "127.0.0.1", port: 1,
    id_prefix: "test", siblings: [], allowed_ips: ["127.0.0.1"], db_path: join(work, "wrong.db") }));
  const context: ToolContext = {
    myId: "old-peer", myCwd: work, myGitRoot: null, myRepoKey: null,
    cliPath: join(root, "cli.ts"), doorbell: { dbPath, ownerPid: process.pid }, onSummary() {},
    // Network seam models authenticated recovery returning the replacement peer.
    async brokerFetch<T>() { return { id: "test-peer", count: 3, max_id: 9 } as T; },
  };
  function launch(argv: string[], timeout = 4, cwd = work) {
    const child = Bun.spawn([...argv, "--poll-ms", "250", "--timeout", String(timeout)], {
      cwd, env: { ...process.env, CLAUDE_PEERS_CONFIG: configPath }, stdout: "pipe", stderr: "pipe",
    });
    children.push(child);
    return child;
  }
  return { work, dbPath, context, launch };
}

async function recipe(context: ToolContext) {
  const result = await handleTool("peek_messages", {}, context);
  if (!("structuredContent" in result) || !result.structuredContent) throw new Error("Missing launch recipe");
  const payload = result.structuredContent as { doorbell: ReturnType<typeof doorbellRecipe> };
  expect(payload.doorbell.state).toBe("requires_host_launch");
  return payload.doorbell.argv;
}

async function remaining(child: ReturnType<ReturnType<typeof fixture>["launch"]>) {
  const reader = child.stdout.getReader();
  let output = "";
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return output;
      output += new TextDecoder().decode(item.value);
    }
  } finally { reader.releaseLock(); }
}

async function outputUntil(child: ReturnType<ReturnType<typeof fixture>["launch"]>, needle: string) {
  const reader = child.stdout.getReader();
  let output = "";
  try {
    while (!output.includes(needle)) {
      const item = await reader.read();
      if (item.done) throw new Error(`Watcher exited before ${needle}: ${output}`);
      output += new TextDecoder().decode(item.value);
    }
  } finally { reader.releaseLock(); }
  return output;
}

const armed = (child: ReturnType<ReturnType<typeof fixture>["launch"]>) => outputUntil(child, "doorbell armed");

test("startup with queued mail binds the recovered peer and catches mail before child launch", async () => {
  const f = fixture();
  writeDoorbell(f.dbPath, "test-peer", 9);
  const argv = await recipe(f.context);
  expect(argv).toContain("test-peer");
  expect(argv).not.toContain("old-peer");
  // Message lands after peek and before the host launches the background task.
  writeDoorbell(f.dbPath, "test-peer", 10);
  const child = f.launch(argv);
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain("mail for test-peer (mark=10)");
  expect(readDoorbell(f.dbPath, "test-peer")).toBe(10); // notify only
  expect(existsSync(`${doorbellPath(f.dbPath, "test-peer")}.watcher`)).toBe(false);
});

test("empty-mail recipes establish a marker before the host launches a watcher", async () => {
  const f = fixture();
  f.context.brokerFetch = async <T>() => ({ id: "test-peer", count: 0, max_id: null }) as T;
  const argv = await recipe(f.context);
  expect(readDoorbell(f.dbPath, "test-peer")).toBe(0);
  expect(existsSync(doorbellPath(f.dbPath, "old-peer") as string)).toBe(false);
  expect(argv[argv.indexOf("--since") + 1]).toBe("0");
  const child = f.launch(argv);
  await armed(child);
  writeDoorbell(f.dbPath, "test-peer", 1);
  expect(await child.exited).toBe(0);
});

for (const exclusive of [true, false]) {
  test(`a managed launch never recreates a peer marker removed after peek (exclusive=${exclusive})`, async () => {
    const f = fixture();
    writeDoorbell(f.dbPath, "test-peer", 9);
    const argv = await recipe(f.context);
    if (!exclusive) argv.splice(argv.indexOf("--exclusive"), 1);
    // Unregister/rebinding removes the old marker even while the MCP owner lives.
    removeDoorbell(f.dbPath, "test-peer");
    writeDoorbell(f.dbPath, "replacement-peer", 10);
    const child = f.launch(argv, 1);
    expect(await child.exited).toBe(4);
    const output = await new Response(child.stdout).text();
    expect(output).toContain("peer marker removed");
    expect(output).not.toContain("doorbell armed");
    expect(output).not.toContain("mail for");
    expect(existsSync(doorbellPath(f.dbPath, "test-peer") as string)).toBe(false);
    expect(existsSync(`${doorbellPath(f.dbPath, "test-peer")}.watcher`)).toBe(false);
    expect(readDoorbell(f.dbPath, "replacement-peer")).toBe(10);
    f.context.brokerFetch = async <T>() => ({ id: "replacement-peer", count: 0, max_id: null }) as T;
    const replacement = f.launch(await recipe(f.context));
    await armed(replacement);
    writeDoorbell(f.dbPath, "replacement-peer", 11);
    expect(await replacement.exited).toBe(0);
  });
}

test("legacy manual watchers still create an absent marker", async () => {
  const f = fixture();
  const child = f.launch([process.execPath, join(root, "cli.ts"), "doorbell", "test-peer", "--db-path", f.dbPath]);
  expect(await armed(child)).toContain("since=0");
  expect(readDoorbell(f.dbPath, "test-peer")).toBe(0);
  writeDoorbell(f.dbPath, "test-peer", 1);
  expect(await child.exited).toBe(0);
});

test("manual doorbells wake for remote mail arriving after a drain and before launch", async () => {
  const f = fixture();
  const port = 17955;
  const configPath = join(f.work, "config.json");
  writeFileSync(configPath, JSON.stringify({ machine: "test", tailscale_ip: "127.0.0.1", port,
    id_prefix: "test", siblings: [], allowed_ips: ["127.0.0.1"], db_path: f.dbPath, auto_summary: false }));
  const broker = Bun.spawn([process.execPath, join(root, "broker.ts")], {
    env: { ...process.env, CLAUDE_PEERS_CONFIG: configPath }, stdout: "ignore", stderr: "ignore",
  });
  children.push(broker);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 2000;
  for (;;) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch {}
    if (Date.now() >= deadline) throw new Error("Test broker did not start");
    await Bun.sleep(25);
  }
  async function request<T>(path: string, body: unknown, token?: string): Promise<T> {
    const response = await fetch(`${url}${path}`, { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    expect(response.status).toBe(200);
    return response.json() as Promise<T>;
  }
  const peer = await request<{ id: string; token: string }>("/register", {
    pid: process.pid, cwd: f.work, git_root: null, tty: null, summary: "", machine: "test",
    tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null,
  });
  const poll = () => request<{ messages: { id: number; text: string }[] }>("/poll-messages", { id: peer.id }, peer.token);
  const forward = async (text: string) => {
    expect(await request("/forward-message", { protocol_version: PROTOCOL_VERSION,
      from_id: "remote-peer", from_machine: "remote", to_id: peer.id, text })).toMatchObject({ ok: true, poll_only: true });
    return readDoorbell(f.dbPath, peer.id);
  };
  const launch = () => f.launch([process.execPath, join(root, "cli.ts"), "doorbell", peer.id, "--db-path", f.dbPath], 2);

  // Pending mail on the first launch must also wake without an explicit --since.
  const first = await forward("already queued");
  const startup = launch();
  expect(await startup.exited).toBe(0);
  expect(await remaining(startup)).toContain(`mark=${first}`);
  expect((await poll()).messages.map(m => m.text)).toEqual(["already queued"]);
  expect(readDrainedDoorbell(f.dbPath, peer.id)).toBe(first);

  const gap = await forward("in the launch gap");
  const delayed = launch();
  expect(await delayed.exited).toBe(0);
  const output = await remaining(delayed);
  expect(output).toContain(`since=${first}`);
  expect(output).toContain(`mark=${gap}`);
  expect(output).toContain("run check_messages, then re-arm");
  expect(readDrainedDoorbell(f.dbPath, peer.id)).toBe(first); // watching never consumes
  expect((await poll()).messages.map(m => m.text)).toEqual(["in the launch gap"]);

  const armedWatcher = launch();
  expect(await armed(armedWatcher)).toContain(`since=${gap}`);
  const later = await forward("after arming");
  expect(await armedWatcher.exited).toBe(0);
  expect(await remaining(armedWatcher)).toContain(`mark=${later}`);
  expect((await poll()).messages.map(m => m.text)).toEqual(["after arming"]);

  const prefix = await forward("readable prefix");
  const lease = await forward("in flight");
  const suffix = await forward("behind lease");
  const db = new Database(f.dbPath);
  try {
    db.run("UPDATE messages SET delivery_state = 'delivering' WHERE id = ?", [lease]);
    expect((await poll()).messages.map(m => m.text)).toEqual(["readable prefix"]);
    expect(readDrainedDoorbell(f.dbPath, peer.id)).toBe(prefix);
    db.run("UPDATE messages SET delivery_state = 'queued' WHERE id = ?", [lease]);
    expect((await poll()).messages.map(m => m.text)).toEqual(["in flight", "behind lease"]);
    expect(readDrainedDoorbell(f.dbPath, peer.id)).toBe(suffix);
  } finally { db.close(); }
  // A signal left by already-delivered mail is acknowledged by an empty poll.
  writeDoorbell(f.dbPath, peer.id, suffix + 1);
  expect((await poll()).messages).toEqual([]);
  expect(readDrainedDoorbell(f.dbPath, peer.id)).toBe(suffix + 1);
  await request("/unregister", { id: peer.id }, peer.token);
  expect(existsSync(`${doorbellPath(f.dbPath, peer.id)}.drained`)).toBe(false);
}, 10_000);

test("one host task per peer, arm-before-drain, and rearm after each fire", async () => {
  const f = fixture();
  f.context.brokerFetch = async <T>() => ({ id: "test-peer", count: 0, max_id: null }) as T;
  for (const mark of [1, 2]) {
    const argv = await recipe(f.context);
    const child = f.launch(argv);
    expect(await armed(child)).toContain("consumed=false");
    const duplicate = f.launch(argv);
    expect(await duplicate.exited).toBe(3);
    expect(await new Response(duplicate.stderr).text()).toContain("retain the original host task");
    // A different peer's signal never completes this task.
    writeDoorbell(f.dbPath, "another-peer", 900);
    expect(child.exitCode).toBeNull();
    // Represents arrival during or just after the startup drain.
    writeDoorbell(f.dbPath, "test-peer", mark);
    expect(await child.exited).toBe(0);
    expect(await remaining(child)).toContain(`mark=${mark}`);
  }
});

test("timeout releases the guard without claiming a mail signal", async () => {
  const f = fixture();
  const child = f.launch(await recipe(f.context), 1);
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(2);
  expect(output).toContain("no mail for test-peer");
  expect(existsSync(`${doorbellPath(f.dbPath, "test-peer")}.watcher`)).toBe(false);
});

test("owner exit stops the task without reporting mail and releases its lock", async () => {
  const f = fixture();
  const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  children.push(owner);
  f.context.doorbell = { dbPath: f.dbPath, ownerPid: owner.pid };
  const child = f.launch(await recipe(f.context));
  await armed(child);
  owner.kill();
  await owner.exited;
  expect(await child.exited).toBe(4);
  expect(await remaining(child)).not.toContain("mail for");
  expect(existsSync(`${doorbellPath(f.dbPath, "test-peer")}.watcher`)).toBe(false);
});

test("peer removal stops a stale binding; an abandoned lock fails closed", async () => {
  const f = fixture();
  const argv = await recipe(f.context);
  const child = f.launch(argv);
  await armed(child);
  removeDoorbell(f.dbPath, "test-peer");
  expect(await child.exited).toBe(4);
  const lockPath = `${doorbellPath(f.dbPath, "test-peer")}.watcher`;
  writeFileSync(lockPath, "abandoned or unverifiable owner");
  const blocked = f.launch(argv);
  expect(await blocked.exited).toBe(3);
  expect(existsSync(lockPath)).toBe(true); // never steal an unknown host task
});

test("missing host integration returns no armed claim; malformed baseline fails", async () => {
  const f = fixture();
  const { doorbell: _doorbell, ...unsupported } = f.context;
  const result = await handleTool("peek_messages", {}, unsupported);
  expect(result.content[0]?.text).toContain("No watcher has been armed");
  const argv = await recipe(f.context);
  argv[argv.indexOf("--since") + 1] = "3garbage";
  const child = f.launch(argv);
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stdout).text()).not.toContain("doorbell armed");
});

test("relative no-config database override stays bound to the MCP cwd", async () => {
  const f = fixture();
  const previous = process.env.CLAUDE_PEERS_DB;
  try {
    process.env.CLAUDE_PEERS_DB = "store with spaces.db";
    f.context.doorbell = { dbPath: singleHostDefault().db_path, ownerPid: process.pid };
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PEERS_DB;
    else process.env.CLAUDE_PEERS_DB = previous;
  }
  writeDoorbell(f.dbPath, "test-peer", 9);
  const argv = await recipe(f.context);
  expect(argv[argv.indexOf("--db-path") + 1]).toBe(f.dbPath);
  expect(argv[argv.indexOf("--since") + 1]).toBe("9");
  const otherCwd = join(f.work, "host task");
  mkdirSync(otherCwd);
  writeDoorbell(f.dbPath, "test-peer", 10);
  const child = f.launch(argv, 4, otherCwd);
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toContain("mark=10");
  expect(existsSync(join(otherCwd, "store with spaces.db.doorbells"))).toBe(false);
});

test("an existing directory at the marker path never reports armed", async () => {
  const f = fixture();
  const argv = await recipe(f.context);
  removeDoorbell(f.dbPath, "test-peer");
  mkdirSync(doorbellPath(f.dbPath, "test-peer") as string, { recursive: true });
  const child = f.launch(argv, 1);
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stdout).text()).not.toContain("doorbell armed");
  expect(existsSync(`${doorbellPath(f.dbPath, "test-peer")}.watcher`)).toBe(false);
});

test("persistent marker read failures stop an armed task visibly", async () => {
  const f = fixture();
  const child = f.launch(await recipe(f.context));
  await armed(child);
  writeFileSync(doorbellPath(f.dbPath, "test-peer") as string, "invalid counter");
  expect(await child.exited).toBe(1);
  expect(await remaining(child)).toContain("marker unreadable");
  expect(existsSync(`${doorbellPath(f.dbPath, "test-peer")}.watcher`)).toBe(false);
});

test("a corrupt startup counter never reports armed even with an explicit baseline", async () => {
  const f = fixture();
  writeDoorbell(f.dbPath, "test-peer", 9);
  const argv = await recipe(f.context);
  writeFileSync(doorbellPath(f.dbPath, "test-peer") as string, "invalid counter");
  const child = f.launch(argv);
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stdout).text()).not.toContain("doorbell armed");
  expect(existsSync(`${doorbellPath(f.dbPath, "test-peer")}.watcher`)).toBe(false);
});

test("a transient empty read recovers and still signals the next counter", async () => {
  const f = fixture();
  const child = f.launch(await recipe(f.context));
  await armed(child);
  writeFileSync(doorbellPath(f.dbPath, "test-peer") as string, "");
  await outputUntil(child, "marker unreadable; retrying");
  writeDoorbell(f.dbPath, "test-peer", 7);
  expect(await child.exited).toBe(0);
  const output = await remaining(child);
  expect(output).toContain("marker readable");
  expect(output).toContain("mark=7");
});

for (const explicitBaseline of [true, false]) {
  test(`startup empty marker recovers before readiness (${explicitBaseline ? "explicit" : "default"} baseline)`, async () => {
    const f = fixture();
    writeDoorbell(f.dbPath, "test-peer", 0);
    writeDrainedDoorbell(f.dbPath, "test-peer", 3);
    const argv = await recipe(f.context);
    if (!explicitBaseline) argv.splice(argv.indexOf("--since"), 2);
    writeFileSync(doorbellPath(f.dbPath, "test-peer") as string, "");
    const child = f.launch(argv);
    const waiting = await outputUntil(child, "marker unreadable; retrying");
    expect(waiting).not.toContain("doorbell armed");
    expect(child.exitCode).toBeNull();
    writeDoorbell(f.dbPath, "test-peer", 7);
    let output = "";
    if (!explicitBaseline) {
      output = await armed(child);
      expect(output).toContain("since=3");
    }
    expect(await child.exited).toBe(0);
    output += await remaining(child);
    expect(output).toContain("doorbell armed");
    expect(output).toContain("mark=7");
    expect(existsSync(`${doorbellPath(f.dbPath, "test-peer")}.watcher`)).toBe(false);
  });
}
