import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { doorbellPath, readDoorbell, removeDoorbell, writeDoorbell } from "../shared/notify.ts";
import { handleTool, type ToolContext } from "../shared/tool-results.ts";
import type { doorbellRecipe } from "../shared/doorbell-session.ts";
import { singleHostDefault } from "../shared/config.ts";

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
