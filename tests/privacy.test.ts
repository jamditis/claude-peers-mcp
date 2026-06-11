import { describe, expect, it } from "bun:test";

const textExtensions = new Set([
  ".json",
  ".md",
  ".ps1",
  ".sh",
  ".service",
  ".ts",
  ".yml",
  ".yaml",
  "",
]);

function trackedFiles(): string[] {
  const proc = Bun.spawnSync({ cmd: ["git", "ls-files", "-z"], stdout: "pipe", stderr: "pipe" });
  if (!proc.success) {
    throw new Error(`git ls-files failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().split("\0").filter(Boolean);
}

function isTextFile(path: string): boolean {
  if (path === "bun.lock") return false;
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot);
  return textExtensions.has(ext);
}

const blockedLiterals = [
  ["old repository owner", ["jam", "ditis"].join("")],
  ["old upstream owner", ["louis", "lva"].join("")],
  ["old node name", ["house", "of", "jawn"].join("")],
  ["old node name", ["legion", "2025"].join("")],
  ["old user home", ["/home/", "jam", "ditis"].join("")],
  ["old windows installer name", ["install", "-", "host", "-", "d", ".ps1"].join("")],
  ["old windows task installer name", ["install", "-", "host", "-", "d", "-", "broker", "-", "task", ".ps1"].join("")],
] as const;

const blockedPatterns = [
  ["old alp node prefix", `\\b${["h", "oj"].join("")}-[a-z0-9]+\\b`],
  ["old beta node prefix", `\\b${["o", "fj"].join("")}-[a-z0-9]+\\b`],
  ["old windows node prefix", `\\b${["a", "40"].join("")}-[a-z0-9]+\\b`],
] as const;

describe("privacy scrub", () => {
  it("keeps known private names and host-specific examples out of tracked text files", async () => {
    const leaks: string[] = [];

    for (const path of trackedFiles().filter(isTextFile)) {
      const text = await Bun.file(path).text();
      const lower = text.toLowerCase();

      for (const [label, literal] of blockedLiterals) {
        if (lower.includes(literal.toLowerCase())) leaks.push(`${path}: ${label}`);
      }

      for (const [label, source] of blockedPatterns) {
        if (new RegExp(source, "i").test(text)) leaks.push(`${path}: ${label}`);
      }
    }

    expect(leaks).toEqual([]);
  });
});
