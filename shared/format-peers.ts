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

export function formatPeerList(peers: Peer[], scope: string, nowMs: number): string {
  const header = `${peers.length} peer${peers.length === 1 ? "" : "s"} (scope: ${scope}):`;
  const blocks = peers.map((p) => {
    const head = [`${p.id}  ${p.machine}${p.is_remote ? " [remote]" : ""}`, p.cwd];
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
