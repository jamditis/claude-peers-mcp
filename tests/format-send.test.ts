import { describe, expect, it } from "bun:test";
import { describeSendOutcome } from "../shared/format-send.ts";
import type { SendResult } from "../shared/types.ts";

describe("describeSendOutcome", () => {
  it("reports a local pushed message as pushed", () => {
    const result: SendResult = { ok: true, routed: "local", delivery: "accepted" };
    expect(describeSendOutcome("alp-abc", result)).toBe("Sent to alp-abc (pushed)");
  });

  it("reports a remote push (forward that landed in the remote pane) as pushed, not queued", () => {
    // Remote auto-push on: the remote broker pushed the forward into its own live
    // pane, so delivery is "accepted" even though it crossed a machine boundary.
    const result: SendResult = { ok: true, routed: "remote", delivery: "accepted", poll_only: false };
    expect(describeSendOutcome("bet-xyz", result)).toBe("Sent to bet-xyz (pushed)");
  });

  it("spells out that a poll-only remote queue waits for the remote check_messages (issue #39)", () => {
    const result: SendResult = { ok: true, routed: "remote", delivery: "queued", poll_only: true };
    const text = describeSendOutcome("bet-xyz", result);
    expect(text).toContain("poll-only");
    expect(text).toContain("check_messages");
    // The point of #39: a remote queue must NOT read like an imminent local push.
    expect(text).not.toBe("Sent to bet-xyz (queued)");
  });

  it("states plainly that a push-eligible remote queue will be heartbeat-pushed", () => {
    // floor_remote_forwards off and a live remote pane: the row is queued now but the
    // remote heartbeat will push it once due, and the system knows it, so the wording
    // must say so definitely rather than hedge.
    const result: SendResult = { ok: true, routed: "remote", delivery: "queued", poll_only: false };
    const text = describeSendOutcome("bet-xyz", result);
    expect(text).toContain("heartbeat pushes it once due");
    expect(text).not.toContain("poll-only");
  });

  it("treats an absent poll_only on a remote queue as unknown, not poll-only", () => {
    // An older remote broker omits poll_only. The reader must not assert either
    // disposition it cannot confirm; the unknown wording covers both truthfully.
    const result: SendResult = { ok: true, routed: "remote", delivery: "queued" };
    const text = describeSendOutcome("bet-xyz", result);
    expect(text).toContain("queued on the remote host");
    expect(text).not.toContain("poll-only");
    expect(text).not.toBe("Sent to bet-xyz (queued)");
  });

  it("renders push-eligible and unknown remote queues differently (each says what it knows)", () => {
    const pushEligible = describeSendOutcome("bet-xyz", { ok: true, routed: "remote", delivery: "queued", poll_only: false });
    const unknown = describeSendOutcome("bet-xyz", { ok: true, routed: "remote", delivery: "queued" });
    expect(pushEligible).not.toBe(unknown);
  });

  it("keeps a same-host queued message as the plain local queue", () => {
    const result: SendResult = { ok: true, routed: "local", delivery: "queued" };
    expect(describeSendOutcome("alp-abc", result)).toBe("Sent to alp-abc (queued)");
  });

  it("treats an unspecified route with a queued delivery as a plain local queue", () => {
    const result: SendResult = { ok: true, delivery: "queued" };
    expect(describeSendOutcome("alp-abc", result)).toBe("Sent to alp-abc (queued)");
  });
});
