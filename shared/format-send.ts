/**
 * The one-line sender-facing result of send_message. The broker reports what the
 * caller needs kept distinct: whether the message was pushed into the recipient's
 * live session (delivery), whether it crossed a machine boundary (routed), and,
 * for a cross-machine send, whether the remote host left it poll-only (poll_only).
 * Collapsing everything that was not "accepted" into a bare "queued" hides the
 * case the sender most needs: a remote peer this broker cannot push into, because
 * a broker can only type into a pane on its own host. That message is not lost,
 * but where it goes next depends on the remote host's config: with the default
 * floor_remote_forwards it is poll-only (waits for that session's check_messages);
 * with remote auto-push enabled it is still push-eligible (the remote heartbeat
 * pushes it once due). Only the remote broker knows which, so it reports poll_only
 * and this renders the accurate wording for each. A same-host "queued" is a third
 * case: push-due soon or polled locally. This is issue #39: accurate feedback so a
 * sender never reads a remote poll-only queue as an imminent local push.
 */

import type { SendResult } from "./types.ts";

export function describeSendOutcome(toId: string, result: SendResult): string {
  // "accepted" means the message landed in the recipient's live session, local or
  // remote (a cross-machine forward the remote broker pushed into its own pane
  // still reports "accepted"). Check it first so a genuine remote push reads as
  // pushed, not as one of the queued cases below.
  if (result.delivery === "accepted") return `Sent to ${toId} (pushed)`;
  if (result.routed === "remote") {
    if (result.poll_only === true) {
      return (
        `Sent to ${toId} (queued: remote peer, poll-only on its host, so it ` +
        `waits for that session's next check_messages rather than pushing now)`
      );
    }
    if (result.poll_only === false) {
      // The remote host reported the row push-eligible (auto-push on, a live pane),
      // so its heartbeat pushes it once due. State that plainly: the system knows it
      // here, so it should not hedge the case it is sure of.
      return (
        `Sent to ${toId} (queued on the remote host; its heartbeat pushes it once ` +
        `due, so it will land there without waiting for check_messages)`
      );
    }
    // poll_only absent: an older remote broker that does not report it. We cannot
    // tell poll-only from push-eligible, so word it true either way rather than
    // asserting a disposition we cannot confirm.
    return (
      `Sent to ${toId} (queued on the remote host, not pushed to you now; that ` +
      `session gets it on its next check_messages, or its heartbeat pushes it if ` +
      `that host auto-pushes remote mail)`
    );
  }
  return `Sent to ${toId} (queued)`;
}
