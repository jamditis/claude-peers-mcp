# Reliable peer-message delivery via stdin injection

- Date: 2026-06-03
- Status: approved (design, milestone 1); milestone 2 gated (see entry gates)
- Author: Joe Amditis
- Scope (M1): `claude-peers-mcp` message delivery path — `server.ts`, `broker.ts`,
  `shared/types.ts`. M2 adds a new `launcher.ts` and is deferred behind two gates.

## Problem

Messages sent between peers do not arrive on their own. A receiving Claude only
sees them when it happens to call `check_messages`. In practice that means peer
messages sit unread until something prompts a manual check.

The history explains why. Commit `72c9d61` added a peek/ack pattern and `ca5f813`
then disabled the push poll loop by default behind `CLAUDE_PEERS_CHANNEL=1`. The
loop was disabled because it caused **silent message consumption**: the loop
pushed messages via `mcp.notification({ method: "notifications/claude/channel" })`
and then ack'd them. But an MCP notification is fire-and-forget — when the client
has not loaded the channel, the notification is dropped with no error and
`notification()` still resolves successfully. The loop read that as "delivered"
and ack'd messages the receiver never saw. Disabling the loop traded silent loss
for no delivery at all, which is the current symptom.

Nothing in the README or install ever sets `CLAUDE_PEERS_CHANNEL=1`, so the push
path is effectively always off.

## Goals

- Peer messages reach a running session on their own, with no Claude-side polling
  (`/loop`, repeated `check_messages`). Out-of-band push only.
- Delivery behaves like a normal user message: it queues and is handled at the
  next tool-use boundary, and it wakes an idle session.
- Push works for sessions reachable by a delivery backend. M1 ships the tmux
  backend (a session whose own pane was captured) plus the `check_messages` floor.
  M2 adds a launcher backend for headless/worker sessions on any OS.
- A delivery that cannot be confirmed must never be silently consumed.

## Non-goals

- Injecting into an already-running session that no launcher spawned and that is
  not in a tmux pane. Claude Code exposes no API to push into such a session's
  stdin (see research notes); those sessions fall back to `check_messages`. This
  includes a plain `claude` session with no tmux on any OS — a documented
  limitation, not a defect.
- Push to non-tmux **interactive** sessions. Decided 2026-06-03: the launcher
  backend (M2) serves headless / worker / autonomous sessions only. A human at a
  bare non-tmux terminal falls to the `check_messages` floor. Pushing into a
  human-driven non-tmux REPL would require a TTY-proxying interactive wrapper,
  which is explicitly out of scope.
- Becoming a supervisor for sessions the launcher did not spawn. The launcher owns
  stdin only for its own child; it never tries to attach to a foreign process.
- Guaranteed-once delivery. The tmux path is best-effort at-least-once and can
  re-inject after a partial failure; the launcher path (M2) is acked but still
  at-least-once across disconnect/ack-loss; `check_messages` is the floor under
  both.

## Research notes

- **Channels protocol is the wrong primary path.** `notifications/claude/channel`
  is a research preview, and pushes are silently dropped when the session is idle
  — the exact case we care about. The REPL prioritizes stdin over MCP
  notifications. Refs: Channels reference (https://code.claude.com/docs/en/channels-reference),
  whose own Notification-format section states pushes to an idle/unloaded session
  "are dropped silently with no error returned to your server"; GitHub issues
  anthropics/claude-code #61797, #44380, #38736. No changelog entry shows a fix as
  of 2.1.161 (re-confirmed 2026-06-03: changelog 2.1.80–2.1.161 has one channels
  entry, 2.1.126, unrelated to idle drop).
- **`mcp.notification()` gives no delivery signal.** Confirmed in
  `@modelcontextprotocol/sdk` 1.27.1 (pinned in `bun.lock`): `Protocol._onnotification`
  drops an unknown method with a bare `return;` (no error), and `notification()`
  resolves on transport write. This is the mechanical root of the silent-consume
  bug. `getClientCapabilities()` only reports what the client declared, not whether
  a given push landed.
- **stdin injection is the reliable path and is already proven in production.**
  `jawn-slack-brain/bridge/tmux_router.py` delivers into Pattern's session with
  `tmux send-keys -t <session> -l <text>` then `Enter`. Writing to stdin means
  Claude Code's native input queue handles "queue until the next tool boundary,"
  and stdin reliably wakes an idle session. Limitation: the production reference
  only ever sends single-line payloads and does not use bracketed paste — so the
  bracketed-paste multi-line wrap below is **new** behavior this spec introduces,
  not something production has exercised. `send-keys` exit 0 only proves tmux
  accepted the keystrokes, not that Claude was at its prompt rather than a
  shell/permission/modal state.
- **Verified locally (2026-06-03).** On a throwaway private-socket tmux session
  running claude 2.1.161: `$TMUX_PANE` is inherited through two process hops (pane
  shell → child → grandchild), so the MCP server — a stdio grandchild of the pane —
  sees the session's own pane id; a single chained `tmux send-keys -l <text> ;
  send-keys Enter` lands text in a foreground program's stdin; `$TMUX` parsed at the
  first comma yields the socket path. The claude 2.1.161 binary implements
  bracketed paste (grep finds `200~`, `bracketedPaste`, `isPaste`, `onPaste`), and a
  bracketed-paste-wrapped multi-line `send-keys` with no intervening Enter buffered
  as one input and submitted as one user message on a single trailing Enter.
- **The SDK streaming-input replay-ack is real (M2 mechanism).** Re-confirmed
  empirically against claude 2.1.161 (2026-06-03): `claude --input-format
  stream-json --output-format stream-json --verbose --replay-user-messages` echoes
  each stdin `user` message back on stdout as a `type:"user"` event carrying
  `"isReplay": true`, `uuid`, `session_id`, and the verbatim content, in submission
  order; a control run without the flag emitted zero `user` events. The official
  CLI-reference example includes `--verbose`. The input framing
  (`{"type":"user","message":{"role":"user","content":"…"}}`) is real but thinly
  documented (only a flag-table row; anthropics/claude-code #24594), so it carries
  minor version-drift risk that an M2 regression test against the replayed-event
  shape must pin. It requires owning the child's stdin, so it works for a launcher
  (parent of the Claude process), not for the MCP server (a stdio child) and not
  for an arbitrary already-running session. Refs:
  https://code.claude.com/docs/en/cli-reference,
  https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.

## Milestones

This design ships in two milestones. The split keeps every unverified mechanism
out of the part that fixes the silent-consume bug.

- **M1 (this spec, plan-ready): tmux backend + `check_messages` floor.** Includes
  the per-message lease state machine, the `delivery_state` migration, the ordered
  heartbeat drain, broker-restart crash recovery, the loopback control-plane split,
  and the corrected pid-liveness cleanup. M1 alone ends silent-consume for tmux and
  `none` sessions and depends on no unverified transport. Everything M1 needs has
  been verified (tmux mechanics, lease concurrency, migration).
- **M2 (deferred, gated): launcher backend for headless/worker sessions** (issue
  #7). Adds `launcher.ts`, the broker→launcher delivery stream, the confirm-delivery
  ack, and the launcher's use of the lease token for stale-replay rejection. **Entry
  gates** (both must clear before M2 writing-plans):
  1. **Transport proof** (issue #8). The broker is today pure request/response.
     Before M2 we must either prove `Bun.serve` can hold a long-lived streaming
     response per session while concurrently serving normal POSTs (with
     GET-querystring routing and a bounded per-stream cost), or pick a concrete
     alternative (long-poll GET that returns one event and is re-requested, or a
     unix-domain duplex socket). This proof is a throwaway spike, not part of M1.
  2. **Adoption model (decided).** A launcher session is headless/worker only —
     stream-json mode is a JSON protocol, not an interactive REPL. M2 must specify
     where `launcher.ts` lives, how `claude-peers launch` is exposed on PATH (no
     `bin` exists today), and that it replaces direct `claude` invocation for those
     sessions.

The M2 design sketch at the end records the verified findings it must honor so the
work is not re-derived later.

## Chosen approach

Broker-side, event-driven delivery through per-session **delivery backends**.
Delivery moves out of the per-session poll loop and into the broker. The
recipient's local broker picks the backend for the recipient and uses it; delivery
is triggered by events — a send, a forward, a heartbeat — never a clock.

M1 ships one push backend plus a floor:

1. **tmux backend** — for a session whose own `$TMUX_PANE` was captured at
   registration. The broker injects with `send-keys`. This is **best-effort
   at-least-once pane injection**: a `send-keys` exit 0 means tmux accepted the
   keystrokes into the pane, which in the normal case is Claude's input prompt and
   becomes the next queued user message. It is not a guarantee that Claude was at
   its prompt rather than a modal state, so the model is best-effort, not a true
   queue-ack.
2. **`check_messages` floor** — for a session reachable by no backend (a human at a
   bare terminal not in tmux). Manual pull, always works, acked only on read.

M2 adds the **launcher backend** for headless/worker sessions: the broker hands a
message to a launcher process that owns its child's stdin, writes a stream-json
`user` message, and reads the replayed event back as a true delivery ACK.

### Why this shape

- The broker is the only always-running, event-receiving component, and as the
  same OS user it can `send-keys` to any local pane without an MCP connection of
  its own. The MCP server's job shrinks to registration plus tools.
- **Confirmation is the only thing that acks a message** — in M1 a `send-keys`
  exit 0 (accepted-by-pane) or a `check_messages` read. A push that cannot be
  confirmed never acks. That designs out the silent-consume failure mode rather
  than patching it.

## Architecture and data flow (M1)

```
A's Claude --send_message--> A's MCP server --POST /send-message--> Broker (A's machine)
                                                                      |
                                  local recipient --------------------+
                                                                      v
                                            recipient's backend (resolved locally):
                                              tmux: tmux -S <socket> send-keys -t <pane> -l <text> ; Enter
                                              none: left queued; check_messages is the floor
                                                                      |
                                                          B's Claude queues it
                                  remote recipient --/forward-message--> Broker (B's machine)
                                              (B's broker resolves B's backend from its OWN registration data)
```

Cross-machine forwards carry only message content and routing identity. Pane and
socket details are never sent across machines — the recipient's broker resolves
the recipient's backend from its own local registration data.

### Per-message delivery state and lease

To make concurrent send-time injection, heartbeat flush, and `check_messages`
safe, every message row carries a delivery state and a single-owner lease:

- `delivery_state TEXT NOT NULL DEFAULT 'queued'` — one of `queued`, `delivering`,
  `delivered`.
- `lease_expires_at INTEGER` (epoch ms, nullable) — set when a row enters
  `delivering`.
- `lease_token TEXT` (nullable) — a fresh nonce minted on each claim; it names the
  attempt that owns the row. In M1, tmux confirmation is synchronous and in-process,
  so the token is cheap insurance; it becomes load-bearing in M2, where an
  asynchronous launcher ack from a timed-out attempt must be rejected.

Claiming a row for delivery is a single conditional update inside one transaction:

```
UPDATE messages
   SET delivery_state = 'delivering', lease_expires_at = :now + :lease_ms,
       lease_token = :token
 WHERE id = :id AND delivery_state = 'queued'
```

Only the writer whose update affected a row proceeds to deliver it, holding
`:token`. On success the row goes to `delivered`; on failure it returns to `queued`
(lease and token cleared) for the next heartbeat.

Three rules keep the lease from racing an in-flight attempt:

- **Lease outlives the attempt.** `:lease_ms` is strictly greater than the maximum
  backend attempt timeout (tmux 2s), so a slow-but-live attempt never has its row
  reclaimed mid-flight.
- **The owner guards reclaim.** The broker keeps an in-memory set of row ids it is
  actively attempting. A `delivering` row is reclaimable by the heartbeat drain
  only when its `lease_expires_at` is in the past *and* it is not in that set — so
  the process that owns an attempt is the only one that can reclaim its own row
  early.
- **The token gates the ack.** A confirmation moves a row to `delivered` only with
  `WHERE id = ? AND delivery_state = 'delivering' AND lease_token = ?`. A stale
  confirmation from a timed-out earlier attempt finds a mismatched (or cleared)
  token and no-ops, so it can never flip a re-leased row.

`check_messages` (`/poll-messages`) returns and acks only `queued` rows, so it
never races a concurrent injection of a `delivering` row.

### Heartbeat drain and ordering

Ordering basis is the row `id` (AUTOINCREMENT), **not** `sent_at`. The existing
`selectUndelivered` query ordered by `sent_at` (a TEXT timestamp), which is
non-deterministic for two rows inserted in the same millisecond; M1 replaces that
ordering with `id ASC` everywhere and `sent_at` is no longer load-bearing for
delivery order.

The heartbeat drain delivers a recipient's `queued` rows in `id` order. To keep a
younger message from overtaking an older one that is mid-flight, the drain is
strictly serial per recipient:

- A `/heartbeat` from a session drains **only that session's own inbox**, keyed on
  the `id` in the heartbeat body. This is O(1) per session and matches the existing
  `{id}`-only heartbeat body. (Who posts `/heartbeat`: in M1, every tmux and `none`
  session posts it from its MCP server's existing heartbeat timer. A `none`
  recipient's drain is a no-op — no backend — and that is intended.)
- The drain processes the recipient's rows oldest-`id` first and **stops at the
  recipient** (does not skip ahead) when it reaches that recipient's oldest
  outstanding row in a state that means an attempt is in flight: `queued` being
  claimed, or `delivering` with a still-live lease. A younger row is never
  delivered ahead of an older blocked one.
- If the blocking older `delivering` row has an expired lease *and* is not in the
  active-attempt set, the drain reclaims it (back to `queued`), delivers it first,
  then continues — it does not stall behind a dead attempt.
- A per-recipient in-flight guard (a `Set` of recipient ids currently being
  drained or delivered, mirroring the existing `gossipInFlight` boolean) defers a
  recipient's rows to the next heartbeat if a drain or send-time attempt for that
  recipient is already running. This serializes concurrent drains and a concurrent
  send+drain for the same recipient.

`handleSendMessage` / `handleForwardMessage` mirror the same predicate: after
insert, attempt immediate delivery only when the new row is the oldest deliverable
row for that recipient and no in-flight guard is set; otherwise leave it `queued`
for the ordered drain.

### Broker-restart crash recovery

On a fresh broker process the in-memory active-attempt set is empty, so by
definition no live attempt owns any `delivering` row — every such row is orphaned.
On broker start, after the migration runs, reset every `delivering` row back to
`queued` and clear its `lease_token` / `lease_expires_at`. This both eliminates the
window where a crash-orphaned message would be invisible to `check_messages` (the
floor has a hole exactly when push died mid-flight) and recovers immediately
instead of waiting out the lease. The orphaned row was never `delivered`, so the
never-ack invariant already held; this only tightens recovery latency and floor
visibility.

### Migration to delivery_state

`delivery_state` is the single source of truth. The migration is gated, ordered,
and transactional — not merely asserted idempotent, since SQLite `ALTER TABLE` has
no `IF [NOT] EXISTS` and a second start would otherwise throw:

- **Fresh DB:** the `CREATE TABLE IF NOT EXISTS messages` statement is updated to
  the target schema (`delivery_state TEXT NOT NULL DEFAULT 'queued'`,
  `lease_expires_at INTEGER`, `lease_token TEXT`, no `delivered` column). A fresh DB
  is born migrated and never enters the ALTER path.
- **Legacy DB:** detected by `PRAGMA table_info(messages)` showing a `delivered`
  column. Migration then, in a single `BEGIN IMMEDIATE` transaction: add any
  missing column (guarded on the pragma so a re-run is a no-op), backfill
  `delivery_state` from `delivered` (`1` → `delivered`, else `queued`), then drop
  `delivered`. bun:sqlite's SQLite supports `ALTER TABLE … DROP COLUMN`.
- **Ordering vs the port race:** the migration runs only on the post-bind path. Two
  sessions can each spawn a broker; the `EADDRINUSE` loser exits 0 *before* touching
  the schema, so only the bind winner migrates. `BEGIN IMMEDIATE` means a late
  starter that somehow reaches the schema either blocks on the write lock until it
  sees the finished schema or no-ops on the pragma guard — it never observes a
  half-migrated state. (SQLite serializes writers; it will not corrupt the file.)

### The never-ack invariant

In M1 a message reaches `delivered` only when one of these confirms it:

- `tmux send-keys` returns exit code 0 (accepted by pane, best-effort), or
- `check_messages` (`/poll-messages`) reads it.

Each tmux confirmation counts only for the attempt holding the row's current
`lease_token`. A delivery that cannot be confirmed never sets `delivered` — it
returns to `queued`. Acking on an unconfirmed push is exactly what made the
original silent-consume bug possible, so no code path acks without a confirmation.

## Component changes (M1)

### `server.ts`

- Remove `pollAndPushMessages`, its `setInterval`, and the `CLAUDE_PEERS_CHANNEL`
  env gate. No channel push logic remains in v1.
- At registration (a **loopback** POST to the local broker), report the session's
  own `tmux_pane` (`process.env.TMUX_PANE`, validated against `^%\d+$`) and
  `tmux_socket` (the path before the first comma of `process.env.TMUX`, validated
  as an absolute path; otherwise null), with `delivery_kind: "tmux"` when a pane is
  present, else `"none"`.
- `send_message` surfaces the broker's delivery result to the sender (`accepted`
  for a best-effort tmux push, `queued` otherwise).
- The `claude/channel` capability declaration in the `Server` constructor may stay
  (harmless; reserves the door for the deferred channel tier), but nothing pushes
  to it.

### `broker.ts`

- **Control-plane / federation-plane split.** The broker today binds one listener.
  Registration that carries pane/socket coordinates is a control-plane operation
  and must come from loopback. M1 enforces this with a per-route source check:
  reject a `/register` that carries `tmux_pane`/`tmux_socket` unless `clientIp` is
  exactly `127.0.0.1` or `::1` (independent of, and in addition to, the federation
  allowlist). The allowlist authorizes federation routes (`/forward-message`,
  `/gossip`) only and is explicitly **not** authorization to assert pane
  coordinates. (M2 adds `/deliveries` and the confirm-delivery ack to this same
  loopback control plane; the split is introduced now so M2 inherits it.) A
  pane-carrying registration from a non-loopback source is refused, or stored with
  `delivery_kind: "none"` and pane fields dropped — never a send-keys target.
- Delivery module (pure where possible, for testing):
  - `resolveTmuxTarget(env)` — parse and validate `$TMUX` / `$TMUX_PANE`.
  - `formatPeerMessage(msg, sender)` — build the injected text (see below),
    including the message id for traceability.
  - `deliverViaTmux(pane, socket, text)` — one `Bun.spawn` with **array args, no
    shell** and a 2s timeout, chaining both keystrokes in a single tmux process so
    delivery costs one spawn, not two:
    `tmux [-S socket] send-keys -t <pane> -l <wrapped-text> ';' send-keys -t <pane> Enter`.
    `proc.exited` is always awaited and the child is killed on timeout, so no
    process is left unreaped. Returns success only on exit 0.
  - `tmuxAvailable()` — probe `tmux -V` once per broker and cache the result. When
    tmux is absent (typical on Windows), the tmux backend is skipped without
    spawning, so a misconfigured peer can never trigger repeated failed spawns.
- `handleSendMessage` / `handleForwardMessage`: after insert, attempt immediate
  delivery per the ordering predicate above; claim the row via the lease, deliver
  through the recipient's backend, mark `delivered` only on confirmation, and
  return `{ ok, routed, delivery: "accepted" | "queued" }`.
- `/heartbeat`: drain the heartbeating recipient's `queued` rows to its backend,
  **one injection per stored message** (no coalescing in v1 — each stored message
  becomes one injected user message so the receiver can reply to each), in `id`
  ASC order, with the serial-per-recipient ordering and in-flight guard above.
- Registration stores `tmux_pane` / `tmux_socket` / `delivery_kind` for **local**
  peers only. Gossip and `/forward-message` do not carry pane, socket, or
  backend data; a recipient broker resolves the recipient's backend from its own DB.
- **Liveness cleanup correctness.** Distinguish "dead" from "not-signalable" in
  every `process.kill(pid, 0)` site. Treat only `ESRCH` (and the Windows
  not-found equivalent) as dead → deregister the peer. On `EPERM`/`EACCES`
  (alive-but-foreign, or a recycled foreign-UID pid) keep the peer. Crucially,
  **decouple message deletion from the liveness probe**: undelivered messages are
  removed only on an explicit `/unregister` or by the max-age prune — never as a
  side effect of a probe failure. A failed probe at most deregisters the peer row;
  its queued messages outlive a single failed probe. (This closes a silent
  message-loss path: the prior design deleted a peer's undelivered messages on any
  probe throw, which on Windows or a recycled pid is exactly the silent loss we are
  fixing.)

### `shared/types.ts`

- `Peer` and `RegisterRequest`: add `tmux_pane: string | null`,
  `tmux_socket: string | null`, `delivery_kind: "tmux" | "launcher" | "none"`
  (`"launcher"` reserved for M2). These describe a peer to its **own** broker; the
  gossip serialization omits the pane/socket/backend fields.
- Add a `SendResult` type:
  `{ ok: boolean; error?: string; routed?: "local" | "remote"; delivery?: "injected" | "accepted" | "queued" }`
  (`"injected"` reserved for the M2 launcher confirmation).
- `GossipRequest` peers and `ForwardMessageRequest` carry identity and routing
  fields only (id, machine, summary, pid, cwd) — **not** `tmux_pane`,
  `tmux_socket`, or backend data. Backend resolution is strictly local to the
  recipient broker.

## Injected message format (tmux)

A single logical line, wrapped in a bracketed-paste sequence so embedded newlines
do not submit early, followed by one `Enter`:

```
ESC[200~[peer <from_id> #<id>] <text>  (reply: send_message to_id="<from_id>")ESC[201~
```

- `<text>` is the raw message; `<id>` is the message row id, included for
  traceability and as a dedup hint on the best-effort path. Bracketed paste
  (`ESC[200~` / `ESC[201~`) makes Claude Code treat the whole block as one paste,
  so a multi-line message is not submitted line by line. A single trailing `Enter`
  submits it. (This multi-line wrap is new vs the production tmux router and is
  covered by a dedicated unit + integration test below.)
- If a session does not honor bracketed paste, the fallback is to collapse internal
  newlines to spaces before sending; peer messages are short.

## Error handling (M1)

- No backend, `send-keys` failure, or stale pane id → the row returns to `queued`
  (lease cleared), retried on the next heartbeat, with `check_messages` as the
  floor. Logged at the broker (rate-limited, consistent with the existing
  gossip-failure summary style).
- Dead recipient → the liveness sweep deregisters the peer **only on `ESRCH`**; its
  undelivered messages are removed by `/unregister` or the max-age prune, never by
  the probe (see liveness cleanup above).
- Broker shells out only through `Bun.spawn` with array args (no shell string), so
  message text cannot inject shell commands. A 2s spawn timeout prevents a hung
  tmux call from stalling a request.
- Ordering is preserved per recipient (`id` ASC, serial per recipient, leased rows
  guarded). The tmux path can re-inject a message after a partial failure
  (send-keys wrote keys but exited non-zero, or the broker crashed before
  `delivered`); this is the at-least-once cost of having no receiver-side ack on
  that path, and the message id in the payload makes a duplicate identifiable.

## Security (M1)

- Array-arg spawn: no shell interpolation of message text or pane ids.
- Validate `tmux_pane` against `^%\d+$` and `tmux_socket` as an absolute path
  before use; reject and treat as non-tmux otherwise.
- Accept pane/socket registration data only from a **loopback** registration POST,
  enforced by the per-route source check above, and only as the registering
  process's report about **itself** (its own `$TMUX` / `$TMUX_PANE`). The broker
  never accepts pane coordinates from a remote or forwarded request and never
  injects into a pane it learned from another machine.
- Same-user local peers are trusted: a same-user process can register a pane the
  broker will inject into. Under the single-user-per-machine assumption this is
  trust-on-first-use, documented as such. A real proof-of-ownership for first
  registration (a parent→child secret) lands with the launcher in M2; for the M1
  tmux path it is the documented TOFU model, and strong local/remote auth is
  tracked in issue #4.
- Cross-machine traffic keeps the existing IP allowlist. The allowlist is a
  network-location check, not authentication — any process on an allowed host can
  reach `/forward-message` and `/gossip`. This redesign raises the impact of that
  gap: a forged `/forward-message` previously sat queued until the recipient chose
  to `check_messages`, whereas event-driven delivery now auto-injects it as a
  peer-attributed user line into a live session. Any process on an allowlisted host
  can therefore push attacker-chosen, arbitrarily-attributed text in front of a
  running Claude. The shared-secret/mTLS work in issue #4 should land before or
  alongside enabling cross-machine auto-injection by default; until then,
  cross-machine forwards could be gated to the `check_messages` floor (no
  auto-inject) to keep the deferred-auth surface at its pre-redesign level.

## Resource hygiene and cross-platform safety

The fleet includes Windows broker nodes (host-d, host-c) where tmux does not
exist, so the design must spawn sparingly, reap every child, and never depend on
tmux being present. M1 push works only where tmux exists; Windows/macOS sessions
without tmux use the `check_messages` floor in M1 and get the launcher backend in
M2.

### Broker process (no duplicate brokers)

- Exactly one broker per machine. `ensureBroker` health-checks before spawning, but
  two sessions can race and each spawn a `bun broker.ts`. The broker binds the port;
  on `EADDRINUSE` it logs and exits 0 (the existing broker won the race) before
  running the migration, instead of throwing or crash-looping. Duplicate spawns are
  self-correcting.
- The detached spawn keeps `stdio: ["ignore", "ignore", "inherit"]` and
  `proc.unref()`, so no pipe buffers leak and the broker outlives the spawning
  session.
- Empty-broker self-exit, made race-safe: the broker tracks a `lastActivityAt`
  timestamp (updated on every request) and an `inFlightDeliveries` counter
  (incremented while a row is `delivering`). It exits only when, checked together,
  there are zero live local peers, zero in-flight deliveries, and `lastActivityAt`
  is older than the grace window (10 minutes). A registration or heartbeat arriving
  during the window refreshes `lastActivityAt` and cancels the pending exit. (M2
  note: an open `/deliveries` stream must count as a live peer for self-exit, or
  launcher heartbeats must be mandatory — recorded in the M2 sketch.)

### Child processes (injection)

- tmux: one tmux process per delivery (chained keystrokes), `proc.exited` always
  awaited, killed on the 2s timeout. No fire-and-forget spawns.
- One injection per stored message bounds tmux work to the number of `queued`
  messages per heartbeat; there is no coalescing path to reason about separately.
- `tmuxAvailable()` is probed once and cached. A machine without tmux (Windows)
  never attempts a tmux spawn; such sessions use `check_messages` (M1) or the
  launcher backend (M2). A missing-binary result is cached, so a peer that wrongly
  reports a pane cannot cause a spawn storm.

### Cross-platform

- A session outside tmux registers with `delivery_kind: "none"` and is delivered
  via `check_messages` in M1. A Windows broker registers, routes, and gossips
  normally.
- `process.kill(pid, 0)` liveness is used only for cleanup and inspects the error
  code (ESRCH = dead, EPERM = alive-but-foreign → kept). Windows pid-liveness under
  Bun is not yet verified; since Windows push depends on the launcher backend, that
  verification is an M2 concern. In M1, a Windows peer is reachable via the floor
  regardless of probe nuance, and message deletion never depends on the probe.
- tmux is an enhancement where it exists, never a requirement. No code path assumes
  it exists.

### Memory and storage

- A periodic prune runs inside the existing cleanup timer: delete `delivered`
  messages older than a short TTL, and drop `queued` messages older than a max age.
  The `queued`-row prune is gated on recipient liveness: only drop a `queued` row
  whose recipient peer has been deregistered (ESRCH sweep) or whose session
  unregistered — a `queued` row for a still-live but temporarily-disconnected peer
  is kept until it reconnects. Growth stays bounded because a dead recipient's
  messages are removed on unregister. If a hard wall-clock cap is later added as a
  backstop, it must log each dropped row and the spec must state it is lossy (a
  still-live peer offline longer than the cap can lose aged messages).
- `gossipFailureStates` is bounded by sibling count. Removing the message poll loop
  also removes its per-session timer.

## Testing (TDD, failing test first) — M1

The test surface today is a two-broker HTTP federation harness
(`tests/integration.test.ts` spawns real `bun broker.ts` and drives it over fetch)
plus a thin `broker.test.ts`. M1 adds an injected/fake `Bun.spawn` for
`deliverViaTmux` — that test double is a first-class task, not assumed to fall out
of the current harness.

- **Regression / invariant:** a message whose push fails (tmux non-zero exit) is
  never marked delivered (reproduces the original silent-consume bug; must stay
  green forever).
- Unit: `resolveTmuxTarget` (env parse, pane-id and socket validation),
  `formatPeerMessage` (bracketed-paste wrap, newline handling, message-id and reply
  hint), `deliverViaTmux` (single chained-keystroke spawn with array args via an
  injected spawn, delivered only on exit 0, child reaped, timeout path).
- Unit: the lease state machine — a `queued` row claimed by one writer cannot be
  claimed by a second (the conditional update affects zero rows the second time); an
  expired `delivering` lease is reclaimable only when not in the active-attempt set;
  the lease duration exceeds the max backend timeout; an ack with a stale or
  mismatched `lease_token` no-ops; reclaiming mints a fresh token; `check_messages`
  skips a `delivering` row; a failed push returns the row to `queued`.
- Unit: ordering — when an older `queued`/`delivering` row exists for a recipient, a
  newly sent message is left queued (not injected ahead of it); a heartbeat with
  row N `delivering` (in flight) and N+1 `queued` for the same recipient does NOT
  deliver N+1 until N resolves (N+1 stays `queued`); two concurrent drains for one
  recipient serialize.
- Unit: crash recovery — a `delivering` row present at broker start is reset to
  `queued` (and becomes retrievable via `check_messages`).
- Unit: migration — start a broker against a seeded old-schema DB with both
  `delivered=1` and `delivered=0` rows; assert `delivered=1` → `delivery_state='delivered'`,
  `delivered=0` → `queued`, the `delivered` column is gone, and a second start over
  the same DB is a no-op (no throw, schema unchanged); a fresh DB starts directly in
  the new schema.
- Unit: security — a `/register` carrying `tmux_pane`/`tmux_socket` from a
  non-loopback (but allowlisted) source IP is refused or stored as
  `delivery_kind:"none"` with pane fields dropped.
- Unit: liveness — a peer whose pid probe throws `EPERM` is retained and its queued
  messages survive cleanup; a peer whose probe throws `ESRCH` is deregistered;
  message deletion fires only on explicit unregister or max-age prune, never from a
  probe throw.
- Integration: extend the two-broker harness — inject to a fake tmux target and
  assert `accepted`; a `none` peer yields `queued` and stays retrievable via
  `check_messages`; a multi-line message arrives as one queued user message
  (bracketed-paste); a forwarded cross-machine message is resolved to the
  recipient's backend by the recipient broker with no pane data in the forward
  payload.
- Resource hygiene: `deliverViaTmux` awaits and reaps its child and kills it on
  timeout; `tmuxAvailable()` short-circuits with no spawn when the binary is absent;
  a second broker bind exits 0 (singleton) before migrating; the prune removes aged
  delivered and (liveness-gated) over-age queued rows; self-exit fires only with
  zero peers, zero in-flight deliveries, and an expired activity window, and a
  heartbeat during the window cancels it.

## What gets deleted (M1)

- The `setInterval` message poll loop and `pollAndPushMessages`.
- The `CLAUDE_PEERS_CHANNEL` opt-in.
- The ack-on-unconfirmed-notification path.
- `POST /peek-messages` + `handlePeekMessages` and `POST /ack-messages` (plural) +
  `handleAckMessages` — these back only the removed `pollAndPushMessages` and become
  dead code. `POST /poll-messages` and `handlePollMessages` are **kept** (they back
  the surviving `check_messages` tool).

Heartbeat stays (free HTTP liveness ping, now also the injection-retry trigger).
No Claude-side `/loop` anywhere.

## Acceptance criteria (M1)

- A message sent to a peer running in a tmux pane appears in that session as a
  queued user message without the receiver calling any tool, and is marked
  delivered on `send-keys` exit 0 (best-effort, accepted-by-pane).
- A message sent to a peer reachable by no backend is left `queued` (never marked
  delivered without confirmation) and remains retrievable via `check_messages`.
- Concurrent send-time injection, heartbeat flush, and `check_messages` never
  double-claim the same row (lease), and ordering is preserved per recipient,
  including the in-flight and crash-recovery cases.
- No `setInterval`-based message polling remains in `server.ts`.
- The two-broker integration test passes, including the silent-consume regression
  test, the bracketed-paste multi-line test, and the cross-machine
  local-resolution test.
- Delivery never leaves an unreaped child process; a machine without tmux performs
  no tmux spawns; a duplicate broker spawn exits without crash-looping; self-exit is
  race-safe; the `messages` table is bounded by (liveness-gated) pruning.
- A liveness-probe failure never deletes a peer's undelivered messages.

## M2: launcher backend (deferred, gated)

Tracked as issue #7; the transport entry gate is issue #8. Not plan-ready until
both entry gates above clear. This sketch records the verified findings the M2 work
must honor, so they are not re-derived.

- **Adoption (decided):** `claude-peers launch [claude args…]` spawns
  `claude --input-format stream-json --output-format stream-json --verbose
  --replay-user-messages [args…]` via `Bun.spawn` (array args), owning the child's
  stdin/stdout. This is a headless/worker session, not an interactive REPL. M2 must
  specify where `launcher.ts` lives and how the command reaches PATH (no `bin`
  exists today; likely a `cli.ts` subcommand).
- **Transport (gated):** the broker→launcher delivery channel (`/deliveries`) is a
  long-lived per-session stream the launcher subscribes to. The exact transport is
  the gate-1 spike's output (Bun.serve streaming proof, or long-poll, or unix
  socket). Whatever it is, it must be loopback-only (control plane), capability-
  token-gated, and **exclusive per session** — when a new stream attaches for a
  session, the prior one is closed (reconnect-with-backoff guarantees overlap).
- **Server-side stream lifecycle:** a dead launcher must not leak the stream or
  wedge that session's delivery. On stream cancel / request abort, drop the broker's
  per-session stream entry and decrement `inFlightDeliveries`. Pid-anchor the
  stream so the existing `cleanStalePeers` sweep closes a stream whose launcher pid
  is dead (ESRCH). Add a periodic keepalive write so a dead socket surfaces EPIPE
  sooner than OS keepalive. An open stream counts as a live peer for self-exit.
- **Session-id agreement:** the launcher and the child's MCP server are two
  processes with different pids. The launcher is the authoritative registrant — it
  registers first with `delivery_kind:"launcher"`, receives `{ id, token }`, and
  exports them to the child (e.g. `CLAUDE_PEERS_SESSION_ID`, `CLAUDE_PEERS_TOKEN`).
  The MCP server, seeing those set, adopts the id and does **not** register a second
  peer. An integration test must prove a message addressed to the session's
  registered id arrives on the launcher's stream and is acked.
- **At-least-once, not exact:** correct the claim that the launcher path never
  double-delivers. After an ack-timeout the broker re-leases and re-injects, so a
  message whose stdin write succeeded but whose replay was slow can be injected
  twice; the `#<id>` tag makes the duplicate identifiable. The confirm-delivery ack
  endpoint is named `/confirm-delivery` (not `/ack-message`) to avoid collision with
  the removed `/ack-messages`.
- **Per-attempt correlation:** the launcher correlates a replayed `user` event to
  its in-flight delivery by the per-attempt `lease_token` (carried in the delivery
  event), not by the row id alone, and additionally matches on the documented-but-
  unguaranteed `isReplay:true` marker as best-effort hardening. A replay from a
  timed-out attempt carries the old token and matches nothing in flight. Prefer a
  structured correlation field in the stream-json envelope over parsing `#<id>` from
  free-form text.
- **Continuous stdout drain:** the launcher runs one always-on reader over the
  child's full stdout for the child's lifetime, parsing every NDJSON line and
  discarding non-matching events, so the child can never block on a full stdout
  pipe. Draining is decoupled from the single-in-flight delivery throttle (the
  throttle bounds deliveries, not reads). Bound the per-line accumulation buffer.
- **Launcher heartbeat producer:** for launcher sessions the launcher (not an MCP
  server) holds the broker connection, so the launcher posts `/heartbeat` to give
  the heartbeat drain a producer; a stream reconnect also triggers an immediate
  drain for that session.
- **Round-trip test:** beyond the replay-ACK, prove end-to-end that a
  launcher-injected peer message yields an actual peer reply (a `send_message` tool
  call), routed correctly — not just an ACK. Test stream-json framing and replay
  parsing against a fake stream-json child, and the stream protocol against a fake
  launcher.
- **Open M2 question:** ordering across a backend change for a live peer
  (re-register `launcher` → `tmux` while rows are queued). Decide whether backend
  changes are allowed with queued rows present, or pin the backend per queued row /
  lease epoch.

## Future work

- **Cross-machine authentication** (issue #4). Replace or augment the IP allowlist
  with a shared secret or mTLS so `/forward-message` and `/gossip` authenticate the
  sender, not just its network location.
- **tmux readiness / ownership check** (issue #5). Before a tmux injection, detect
  whether the pane is at Claude's input prompt rather than a shell, permission, or
  modal state, so an injected `Enter` cannot answer the wrong thing. Until then the
  tmux path is documented as best-effort accepted-by-pane.
- **Best-effort channel tier** (issue #6) for non-tmux sessions that loaded
  `claude/channel`: push `notifications/claude/channel` without ever acking (a
  dropped push is never lost; `check_messages` stays the floor), bounded by a
  per-message attempt cap. Superseded for most cases by the launcher backend; kept
  as a fallback for sessions that loaded the channel but were not launcher-spawned.
- **Launcher reconnect/backoff table.** Specify concrete backoff bounds,
  keepalive interval, and the ack-timeout / lease-timeout relationship in one table
  when M2 is built.
- **Optional coalescing** of a peer's pending messages into one paste (issue #9),
  opt-in for backpressure only (v1 sends one injection per stored message so each is
  individually replyable).
