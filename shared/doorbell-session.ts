import { resolve } from "node:path";
import { readDoorbell } from "./notify.ts";

export const DOORBELL_STARTUP = `At session startup, before ordinary work, call peek_messages. If this host supports session-owned background commands whose completion schedules a new turn, start the returned doorbell argv through that facility (Claude Code: Bash run_in_background=true), retain its task handle, then call check_messages. Do this even when mail is already queued and even in tmux. Keep at most one live task for this peer; reuse its handle on repeated startup/resume. On a mail completion, call peek_messages again, re-arm with its fresh argv, then check_messages. On peer ID change, cancel the old task and bind to the new ID. Cancel the task when the session ends. Never detach it into an unrelated shell. If background completion cannot wake this session, report doorbell unsupported and use check_messages at task boundaries; registration or a launch recipe does not mean armed or consumed.`;

/** No capability tokens or config contents leave the MCP process. The marker snapshot
 * precedes launch AND the subsequent drain, including when a host starts the child late. */
export function doorbellRecipe(cliPath: string, dbPath: string, peerId: string, ownerPid: number, cwd: string) {
  // The zero-config environment override may still be relative. The host task's
  // cwd is independent of the MCP process, so bind both the snapshot and argv here.
  dbPath = resolve(cwd, dbPath);
  const since = readDoorbell(dbPath, peerId, 0);
  return {
    peer_id: peerId,
    state: "requires_host_launch" as const,
    argv: [process.execPath, cliPath, "doorbell", peerId, "--since", String(since),
      "--db-path", dbPath, "--owner-pid", String(ownerPid), "--exclusive"],
  };
}
