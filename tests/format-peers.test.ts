import { describe, expect, it } from "bun:test";
import {
  displaySessionName,
  formatAge,
  formatPeerList,
  NAME_DISPLAY_MAX_CHARS,
  SUMMARY_DISPLAY_MAX_CHARS,
} from "../shared/format-peers.ts";
import type { Peer } from "../shared/types.ts";

const NOW = Date.parse("2026-06-11T12:00:00.000Z");

function peer(overrides: Partial<Peer>): Peer {
  return {
    id: "alp-abc",
    pid: 1234,
    machine: "node-alpha",
    tailscale_ip: "100.64.0.10",
    cwd: "/workspace/projects/foo",
    git_root: "/workspace/projects/foo",
    tty: "pts/3",
    summary: "",
    registered_at: "2026-06-11T11:00:00.000Z",
    last_seen: "2026-06-11T11:59:52.000Z",
    ...overrides,
  };
}

describe("formatAge", () => {
  it("scales seconds -> minutes -> hours -> days", () => {
    expect(formatAge("2026-06-11T11:59:52.000Z", NOW)).toBe("8s");
    expect(formatAge("2026-06-11T11:57:00.000Z", NOW)).toBe("3m");
    expect(formatAge("2026-06-11T09:00:00.000Z", NOW)).toBe("3h");
    expect(formatAge("2026-06-09T12:00:00.000Z", NOW)).toBe("2d");
  });

  it("clamps a future timestamp (clock skew) to 0s and hides an unparseable one", () => {
    expect(formatAge("2026-06-11T12:00:30.000Z", NOW)).toBe("0s");
    expect(formatAge("not-a-date", NOW)).toBeNull();
  });
});

describe("formatPeerList", () => {
  it("renders one head line per peer: id, machine, cwd, age", () => {
    const text = formatPeerList([peer({})], "machine", NOW);
    expect(text).toBe("1 peer (scope: machine):\nalp-abc  node-alpha  /workspace/projects/foo  (seen 8s)");
  });

  it("shows a known session name as a parenthetical handle on the id", () => {
    const text = formatPeerList([peer({ name: "newsroom" })], "machine", NOW);
    expect(text).toContain("alp-abc (newsroom)  node-alpha  /workspace/projects/foo");
  });

  it("omits the handle entirely for an unnamed peer, reading as it did before names", () => {
    const text = formatPeerList([peer({ name: null })], "machine", NOW);
    expect(text).toBe("1 peer (scope: machine):\nalp-abc  node-alpha  /workspace/projects/foo  (seen 8s)");
  });

  it("collapses whitespace and truncates an over-long name", () => {
    const long = "x".repeat(NAME_DISPLAY_MAX_CHARS + 20);
    const text = formatPeerList([peer({ name: `  spaced\n  ${long}` })], "machine", NOW);
    // Whitespace normalized to single spaces, and the whole handle capped with an ellipsis.
    expect(text).toContain(`alp-abc (spaced ${"x".repeat(NAME_DISPLAY_MAX_CHARS - 1 - "spaced ".length)}…)`);
    expect(text).not.toContain("\n  x"); // the name never leaks onto its own line
  });

  it("indents a non-empty summary on its own line under the head line", () => {
    const text = formatPeerList([peer({ summary: "[auto] main; recent: server.ts" })], "machine", NOW);
    expect(text).toContain("\nalp-abc  node-alpha  /workspace/projects/foo  (seen 8s)\n  [auto] main; recent: server.ts");
  });

  it("tags remote peers and shows the repo only when it differs from cwd", () => {
    const remote = peer({
      id: "gam-xyz",
      machine: "node-gamma",
      is_remote: true,
      cwd: "/work/render/scenes",
      git_root: "/work/render",
    });
    const text = formatPeerList([remote], "machine", NOW);
    expect(text).toContain("gam-xyz  node-gamma [remote]  /work/render/scenes  (repo /work/render)  (seen 8s)");
  });

  it("omits the repo annotation when git_root equals cwd or is null", () => {
    const text = formatPeerList([peer({ git_root: null })], "machine", NOW);
    expect(text).not.toContain("(repo");
  });

  it("collapses newlines in a summary and truncates past the display cap", () => {
    const long = `Pattern: slack-brain DM auto-reply.\n${"x".repeat(SUMMARY_DISPLAY_MAX_CHARS)}`;
    const text = formatPeerList([peer({ summary: long })], "machine", NOW);
    const summaryLine = text.split("\n").find((l) => l.startsWith("  Pattern"));
    expect(summaryLine).toBeDefined();
    expect(summaryLine?.includes("\n")).toBe(false);
    // 2-space indent + capped text + ellipsis
    expect((summaryLine as string).length).toBeLessThanOrEqual(2 + SUMMARY_DISPLAY_MAX_CHARS + 1);
    expect(summaryLine?.endsWith("…")).toBe(true);
    // The protected-session marker at the head of the summary survives truncation.
    expect(summaryLine).toContain("Pattern: slack-brain");
  });

  it("pluralizes the header and separates peers by single newlines", () => {
    const text = formatPeerList(
      [peer({}), peer({ id: "alp-def", summary: "reviewing PR #7" })],
      "repo",
      NOW,
    );
    expect(text.startsWith("2 peers (scope: repo):\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(4); // header + head line + head line + summary line
  });

  it("hides the age when last_seen is unparseable rather than rendering NaN", () => {
    const text = formatPeerList([peer({ last_seen: "garbage" })], "machine", NOW);
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("(seen");
  });
});

describe("displaySessionName", () => {
  it("collapses internal whitespace and trims", () => {
    expect(displaySessionName("  morning\tdesk  team  ")).toBe("morning desk team");
  });

  it("returns a short name unchanged", () => {
    expect(displaySessionName("newsroom")).toBe("newsroom");
  });

  it("truncates past the cap with a single-character ellipsis", () => {
    const long = "a".repeat(80);
    const shown = displaySessionName(long);
    expect(shown).toBe(`${"a".repeat(NAME_DISPLAY_MAX_CHARS - 1)}…`);
    expect(shown.length).toBe(NAME_DISPLAY_MAX_CHARS);
  });

  it("is the exact handle formatPeerList renders", () => {
    // The parenthetical in the peer list must equal displaySessionName for that name, so a
    // name copied from the list resolves back to the peer in send_message.
    const long = "desk-".repeat(20); // > cap
    const text = formatPeerList([peer({ name: long })], "machine", NOW);
    expect(text).toContain(`(${displaySessionName(long)})`);
  });

  it("returns empty for a whitespace-only name", () => {
    expect(displaySessionName("   ")).toBe("");
  });
});
