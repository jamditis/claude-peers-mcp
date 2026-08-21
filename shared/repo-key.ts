// Git repository identity for peer discovery.
//
// Two derivations, because scope "repo" and the human-facing display want different things:
//   - getGitRoot  -> the worktree toplevel (`--show-toplevel`), shown to the user as the repo.
//   - getRepoKey  -> a stable identity shared by a checkout and all its linked worktrees, used to
//                    group them under scope "repo".
// A worktree's toplevel differs from the main checkout's, so the toplevel cannot answer "same
// repository?" across worktrees (issue #72). The common git dir can, so getRepoKey is built on it.

import { realpathSync } from "node:fs";

// The worktree toplevel, or null outside a git repository. Kept as the display value so a peer
// row still shows a readable path rather than an internal `.git` directory.
export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

// A canonical, absolute path so two sessions that reached the same location by different
// symlinked routes still compare equal. Falls back to the input if it cannot be resolved.
export function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// A stable identity for "the same repository", shared by a main checkout and all its linked
// worktrees. getGitRoot returns `--show-toplevel`, which differs per worktree, so it cannot
// group worktrees of one repo. The common git dir is shared across them, so it can. We ask for
// it with `--path-format=absolute`; without that flag `--git-common-dir` reports a relative path
// (".git" at the top, "../../.git" from a subdirectory) that would not compare across cwds.
// Requires git >= 2.31. An older git does not error on the unknown flag: rev-parse echoes it to
// stdout and still exits 0, so the output is not an absolute path. We therefore trust the result
// only when it is absolute, and otherwise fall back to the toplevel, which groups a plain checkout
// exactly as the previous match did. Null outside a git repository, so repo scope degrades to the
// directory match.
export async function getRepoKey(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      const raw = text.trim();
      // Absolute only: a pre-2.31 git echoes the unrecognized flag and/or a relative dir here.
      if (raw.startsWith("/")) return canonicalizePath(raw);
    }
  } catch {
    // fall through to the toplevel fallback
  }
  const top = await getGitRoot(cwd);
  return top ? canonicalizePath(top) : null;
}
