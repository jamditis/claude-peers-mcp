// shared/notify.ts
//
// The doorbell: a per-recipient marker file the broker touches when mail is queued for a
// delivery_kind='none' session, so an interactive non-tmux session can be woken in seconds
// instead of waiting for its next manual check_messages (issue #49).
//
// The marker is a content-free SIGNAL, not a message store: it holds a single monotonically
// increasing counter (the recipient's max pending row id), nothing else — no sender, no text,
// no delivery_state. The watcher treats it as LEVEL-triggered state, not an edge: it never
// counts events, it only compares the file's current value against the value it last drained.
// That collapses the whole class of "signal arrived while I was mid-consume" races and makes
// the (coalescing, sometimes-double-firing) fs.watch semantics not matter — a missed event is
// harmless as long as no state is missed. The counter is the recipient's max pending message
// id, clamped by writeDoorbell so it only ever grows; the watcher fires whenever it advances
// past the baseline it armed with. The clamp is what makes that true, and it is load-bearing:
// message ids are AUTOINCREMENT, but a max over the PENDING rows is not monotonic on its own,
// because a row leaving the pending set can lower it. Delivering a later pushable row while an
// earlier poll-only row still waits does exactly that.
//
// Reading the marker is never a consume: check_messages (/poll-messages + markPolled) stays
// the single path that flips a row to delivered, so the never-ack invariant is unchanged. A
// write that lands in a file nobody is watching just sits there — the broker never blocks and
// never errors on an absent watcher, and the session degrades to exactly today's poll-only
// floor. The marker carries no message body, so the watcher reads only this signal, never the
// SQLite store directly, and stays decoupled from the messages schema.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

// Peer ids are `${id_prefix}-${alnum}` (see generatePeerId), and id_prefix is copied verbatim
// from config — which permits a dot (e.g. a machine-derived `node.a`). So dots must be allowed,
// but a path separator or a `..` segment must not: either could let an id escape the doorbell
// directory. This allows the filename-safe set (alnum plus dot, underscore, hyphen) and then
// rejects any `..` substring; separators are already outside the class. Returns true for ids
// safe to turn into a `<id>.mark` filename, false for anything else.
const SAFE_ID_CHARS = /^[A-Za-z0-9._-]+$/;
function isSafeId(id: string): boolean {
  return SAFE_ID_CHARS.test(id) && !id.includes("..");
}

/**
 * The directory holding every recipient's marker, derived from the broker's db_path so the
 * broker and a watcher that loaded the same config always agree on the location without a new
 * config field. A sibling of the SQLite file: `~/.claude-peers.db` -> `~/.claude-peers.db.doorbells/`.
 */
export function doorbellDir(dbPath: string): string {
  return `${dbPath}.doorbells`;
}

/**
 * Absolute path to one recipient's marker file, or null if the id is not filename-safe (which
 * the caller treats as "no doorbell" rather than risking a path-traversal write/read).
 */
export function doorbellPath(dbPath: string, id: string): string | null {
  if (!isSafeId(id)) return null;
  return `${doorbellDir(dbPath)}/${id}.mark`;
}

/**
 * Broker side: record that recipient `id` has pending mail up to `seq` (its max pending row id).
 * Best-effort and in-place (truncate-write, never rename — a rename detaches an fs.watch from
 * the inode on macOS). Creates the doorbell dir on demand. Never throws: a failed doorbell must
 * not break the send path, and the watcher's poll fallback still catches the mail.
 *
 * A lower `seq` is dropped, and that clamp is the whole level-triggered contract rather than a
 * tidiness rule. A watcher arms at the value it last read and fires only above it, so a marker
 * that falls is invisible to every watcher already armed higher, and its mail strands until
 * unrelated traffic climbs back past that baseline. Callers cannot be relied on to check: a ring
 * fires whenever a delivery burst settles, and the max pending id at that moment is lower than
 * the last one rung whenever the burst delivered a later row than one still waiting. Enforcing it
 * here rather than at each ring site is what stops the next caller from reintroducing the fall.
 * A garbage or absent marker reads as the missing sentinel and so never blocks a write — a
 * damaged marker heals on the next ring instead of wedging the recipient forever.
 *
 * Returns whether the marker was written: false for an unsafe id, an IO failure, or a `seq` that
 * would not advance the counter.
 */
export function writeDoorbell(dbPath: string, id: string, seq: number): boolean {
  const path = doorbellPath(dbPath, id);
  if (path === null) return false;
  try {
    mkdirSync(doorbellDir(dbPath), { recursive: true });
    if (readDoorbell(dbPath, id) >= seq) return false;
    writeFileSync(path, String(seq));
    return true;
  } catch {
    return false;
  }
}

/**
 * Watcher side: read a recipient's marker counter, or `missing` (default -1) when the marker
 * does not exist yet or is unreadable/garbage. The watcher compares this against the baseline
 * it armed with; a higher value means new mail.
 */
export function readDoorbell(dbPath: string, id: string, missing = -1): number {
  const path = doorbellPath(dbPath, id);
  if (path === null) return missing;
  try {
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : missing;
  } catch {
    return missing;
  }
}

/**
 * Drop a recipient's marker when its peer is removed (graceful exit, same-pid re-register, or
 * the dead-pid sweep), so stale markers do not accumulate. Best-effort; a missing file is fine.
 */
export function removeDoorbell(dbPath: string, id: string): void {
  const path = doorbellPath(dbPath, id);
  if (path === null) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone, or never created — nothing to clean up
  }
}
