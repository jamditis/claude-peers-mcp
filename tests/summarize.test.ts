import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_SUMMARY_MAX_CHARS,
  buildAutoSummary,
  getGitBranch,
  getRecentFiles,
} from "../shared/summarize.ts";

// A real throwaway git repo: the helpers shell out to git, so a fixture repo is the
// honest test substrate (no mocking Bun.spawn).
let repoDir: string;
let plainDir: string;

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
}

beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "peers-summarize-repo-"));
  plainDir = mkdtempSync(join(tmpdir(), "peers-summarize-plain-"));

  await git(["init", "-b", "main"], repoDir);
  await git(["config", "user.email", "test@example.com"], repoDir);
  await git(["config", "user.name", "test"], repoDir);
  await Bun.write(join(repoDir, "alpha.ts"), "export const a = 1;\n");
  await Bun.write(join(repoDir, "beta.ts"), "export const b = 2;\n");
  await git(["add", "."], repoDir);
  await git(["commit", "-m", "init"], repoDir);
  // One uncommitted edit so getRecentFiles has working-tree changes to surface first.
  await Bun.write(join(repoDir, "alpha.ts"), "export const a = 2;\n");
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
});

describe("buildAutoSummary", () => {
  it("produces a tagged branch + recent-files line in a git repo", async () => {
    const summary = await buildAutoSummary(repoDir);
    expect(summary.startsWith("[auto] main")).toBe(true);
    expect(summary).toContain("alpha.ts");
  });

  it("returns empty string outside a git repo (cwd alone is already visible to peers)", async () => {
    expect(await buildAutoSummary(plainDir)).toBe("");
  });

  it("stays within the length cap even with long paths", async () => {
    const deep = join(repoDir, "a-rather-long-directory-name", "another-long-segment");
    await git(["checkout", "-b", "feature/a-very-long-branch-name-for-testing-truncation"], repoDir);
    for (let i = 0; i < 5; i++) {
      const f = join(deep, `some-quite-long-file-name-number-${i}.ts`);
      await Bun.write(f, `export const x${i} = ${i};\n`);
    }
    await git(["add", "."], repoDir);
    const summary = await buildAutoSummary(repoDir);
    expect(summary.length).toBeLessThanOrEqual(AUTO_SUMMARY_MAX_CHARS);
    expect(summary.startsWith("[auto] feature/a-very-long-branch-name-for-testing-truncation")).toBe(true);
    // Unstage and remove the fixture files so later getRecentFiles tests see only alpha.ts.
    await git(["reset"], repoDir);
    rmSync(join(repoDir, "a-rather-long-directory-name"), { recursive: true, force: true });
    await git(["checkout", "main"], repoDir);
  });

  it("never throws on an unreadable directory — registration must not fail over a summary", async () => {
    expect(await buildAutoSummary("/definitely/absent/dir")).toBe("");
  });
});

describe("getGitBranch", () => {
  it("reads the branch in a repo and null outside one", async () => {
    expect(await getGitBranch(repoDir)).toBe("main");
    expect(await getGitBranch(plainDir)).toBeNull();
  });
});

describe("getRecentFiles", () => {
  it("lists working-tree changes ahead of recent commits, capped at the limit", async () => {
    const files = await getRecentFiles(repoDir, 2);
    expect(files.length).toBeLessThanOrEqual(2);
    expect(files[0]).toBe("alpha.ts");
  });

  it("returns [] outside a git repo", async () => {
    expect(await getRecentFiles(plainDir)).toEqual([]);
  });
});
