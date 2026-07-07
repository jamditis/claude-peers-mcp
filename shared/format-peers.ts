/**
 * Compact textual rendering of list_peers for the MCP tool result.
 * One head line per peer plus an indented summary line — the old block format
 * spent ~8 lines per peer on fields that were redundant (repo usually equals
 * cwd), rarely consulted (tty, tailscale_ip — routing is by id), or verbose
 * (raw ISO timestamps). list_peers runs before every peer-affecting action,
 * so its rendering is a recurring token cost for every session on the mesh.
 */

import type { Peer } from "./types.ts";

/** Display cap for one peer's summary inside list_peers output. set_summary accepts
 * any length, so without a cap one wordy peer inflates every other session's listing.
 * Truncation keeps the head of the summary, where identifying markers live. */
export const SUMMARY_DISPLAY_MAX_CHARS = 200;

/** Display cap for a peer's session name. Names are short handles, but a caller could set a
 * long CLAUDE_PEERS_SESSION_NAME override, so cap it rather than let one peer widen the head line. */
export const NAME_DISPLAY_MAX_CHARS = 60;

/** Relative age ("8s", "3m", "3h", "2d") of an ISO timestamp. Future timestamps
 * (clock skew across machines) clamp to "0s"; an unparseable one returns null so
 * the caller omits the field instead of rendering NaN. */
export function formatAge(iso: string, nowMs: number): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The addressable handle for a session name: internal whitespace collapsed, the string trimmed,
 * then truncated with an ellipsis past NAME_DISPLAY_MAX_CHARS. This is the exact form list_peers
 * renders in parentheses, so send_message can resolve a name against the same string a user reads
 * there — the displayed name is always the sendable name. Returns "" for an empty or
 * whitespace-only name, which callers treat as unnamed. */
export function displaySessionName(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim();
  return collapsed.length > NAME_DISPLAY_MAX_CHARS
    ? `${collapsed.slice(0, NAME_DISPLAY_MAX_CHARS - 1)}…`
    : collapsed;
}

export function formatPeerList(peers: Peer[], scope: string, nowMs: number): string {
  const header = `${peers.length} peer${peers.length === 1 ? "" : "s"} (scope: ${scope}):`;
  const blocks = peers.map((p) => {
    // The friendly name rides right on the id as a parenthetical handle ("<id> (newsroom)"),
    // so a human or agent can match the name they were given to the id routing needs. Omitted
    // when unknown so an unnamed peer reads exactly as it did before names existed.
    const name = p.name ? displaySessionName(p.name) : "";
    const namePart = name ? ` (${name})` : "";
    const head = [`${p.id}${namePart}  ${p.machine}${p.is_remote ? " [remote]" : ""}`, p.cwd];
    if (p.git_root && p.git_root !== p.cwd) head.push(`(repo ${p.git_root})`);
    const age = formatAge(p.last_seen, nowMs);
    if (age !== null) head.push(`(seen ${age})`);
    const lines = [head.join("  ")];
    const summary = p.summary?.replace(/\s*\n\s*/g, " ").trim() ?? "";
    if (summary) {
      const capped =
        summary.length > SUMMARY_DISPLAY_MAX_CHARS
          ? `${summary.slice(0, SUMMARY_DISPLAY_MAX_CHARS - 1)}…`
          : summary;
      lines.push(`  ${capped}`);
    }
    return lines.join("\n");
  });
  return [header, ...blocks].join("\n");
}
