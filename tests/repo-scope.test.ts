// tests/repo-scope.test.ts
//
// The broker half of issue #72: scope "repo" must group every peer that shares a repo_key (a main
// checkout and its worktrees all report the same one), keep a peer from a different repository out,
// and leave scope "directory" matching on the exact cwd. Drives a real broker over HTTP.

import { afterAll, beforeAll, describe as bunDescribe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";

const describe = bunDescribe.skipIf(process.platform === "win32");

const PORT = 17905;
const CONFIG_PATH = "/tmp/config-reposcope.json";
const DB_PATH = "/tmp/broker-reposcope.db";
const config = {
  machine: "rsc-a",
  tailscale_ip: "127.0.0.1",
  port: PORT,
  id_prefix: "rsc",
  siblings: [],
  allowed_ips: ["127.0.0.1"],
};

// Two repositories, identified by their common git dir. The three worktree cwds differ but share
// REPO_KEY, exactly as getRepoKey would report for a real checkout plus two worktrees.
const REPO_KEY = "/tmp/rsc-repo/.git";
const OTHER_KEY = "/tmp/rsc-other/.git";
const MAIN = "/tmp/rsc-repo";
const WT1 = "/tmp/rsc-repo-wt1";
const WT2 = "/tmp/rsc-repo-wt2";
const OTHER = "/tmp/rsc-other";

let proc: any;
// One live child process per peer: the broker filters rows whose pid is dead, and a same-pid
// re-register supersedes the prior row, so each peer needs its own alive pid. `sleep` holds one.
const holders: any[] = [];

async function post(path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} failed: ${res.status} - ${text}`);
  return JSON.parse(text);
}

function register(cwd: string, repo_key: string | null) {
  const holder = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
  holders.push(holder);
  return post("/register", {
    pid: holder.pid, cwd, git_root: cwd, repo_key, tty: null, summary: "",
    machine: config.machine, tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null,
  });
}

describe("repo-scoped discovery across worktrees", () => {
  beforeAll(async () => {
    await Bun.write(CONFIG_PATH, JSON.stringify(config));
    try { unlinkSync(DB_PATH); } catch {}
    proc = Bun.spawn(["bun", "broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG_PATH, CLAUDE_PEERS_DB: DB_PATH },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 20; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    await register(MAIN, REPO_KEY);
    await register(WT1, REPO_KEY);
    await register(WT2, REPO_KEY);
    await register(OTHER, OTHER_KEY);
  });

  afterAll(() => {
    proc?.kill();
    for (const h of holders) h.kill();
    try { unlinkSync(DB_PATH); } catch {}
    try { unlinkSync(CONFIG_PATH); } catch {}
  });

  it("groups the main checkout and both worktrees under scope repo", async () => {
    const peers = await post("/list-peers", { scope: "repo", cwd: MAIN, repo_key: REPO_KEY }) as any[];
    const cwds = peers.map((p) => p.cwd).sort();
    expect(cwds).toEqual([MAIN, WT1, WT2].sort());
  });

  it("excludes a peer from a different repository", async () => {
    const peers = await post("/list-peers", { scope: "repo", cwd: MAIN, repo_key: REPO_KEY }) as any[];
    expect(peers.some((p) => p.cwd === OTHER)).toBe(false);
  });

  it("keeps scope directory matching the exact cwd", async () => {
    const peers = await post("/list-peers", { scope: "directory", cwd: WT1, repo_key: REPO_KEY }) as any[];
    expect(peers.map((p) => p.cwd)).toEqual([WT1]);
  });

  it("falls back to the directory match when the caller has no repo_key", async () => {
    // Outside a git repo (repo_key null), scope repo must behave like scope directory, not match
    // every keyless peer together.
    const peers = await post("/list-peers", { scope: "repo", cwd: WT2, repo_key: null }) as any[];
    expect(peers.map((p) => p.cwd)).toEqual([WT2]);
  });
});
