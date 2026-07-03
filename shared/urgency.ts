// A pre-urgency broker (protocol < URGENCY_MIN_PROTOCOL) ignores the urgency field
// and keeps the old push-on-send behavior. During a rolling upgrade the CLI can
// still be pointed at such a broker, so `send --urgency normal|fyi` would quietly
// land as an interrupt. This turns that silent degradation into a visible warning
// (#30). The CLI still delivers: failing closed would block delivery for the minutes
// of the upgrade window, which is worse than the degradation it guards against.
import { URGENCY_MIN_PROTOCOL, type Urgency } from "./types.ts";

/**
 * The warning to print before a CLI send whose urgency the target broker will
 * ignore, or null when there is nothing to warn about: an `interrupt` send
 * (identical on every protocol), a broker new enough to honor the tiers, or an
 * unreachable broker (brokerProtocol null, from a failed /health probe, which must
 * not nag or block: the send itself surfaces that failure). A reachable broker that
 * reported no version is the caller's job to resolve to 1 (the pre-versioning era)
 * before calling here, so a versionless-but-reachable broker still warns.
 */
export function urgencyDegradesWarning(
  urgency: Urgency,
  brokerProtocol: number | null,
): string | null {
  if (urgency === "interrupt") return null;
  if (brokerProtocol === null || brokerProtocol >= URGENCY_MIN_PROTOCOL) return null;
  return (
    `warning: the running broker speaks protocol ${brokerProtocol}, which predates ` +
    `urgency tiers (protocol ${URGENCY_MIN_PROTOCOL}); this ${urgency} message will be ` +
    `delivered push-on-send like an interrupt. Upgrade the broker to honor urgency.`
  );
}
