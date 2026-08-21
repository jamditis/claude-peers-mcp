// tests/repo-key.test.ts
//
// The repository-identity derivation behind scope "repo" (issue #72). getRepoKey must return one
// stable value for a main checkout and every linked worktree of the same repository, a different
// value for an unrelated repository, and null outside a repository. These use real `git` on a
// real temporary repository with two real worktrees, since the whole bug is that a worktree's
// toplevel diverges from the main checkout's.

import { afterAll, beforeAll, describe as bunDescribe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitRoot, getRepoKey } from "../shared/repo-key.ts";

// getRepoKey shells out to `git`; skip on native Windows where the test's POSIX assumptions and
// path handling do not hold (mirrors the integration suite's platform gate, #22/#53).
const describe = bunDescribe.skipIf(process.platform === "win32");

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
  }
}

// A self-contained repository with one commit, isolated from the caller's git identity and any
// ambient commit signing (the fleet configures gpg globally; an unsigned test commit must not
// try to sign). Returns the main checkout path.
function makeRepo(base: string, name: string): string {
  const root = join(base, name);
  git(base, "init", "-q", "-b", "main", root);
  git(root, "-c", "user.email=t@e", "-c", "user.name=t", "-c", "commit.gpgsign=false",
      "commit", "--allow-empty", "-m", "init");
  return root;
}

describe("getRepoKey groups a repository and its worktrees", () => {
  let base = "";
  let repo = "";
  let wt1 = "";
  let wt2 = "";
  let other = "";
  let plain = "";

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "repo-key-"));
    repo = makeRepo(base, "repo");
    wt1 = join(base, "wt1");
    wt2 = join(base, "wt2");
    // Detached worktrees avoid inventing branch names; the identity we test is the shared repo,
    // not any branch.
    git(repo, "worktree", "add", "--detach", wt1, "HEAD");
    git(repo, "worktree", "add", "--detach", wt2, "HEAD");
    other = makeRepo(base, "other");
    plain = join(base, "plain"); // never `git init`ed
    Bun.spawnSync(["mkdir", "-p", plain]);
    writeFileSync(join(plain, "f"), "x");
  });

  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("returns one stable key for the main checkout and every worktree", async () => {
    const kMain = await getRepoKey(repo);
    const kWt1 = await getRepoKey(wt1);
    const kWt2 = await getRepoKey(wt2);
    expect(kMain).toBeTruthy();
    expect(kWt1).toBe(kMain);
    expect(kWt2).toBe(kMain);
  });

  it("proves the toplevel could NOT group them (the reason repo_key exists)", async () => {
    // getGitRoot is the old match key. It differs per worktree, so matching on it would split one
    // repository into three, which is exactly issue #72.
    const gMain = await getGitRoot(repo);
    const gWt1 = await getGitRoot(wt1);
    expect(gMain).toBeTruthy();
    expect(gWt1).toBeTruthy();
    expect(gWt1).not.toBe(gMain);
  });

  it("keeps two unrelated repositories isolated", async () => {
    const kRepo = await getRepoKey(repo);
    const kOther = await getRepoKey(other);
    expect(kOther).toBeTruthy();
    expect(kOther).not.toBe(kRepo);
  });

  it("returns null outside a git repository", async () => {
    expect(await getRepoKey(plain)).toBeNull();
    expect(await getGitRoot(plain)).toBeNull();
  });
});
