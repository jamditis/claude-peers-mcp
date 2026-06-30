# Authenticate cross-machine federation traffic — design

**Goal:** Bind every cross-machine `/gossip` and `/forward-message` call to a sender that proves
it holds the fleet's shared federation secret, so an allowlisted-but-untrusted or IP-spoofing host
can no longer forge a gossip entry or inject a peer-attributed message. Designs the fix for issue #4;
#4 stays open until the implementation child-issues below land.

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
equivalent. The HMAC's marginal value over a bare bearer is narrower and worth stating plainly, and
it turns on *what* leaks. If a **signed request or its `X-Fleet-Sig` header** leaks — through a log
line, an error response, a crash dump — the skew window bounds how long it can be replayed and the
body cannot be substituted; that is the containment the HMAC buys over a bare bearer, whose captured
header reauthorizes any body forever. If the **secret itself** leaks, the HMAC contains nothing: the
holder computes valid signatures for arbitrary future bodies until the fleet rotates, so a secret
exposure is a full compromise that must trigger rotation, not be read as bounded. So the HMAC's value
is leak-containment for *captured traffic* and defense in depth — not wire protection, and not
protection against secret disclosure. It costs a few lines more (`node:crypto` `createHmac`, available
under Bun): HMAC-SHA256 of the signed string (method, path, timestamp, and serialized body — see Sign
below) with the timestamp echoed in a header and checked inside a bounded skew window. A bare bearer
is the documented minimal fallback if HMAC canonicalization proves fiddly.

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
the grace flag (`CLAUDE_PEERS_ALLOW_UNSIGNED_FEDERATION`) must stay on until every node's MCP env carries the
secret, and why the config parse should `console.error` once at startup when federation is remotely
exposed (a non-loopback `allowed_ips` entry) but no secret is set, so an un-keyed node is visible
rather than silent.

One case the MCP-env route misses: a long-lived **supervised** broker — a systemd unit or Task
Scheduler task started before, and outliving, any single MCP server — is never spawned by `server.ts`.
`ensureBroker` returns early when a healthy broker already answers (server.ts:84-89), so it never
inherits a later MCP server's environment. On those nodes the secret must live in the **broker
service's own environment** (the unit's `Environment=` / `EnvironmentFile=`, or the task's env), not
only the MCP launch env, or the supervised broker keeps running unkeyed while keyed siblings reject
it once grace is off. The rollout step sets the secret in both places.

A third case is an already-running **auto-spawned** broker from a prior session. `ensureBroker` returns
early when a healthy broker already answers (server.ts:84-89), so a broker launched before the secret
was added to the MCP env keeps the environment it started with and won't pick the secret up — adding it
to the MCP config only keys brokers spawned *after* the change. Keying a node therefore includes
restarting any broker already running on it (kill it and let the next session re-spawn it, or restart
the supervised unit), not just editing the env.

### Sign (sender — broker.ts:610 and :745)
Add `signFederation(method, path, bodyString, secret)` returning `{ ts, sig }`. Attach two headers to
both outbound `fetch` calls: `X-Fleet-Ts: <unix seconds>` and
`X-Fleet-Sig: <hex HMAC of (method + "." + path + "." + ts + "." + bodyString)>`. **Bind method and
path into the signed string from v1**, not a deferred future route: `/gossip` does no schema
validation (`mergeGossipPeers(db, body.peers, ...)`, broker.ts:679), so a signed `/forward-message`
body replayed to `/gossip` is not cleanly rejected — binding the path is what actually stops
cross-route replay (see residual risk). Sign the exact serialized body string passed as `body`, so
verify recomputes over identical bytes.

### Verify (broker — one block at the gate)
Mirror the per-session token block's placement (broker.ts:863). Add a federation branch that runs
only when `isFederationRoute(path)` and `config.federation_secret` is set:
- Recompute `HMAC(secret, req.method + "." + path + "." + ts + "." + rawBody)`; compare to
  `X-Fleet-Sig` with `crypto.timingSafeEqual` (constant-time, so a wrong sig leaks no timing).
- Reject (401) when the signature is absent, malformed, or unequal, or when `|now - ts|` exceeds the
  skew window (300 s is ample for tunnel latency and clock drift).
- Verification needs the raw body bytes, but the gate currently does `await req.json()`. Read
  `await req.text()` once, HMAC over it, then `JSON.parse` it, so the signed bytes and the parsed
  body are identical. This is the one structural change to the request path.

The secret is config, not a peer-row column, so `stripToken` / `toGossipPeer` are unaffected; the
verify block must never echo the secret or a computed sig back in a response.

### Migration (rolling upgrade)
Reuse the `CLAUDE_PEERS_ALLOW_UNSIGNED` pattern the per-session tokens shipped with (broker.ts:365), with one
deliberate change: the default. Add `CLAUDE_PEERS_ALLOW_UNSIGNED_FEDERATION` (env): while true, a federation
request that presents no signature is accepted and logged, so a sibling still on the old binary keeps
federating during the window; a *wrong* signature always 401s. Flip it off once every node is keyed and
re-deployed.

The flag defaults **off**, matching the per-session `ALLOW_UNSIGNED` (which parses `=== "1"`, broker.ts:365):
the steady state is enforcement, so a keyed node rejects unsigned federation by default instead of carrying
the #4 spoofing hole open until an operator remembers to harden it. Defaulting on would make the security fix
opt-in (a node with a secret but no explicit flip-off would accept unsigned `/gossip` and `/forward-message`
forever), so the rollout window is an explicit migration setting, not the default. Opening it is the *first*
rollout step: set `CLAUDE_PEERS_ALLOW_UNSIGNED_FEDERATION=1` across the fleet before deploying the verifying
binary to any remotely exposed node, so an exposed node that upgrades before it is keyed accepts unsigned
IP-only traffic during the window instead of tripping the fail-closed last row. Clearing the flag is the
*last* step, once every node is keyed. Both failure modes point safe: forget to open the window and the first
exposed un-keyed node fails closed (a loud federation outage, never a silent bypass), and the window is only
ever permissive because an operator deliberately set it, with the startup `console.error` for an
exposed-but-unkeyed node keeping that state visible. The rest of the `ALLOW_UNSIGNED` pattern carries over: an
env flag, present-but-wrong always 401s, grace forgives only a missing signature.

A keyed sender reaching an un-keyed receiver mid-rollout is not an error. The verify branch is gated on
`federation_secret` being set (Verify, above), so a node with no secret never recomputes or compares a
signature and never inspects `X-Fleet-Sig`: a keyed sibling's signed `/gossip` or `/forward-message` lands
there as an ordinary IP-only request and is accepted exactly like an unsigned one. The asymmetry a rolling
upgrade might fear (keyed senders rejected until every receiver is keyed) never arises, because a present
signature is only ever rejected by a node that holds a secret to check it against, and that node accepts a
valid one.

### Fail closed when keyed-and-grace-off but no secret
The opt-in `absent secret → IP-only` fallback is safe *only during the grace window*. Conditioning
verification on `config.federation_secret` being set means a node that accidentally starts with no
secret keeps accepting unsigned IP-only `/gossip` and `/forward-message` even after
`CLAUDE_PEERS_ALLOW_UNSIGNED_FEDERATION` is off — a missed-secret deploy would sit permanently unauthenticated with
no enforcement point. So make absent-secret fatal in that one state.

Key the guard on **federation exposure, not on the outbound `siblings` list.** What makes a node
*accept* a remote federation request is the inbound IP gate (`isAllowedIp(clientIp, config.allowed_ips)`,
broker.ts:818), not whether this node lists any siblings to gossip *to*. A node with `siblings: []` but
a non-loopback `allowed_ips` entry still answers `/gossip` and `/forward-message` from another host, so
"federation is remotely exposed" means `allowed_ips` carries any non-loopback address (the
`singleHostDefault` allowlist is loopback-only, which is the not-exposed case). The truth table the
parse and the gate enforce together:

| federation exposed (non-loopback `allowed_ips`) | grace flag | secret set | behavior |
|---|---|---|---|
| no | — | — | loopback-only island; secret irrelevant |
| yes | on | no | accepted IP-only and logged: with no secret the node never reaches the verify branch, so it ignores any signature a keyed sender attached (the rollout window) |
| yes | on | yes | a *present* signature must be valid (wrong → 401); an *absent* one is accepted and logged — the `ALLOW_UNSIGNED` grace, so an old unsigned sibling keeps talking during rollout |
| yes | off | yes | every federation request must carry a valid signature; absent or wrong → 401 |
| **yes** | **off** | **no** | **fail closed: refuse startup, or 401 every federation route** |

Two things the table encodes. First, grace gates only the *absent*-signature case: a present-but-wrong
signature always 401s, on or off, so the grace window never weakens a node that did sign. Second, the
last row is the missed-key catch — once the operator declares the rollout done (grace off), a remotely
exposed node with no secret is a misconfiguration, not a legacy peer, and must not silently preserve the
bypass.

### Secret rotation (previous-secret acceptance window)
The Decision and the residual-risk note both lean on rotation as the only containment once the *secret*
leaks, so rotation has to be a procedure that does not force a fleet-wide outage. A single shared secret
makes a naive rotation a hard cut: a node switched to the new secret signs requests that siblings still on
the old secret reject as a wrong signature (401), and old-secret senders fail against an already-rotated
receiver, so swapping one secret for another in place forces either a coordinated fleet stop or a federation
outage for the length of the roll.

Close that with a previous-secret acceptance window. Add `federation_secret_previous?: string` to
`PeersConfig`, env-indirected like `federation_secret`. Senders always sign with `federation_secret` (the
current one); the verify branch accepts a signature that validates under **either** `federation_secret` or,
when set, `federation_secret_previous` (recompute and `timingSafeEqual` against the current secret first,
then the previous on a miss). Acceptance becomes a two-key set while the sender side stays single-key, which
is what lets the two sides cross over without a synchronized restart.

Rotation is then three rolling passes, each node-by-node with the same broker restart that keying needs:
1. **Seed acceptance.** Set `federation_secret_previous = S_new` on every node, leaving `federation_secret =
   S_old`. Every node now accepts both secrets and every node still signs `S_old`; nothing has cut over yet.
2. **Cut over signing.** Set `federation_secret = S_new` and `federation_secret_previous = S_old` on every
   node. Each node now signs `S_new`, which every node already accepts from pass 1, and still accepts
   `S_old`, so a sibling not yet flipped keeps validating. Order within the pass does not matter.
3. **Drop the old.** Clear `federation_secret_previous` on every node. Acceptance narrows back to the single
   new secret and `S_old` is retired.

Each pass must finish on every node before the next begins: pass 2's safety rests on every node having
completed pass 1 (so `S_new` is already accepted everywhere before anyone signs it), and pass 3 on every node
having completed pass 2. Within a pass node order is free, but the passes are a strict fleet-wide sequence,
not a per-node loop through all three: rotating a single node through 1-2-3 while its siblings sit at `S_old`
leaves it signing and accepting only `S_new` against peers that sign and accept only `S_old`, the mutual
401 outage this procedure exists to avoid. No pass ever presents a signature a peer cannot validate, so
federation stays up throughout. A coordinated
stop (set the new secret everywhere, restart the fleet together, wear a brief federation pause) is the
documented minimal fallback when the fleet is small enough that the pause is cheaper than carrying a second
secret field, the same minimal-fallback stance the Decision takes toward a bare bearer.

### What it unlocks
Once federation traffic is authenticated, `floor_remote_forwards = false` becomes safe to ship as the
default again, because a remote push now proves fleet-secret possession before it can auto-paste into
a pane. The issue thread already names this as the gate for flipping that default. Gate the flip on
#15 as well, not on this auth alone: `handleForwardMessage` applies `floor_remote_forwards` to every
forward (broker.ts:650), so once the default pushes, the #15 loopback path — a local caller hitting
token-exempt `/forward-message` — becomes the remaining unauthenticated auto-paste vector. Both #4
(this) and #15 should land before the flip. Treat the flip as a separate follow-up after the auth
lands and bakes, not part of this change.

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
  fleet until rotation. The previous-secret window (Secret rotation, above) makes that rotation a no-outage
  roll rather than a fleet stop, but it is still fleet-wide: every node re-keys, where mTLS would scope a
  compromise to one revocable cert. Accept for v1; revisit mTLS if per-node revocation becomes necessary.
- Cross-route replay is closed by binding method and path into the signed string (Sign, above), not
  left to JSON validation. The earlier framing — "the body shapes are disjoint, so a cross-route
  replay fails validation" — does not hold: `/gossip` runs `mergeGossipPeers(db, body.peers, ...)`
  (broker.ts:679) with no schema check, so a signed `/forward-message` body replayed to `/gossip`
  reaches the handler (a 500 on the undefined `body.peers`), not a clean bounce. The HMAC over
  method + path is the actual rejection.
- In-window replay of the *same* route is not closed. Within the skew window the same signed
  `/forward-message` replays
  into `handleForwardMessage` (broker.ts:631) and inserts a second message row, so the recipient's
  pane gets a duplicate peer-attributed paste. A `/gossip` replay is not fully harmless either:
  `handleGossip` re-runs its prune — `DELETE FROM remote_peers WHERE machine = ? AND id NOT IN
  (payload)`, or a full delete on an empty payload (broker.ts:682-689) — so a replayed stale or empty
  gossip inside the skew window can drop peer rows that were legitimately present, until the next real
  gossip restores them. Accept it for v1 — but note the replayer need not hold the secret: a party who
  captured a signed request (via a leaked log line, error response, or crash dump — the same exposure
  the HMAC rationale names) can replay it with only network reach to an allowlisted source IP, within
  the skew window, on the same route. A seen-signature nonce cache is the v2 hook that closes it. The
  skew window only bounds replay relative to a bare bearer's open-ended window; it does not eliminate
  it.
- The same-uid local-process residual is #15's scope, not this one's.

## Child-issue checklist

- [ ] config: add `federation_secret` (env-indirected) and opt-in parse, with a test that an unset
  secret preserves IP-only behavior *during grace*, plus a startup `console.error` when federation is
  remotely exposed (non-loopback `allowed_ips`) but no secret is set. (small)
- [ ] fail-closed guard: when federation is remotely exposed and `CLAUDE_PEERS_ALLOW_UNSIGNED_FEDERATION` is off and
  no secret is set, refuse startup (or 401 every federation route) — the missed-key catch in the truth
  table above, with a test per row. (small)
- [ ] sign + verify: `signFederation(method, path, body, secret)` plus the verify block, binding
  method + path into the HMAC, `req.text()` → HMAC → `JSON.parse` on the request path, constant-time
  compare, skew window. Also update the gossip sender: `gossipToSiblings` marks an attempt successful
  the moment `fetch` resolves and never checks `res.ok` (broker.ts:745-754), so once verifiers start
  returning 401 for unsigned gossip, add a `res.ok` check there or a rejected gossip is silently
  treated as delivered. (medium, security-touching — warrants the high-effort review gate per the repo
  PR workflow)
- [ ] rollout env: set the secret in both the MCP server launch env and any supervised broker
  service/task environment (the early-return reuse path means a supervised broker won't inherit the
  MCP env). (ops)
- [ ] migration: `CLAUDE_PEERS_ALLOW_UNSIGNED_FEDERATION` grace flag mirroring `ALLOW_UNSIGNED` (default
  off, opened explicitly as the first rollout step and cleared as the last), with a test that a keyed node
  rejects unsigned federation by default and accepts it only while the flag is set. (small)
- [ ] rotation: add `federation_secret_previous` (env-indirected) and accept a signature valid under the
  current or the previous secret, with a test that a previous-secret signature validates and that clearing
  the previous secret stops accepting the old one. (small)
- [ ] tests: forged-sig 401, replay-outside-skew 401, valid-sig 200, unset-secret bypass,
  grace-window unsigned accept. (medium)
- [ ] rollout: put the secret in each node's MCP server launch env (from pass) so every auto-spawned
  broker inherits it, restart any broker already running so the re-spawn picks up the secret, redeploy,
  then flip the grace flag off. (ops)
- [ ] follow-up: flip `floor_remote_forwards` default to false once auth is baked. (separate issue)
