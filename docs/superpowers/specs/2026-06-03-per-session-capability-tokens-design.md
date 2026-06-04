# Per-session capability tokens — design

**Goal:** Bind every mutating control-plane call to the session that registered it, so a
local process can only act as the peer id it holds the token for. Closes the forged-`from_id`
→ pane-injection vector (codex Round 13 P1 / issue #13).

**Status:** approved 2026-06-03 (CLI auth path, multi-user scope, and push plan ratified via
interactive decision). Implements on branch `feat/reliable-peer-delivery`.

## Threat model — what this closes, precisely

The broker now types `/send-message` text into the recipient's tmux pane. The loopback control
plane trusts the `from_id`/`id` in each request body. So a local process can:

1. **Forge `from_id`** — send a message attributed to another peer. *(closed by this design)*
2. **(multi-user only) register its own peer and inject** — a foreign uid can reach loopback
   (the gate checks IP, not uid), register a peer, and message a victim, injecting into the
   victim's pane. *(NOT closed by tokens — needs uid-gating the transport; tracked as a separate
   issue)*

Tokens close (1) completely. On a **single-user host** (officejawn) that is the whole surface.
On a **multi-user host** the residual (2) remains and is filed as a follow-up — uid-gating the
control plane (per-uid Unix socket) is a transport change that touches the live broker and is out
of scope here.

What a token is: ephemeral proof-of-registration, alive only for the session's process lifetime.
A peer id is public (it shows up in `list_peers`); only the holder of that id's token may speak
as it. Tokens are never secrets at rest and never cross a machine boundary.

## Mechanism

### Mint (broker)
- New nullable `peers.token TEXT` column. `ALTER TABLE peers ADD COLUMN token TEXT` migration,
  the same upgrade pattern as the `delivery_kind` column (broker.ts:164-168).
- `handleRegister` generates a 256-bit token (`generateAuthToken()` in delivery.ts, hex,
  `crypto.getRandomValues`), stores it on the peer row, returns `{ id, token }`.

### Carry (server + CLI)
- `server.ts` captures `myAuthToken = reg.token` at registration; `brokerFetch` attaches
  `Authorization: Bearer <token>` whenever `myAuthToken` is set. Pre-register calls (`/register`,
  `/health`) carry none — `/register` needs none.
- `cli.ts send` is the only CLI surface that hits the control plane (`kill-broker` kills by PID
  via `lsof`+`SIGTERM`; `status`/`peers` use `/health` + read-only `/list-peers`). It registers a
  **throwaway peer** (no `tmux_pane` → `delivery_kind=none`, never a tmux target), captures its
  token, sends with that id + token, then **unregisters in a `finally`**. Dead-pid filtering
  auto-hides any crash-leaked ghost; the prune reaps it.

### Validate (broker — single point at the gate)
One block after the loopback check and body parse, before the `switch` (broker.ts:~672):

```
const principal = path === "/send-message" ? body.from_id : body.id;
const presented = bearerToken(req.headers);            // Authorization: Bearer <t>
const row = principal ? tokenForPeer.get(principal) : null;
const valid = presented !== null && row?.token != null && row.token === presented;
if (!valid) {
  const unsigned = presented === null;
  if (!(ALLOW_UNSIGNED && unsigned)) return 401;       // grace accepts only *unsigned*
}
```

- **Exempt routes:** `/register` (mints), `/retire` (broker-lifecycle — the caller is a *new*
  server retiring a stale broker and never registered with it, so it structurally holds no token),
  `/list-peers` (read-only browsing), `/gossip` + `/forward-message` (federation, already IP-gated,
  token-free by construction — like `tmux_pane`, the token never crosses a machine boundary).
- **`from_id` binding:** for `/send-message` the principal is `from_id`, so presenting peer A's
  token with `from_id=B` looks up B's token, mismatches, and 401s. Forgery is blocked at the gate
  by construction — no per-handler check needed.
- **Wrong token always 401s** (active forgery), even under grace; grace accepts only a *missing*
  token (a legacy unsigned client).

## Decisions (defaulted)

- **Storage:** `peers.token` column, not a separate `tokens` table — YAGNI; the token lives and
  dies with the peer row.
- **Transport:** `Authorization` header, not a body field — keeps every `shared/types.ts` request
  interface untouched and keeps gossip/forward payloads token-free.
- **Version:** `PROTOCOL_VERSION` → **3** to flag the capability. `RegisterResponse` gains `token`.

## Live-broker rollout safety

The live broker (PID 1557) runs `bun broker.ts` from the working tree and serves Pattern + Syl.
A v3 broker restarted while their servers are still tokenless would 401 their heartbeats.

- **Default = enforce** (fresh installs get the property immediately; fresh v3 servers always hold
  tokens).
- **Escape hatch:** `CLAUDE_PEERS_ALLOW_UNSIGNED=1` makes the broker accept *unsigned* (missing
  token) requests during the upgrade window. Operator runbook: set it before the v3 broker
  restart → restart the servers (they re-register and get tokens) → clear it. A wrong token still
  401s under the hatch.
- The actual live restart (pin the live service to a clean checkout, coordinated restart) stays a
  Joe action, as flagged in memory.

## Test blast radius

- Extend the test `brokerFetch(port, path, body, token?)` helper to set `Authorization` when a
  token is passed; add `registerAndGetToken(port, overrides)`.
- 12 `/send-message`/`/unregister` sites use hardcoded sender ids → register the sender, pass its
  token. 2 sites already use real registered peers. Federation-route tests (`/forward-message`,
  `/gossip`) are exempt and unchanged.
- New coverage: register returns a token; tokenless send → 401; wrong token → 401; valid token but
  `from_id` ≠ token's peer → 401 (forgery blocked); valid token + matching `from_id` → ok;
  `ALLOW_UNSIGNED=1` → unsigned accepted; `/retire` + `/list-peers` need no token.

## Out of scope (tracked separately)

- Uid-gating the control plane / per-uid Unix-socket transport — closes multi-user vector (2).
- Federation per-message auth (issue #4) — cross-machine forwards stay IP-gated; tokens never
  leave the host.
