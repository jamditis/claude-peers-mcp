/**
 * Git context helpers for gathering peer context.
 * buildAutoSummary seeds a peer's summary at registration from git state alone,
 * so a fresh session is discoverable without spending an inference turn on
 * set_summary. The set_summary MCP tool overwrites it once the task is clearer.
 */

/** Hard cap on the auto summary — it rides in every list_peers response and gossips
 * across machines, so it must stay cheap to read. */
export const AUTO_SUMMARY_MAX_CHARS = 140;

/**
 * Build a one-line summary from git state: "[auto] <branch>; recent: f1, f2, f3".
 * Returns "" outside a git repo (cwd is already a list_peers field — a non-git
 * summary would add nothing) and never throws: registration must not fail over
 * a cosmetic field.
 */
export async function buildAutoSummary(cwd: string): Promise<string> {
  try {
    const branch = await getGitBranch(cwd);
    if (!branch) return "";
    let summary = `[auto] ${branch}`;
    for (const file of await getRecentFiles(cwd, 3)) {
      const next = summary.includes("; recent: ") ? `${summary}, ${file}` : `${summary}; recent: ${file}`;
      // Whole-file truncation: a path that does not fit is dropped, never cut mid-name.
      if (next.length > AUTO_SUMMARY_MAX_CHARS) break;
      summary = next;
    }
    return summary.slice(0, AUTO_SUMMARY_MAX_CHARS);
  } catch {
    return "";
  }
}

/**
 * Get the current git branch name for a directory.
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
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

/**
 * Get recently modified tracked files in the git repo.
 */
export async function getRecentFiles(
  cwd: string,
  limit = 10
): Promise<string[]> {
  try {
    // Get modified/staged files first
    const diffProc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const diffText = await new Response(diffProc.stdout).text();
    await diffProc.exited;

    const files = diffText
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    if (files.length >= limit) {
      return files.slice(0, limit);
    }

    // Also get recently committed files
    const logProc = Bun.spawn(
      ["git", "log", "--oneline", "--name-only", "-5", "--format="],
      {
        cwd,
        stdout: "pipe",
        stderr: "ignore",
      }
    );
    const logText = await new Response(logProc.stdout).text();
    await logProc.exited;

    const logFiles = logText
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    const allFiles = [...new Set([...files, ...logFiles])];
    return allFiles.slice(0, limit);
  } catch {
    return [];
  }
}
