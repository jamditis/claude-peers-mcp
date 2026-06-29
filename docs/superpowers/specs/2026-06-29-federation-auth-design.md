# Authenticate cross-machine federation traffic — design

**Goal:** Bind every cross-machine `/gossip` and `/forward-message` call to a sender that proves
it holds the fleet's shared federation secret, so an allowlisted-but-untrusted or IP-spoofing host
can no longer forge a gossip entry or inject a peer-attributed message. Closes issue #4.

**Status:** proposed 2026-06-29. Not yet implemented — this is the decision and the sequenced plan,
not the code.

## Current state (verified from code)

Two routes cross a machine boundary, both named by `isFederationRoute` (delivery.ts:533):
`/gossip` and `/forward-message`. Their only gate is the IP allowlist:

- `broker.ts:818` rejects any client IP not in `config.allowed_ips` with 403.
- `broker.ts:844` additionally requires loopback for every *non-*federation route, so a remote
  sibling can reach only these two.
- `broker.ts:863` marks both federation routes `tokenExempt`, so the per-session capability token
  (the gate that binds a local `/send-message` to its registered `from_id`) is explicitly skipped
  for them. The inline comment states the reason: the token never crosses a machine boundary.

So a federation call is authorized by source IP alone. That is a network-location check, not sender
authentication: any process on an allowlisted host — or any host that can put an allowlisted source
IP onto the broker's port — can POST a forged `/forward-message` (inject a peer-attributed line into
a recipient's tmux pane) or a forged `/gossip` (write attacker-chosen peer rows into a sibling's
table). The sender side carries no credential today: both outbound calls send only `Content-Type`
(broker.ts:610 for `/forward-message`, broker.ts:745 for `/gossip`).

`floor_remote_forwards` defaults `true` (shared/config.ts) precisely because this auth is missing: a
floored forward is poll-only (`pushAfter = null`, broker.ts:650), never auto-pasted into a live pane.
Flipping it back to push-by-default is unsafe until federation traffic is authenticated — this issue
is that prerequisite (issue #4 comment thread, 2026-06-03).

## Decision: shared secret (keyed HMAC) for v1, not mTLS

The issue offers two options. v1 is the shared secret.

- **Confidentiality already exists.** Brokers talk over the Tailscale tunnel (WireGuard), which
  encrypts the link. The missing property is sender authentication, not transport encryption. mTLS
  would re-encrypt an already-encrypted channel.
- **mTLS's operational cost is real and recurring** — a small CA or trust bundle, a client cert per
  broker, cert distribution and rotation, and TLS termination inside `Bun.serve` (today plain HTTP).
  That is the right tool when you need per-node identity and revocation; the fleet does not yet.
- **A shared secret is the smaller, sufficient step the issue names.** It raises the bar from "any
  process on an allowlisted host, or any IP-spoofer" to "any party that holds the fleet secret,"
  and the secret lives in pass and a uid-readable config, the same trust class as every other fleet
  credential.

Use a **keyed HMAC over the request body**, not a bare static bearer. Be honest about what this
buys: the channel is already encrypted (WireGuard), so the HMAC is not protecting against a wire
interceptor, and against the party who matters most — a process already inside an allowlisted host,
which can read the uid-readable secret and sign a fresh forgery — HMAC and bare bearer are
equivalent. The HMAC's marginal value over a bare bearer is narrower and worth stating plainly:
it binds the credential to one body and timestamp, so a secret that leaks through a log line, an
error response, or a crash dump is not a forever-reusable skeleton key, and a captured request
cannot be replayed past the skew window or have its body substituted. That is leak-containment and
defense in depth, not wire protection. It costs a few lines more (`node:crypto` `createHmac`,
available under Bun): HMAC-SHA256 of the serialized body plus a unix-second timestamp, the timestamp
echoed in a header and checked inside a bounded skew window. A bare bearer is the documented minimal
fallback if HMAC canonicalization proves fiddly.

## Mechanism

### Config (shared/config.ts)
- Add `federation_secret?: string` to `PeersConfig`, loaded from an env indirection
  (`CLAUDE_PEERS_FEDERATION_SECRET`) populated from pass at broker launch, preferred over an inline
  config value so the secret is neither committed nor world-readable.
- Parsing is opt-in and backward compatible: when `federation_secret` is unset, federation
  verification is disabled and the broker keeps today's IP-only behavior. This is the rollout safety
  valve — an un-upgraded or un-keyed node keeps working. Mirror the secure-by-default boolean parse
  already used for `floor_remote_forwards` (`obj.x !== false`) in spirit, but default-off here:
  absent secret means "not yet keyed," not "verification disabled on purpose forever."

### Broker launch (server.ts) — where the auto-spawned broker gets the secret
The default workflow never hand-starts the broker: `server.ts:113` auto-spawns `bun broker.ts` for
each Claude session, passing `env: { ...process.env, ... }` (server.ts:118). So the broker already
inherits the MCP server's environment — the secret reaches it for free *if and only if*
`CLAUDE_PEERS_FEDERATION_SECRET` is present in the MCP server's own launch environment (the Claude
Code MCP config's `env` block, or the parent shell that launches the session), not just in a
hand-started broker's shell. State this in the rollout step: keying a node means putting the secret
in the session/MCP launch env, from pass, so every auto-spawned broker picks it up. A node whose MCP
env lacks the secret launches unkeyed and silently falls back to IP-only federation — which is why
the grace flag (`ALLOW_UNSIGNED_FEDERATION`) must stay on until every node's MCP env carries the
secret, and why the config parse should `console.error` once at startup when federation has siblings
but no secret is set, so an un-keyed node is visible rather than silent.

### Sign (sender — broker.ts:610 and :745)
Add `signFederation(bodyString, secret)` returning `{ ts, sig }`. Attach two headers to both
outbound `fetch` calls: `X-Fleet-Ts: <unix seconds>` and
`X-Fleet-Sig: <hex HMAC of (ts + "." + bodyString)>`. Sign the exact serialized string passed as
`body`, so verify recomputes over identical bytes.

### Verify (broker — one block at the gate)
Mirror the per-session token block's placement (broker.ts:863). Add a federation branch that runs
only when `isFederationRoute(path)` and `config.federation_secret` is set:
- Recompute `HMAC(secret, ts + "." + rawBody)`; compare to `X-Fleet-Sig` with
  `crypto.timingSafeEqual` (constant-time, so a wrong sig leaks no timing).
- Reject (401) when the signature is absent, malformed, or unequal, or when `|now - ts|` exceeds the
  skew window (300 s is ample for tunnel latency and clock drift).
- Verification needs the raw body bytes, but the gate currently does `await req.json()`. Read
  `await req.text()` once, HMAC over it, then `JSON.parse` it, so the signed bytes and the parsed
  body are identical. This is the one structural change to the request path.

The secret is config, not a peer-row column, so `stripToken` / `toGossipPeer` are unaffected; the
verify block must never echo the secret or a computed sig back in a response.

### Migration (rolling upgrade)
Reuse the `ALLOW_UNSIGNED` pattern the per-session tokens shipped with. Add
`ALLOW_UNSIGNED_FEDERATION` (env): while true, a federation request that presents no signature is
accepted and logged, so a sibling still on the old binary keeps federating during the window; a
*wrong* signature always 401s. Flip it off once every node is keyed and re-deployed.

### What it unlocks
Once federation traffic is authenticated, `floor_remote_forwards = false` becomes safe to ship as the
default again, because a remote push now proves fleet-secret possession before it can auto-paste into
a pane. The issue thread already names this as the gate for flipping that default. Treat the flip as a
separate follow-up after the auth lands and bakes, not part of this change.

## Relationship to #15

Issue #15 (federation routes reachable from loopback bypass the per-session token gate) is the local
face of the same exemption this design addresses cross-machine. A loopback caller can hit
`/forward-message` directly and skip the token gate. The fleet HMAC here does not close #15 by
itself — a local process that can read `federation_secret` could sign too. #15's fix is uid- or
transport-gating the federation routes locally; this design is the cross-machine authentication. They
compose: HMAC authenticates the remote sender, a local transport gate authenticates the local one.
Keep them as separate issues.

## Residual risk (named, not hidden)

- A static fleet secret is held by every node, so one compromised node's secret reauthorizes the whole
  fleet until rotation. mTLS would scope a compromise to one revocable cert. Accept for v1; revisit
  mTLS if per-node revocation becomes necessary.
- HMAC binds body and timestamp but not method or path. For v1's two routes the body shapes are
  disjoint, so a header replayed across routes fails JSON validation anyway; fold the path into the
  signed string if a third federation route ever reuses the header.
- In-window replay is not closed. Within the skew window the same signed `/forward-message` replays
  into `handleForwardMessage` (broker.ts:631) and inserts a second message row, so the recipient's
  pane gets a duplicate peer-attributed paste. (`/gossip` replay is an idempotent re-merge, harmless.)
  Accept it for v1 — the replayer must already be inside the tunnel or on an allowlisted host, where
  it holds the secret and could forge directly anyway — or add a seen-signature nonce cache as the v2
  hook. The skew window only bounds replay relative to a bare bearer's open-ended window; it does not
  eliminate it.
- The same-uid local-process residual is #15's scope, not this one's.

## Child-issue checklist

- [ ] config: add `federation_secret` (env-indirected) and opt-in parse, with a test that an unset
  secret preserves IP-only behavior, plus a one-line startup `console.error` when siblings are
  configured but no secret is set (so an un-keyed federated node is visible, not silent). (small)
- [ ] sign + verify: `signFederation` plus the verify block, `req.text()` → HMAC → `JSON.parse` on
  the request path, constant-time compare, skew window. (medium, security-touching — Codex 5.5 high
  gate per the repo PR workflow)
- [ ] migration: `ALLOW_UNSIGNED_FEDERATION` grace flag mirroring `ALLOW_UNSIGNED`. (small)
- [ ] tests: forged-sig 401, replay-outside-skew 401, valid-sig 200, unset-secret bypass,
  grace-window unsigned accept. (medium)
- [ ] rollout: put the secret in each node's MCP server launch env (from pass) so every auto-spawned
  broker inherits it, redeploy, then flip the grace flag off. (ops)
- [ ] follow-up: flip `floor_remote_forwards` default to false once auth is baked. (separate issue)
