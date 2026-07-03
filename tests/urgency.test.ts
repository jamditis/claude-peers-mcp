import { describe, expect, it } from "bun:test";
import { urgencyDegradesWarning } from "../shared/urgency.ts";
import { URGENCY_MIN_PROTOCOL } from "../shared/types.ts";

describe("urgencyDegradesWarning (#30)", () => {
  it("warns when a non-interrupt send targets a pre-urgency broker", () => {
    const w = urgencyDegradesWarning("fyi", 3);
    expect(w).not.toBeNull();
    expect(w).toContain("protocol 3");
    expect(w).toContain("push-on-send");
    expect(w).toContain("fyi");
  });

  it("names the required protocol for a normal-urgency send too", () => {
    const w = urgencyDegradesWarning("normal", 3);
    expect(w).toContain(`protocol ${URGENCY_MIN_PROTOCOL}`);
    expect(w).toContain("normal");
  });

  it("warns for the pre-versioning broker the caller resolves to protocol 1", () => {
    // A reachable broker with no protocol_version in /health is protocol 1; the CLI
    // resolves that to 1 (not null) so the oldest broker, which ignores urgency, still
    // warns instead of silently degrading.
    expect(urgencyDegradesWarning("fyi", 1)).toContain("protocol 1");
  });

  it("stays silent for interrupt: identical on every protocol", () => {
    expect(urgencyDegradesWarning("interrupt", 3)).toBeNull();
    expect(urgencyDegradesWarning("interrupt", null)).toBeNull();
  });

  it("stays silent when the broker already honors the tiers", () => {
    expect(urgencyDegradesWarning("normal", URGENCY_MIN_PROTOCOL)).toBeNull();
    expect(urgencyDegradesWarning("fyi", 6)).toBeNull();
  });

  it("stays silent when the version is unknown, so a failed probe never nags or blocks", () => {
    expect(urgencyDegradesWarning("normal", null)).toBeNull();
    expect(urgencyDegradesWarning("fyi", null)).toBeNull();
  });
});
