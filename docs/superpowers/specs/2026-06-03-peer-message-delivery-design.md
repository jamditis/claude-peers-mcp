# Reliable peer-message delivery via stdin injection

- Date: 2026-06-03
- Status: approved (design)
- Author: Joe Amditis
- Scope: `claude-peers-mcp` message delivery path (`server.ts`, `broker.ts`, `shared/types.ts`, new `launcher.ts`)

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
- Push works for sessions reachable by a delivery backend: a tmux pane, or a
  session spawned by the `claude-peers` launcher (which owns its stdin). Sessions
  reachable by neither fall back to `check_messages`, and that boundary is stated
  honestly rather than claimed away.
- A delivery that cannot be confirmed must never be silently consumed.

## Non-goals

- Injecting into an already-running session that no launcher spawned and that is
  not in a tmux pane. Claude Code exposes no API to push into such a session's
  stdin (see research notes); those sessions fall back to `check_messages`.
- Becoming a supervisor for sessions the launcher did not spawn. The launcher owns
  stdin only for its own child; it never tries to attach to a foreign process.
- Guaranteed-once delivery. The launcher path is confirmed (acked) at-least-once;
  the tmux path is best-effort at-least-once and can re-inject after a partial
  failure; `check_messages` is the floor under both.

## Research notes

- **Channels protocol is the wrong primary path.** `notifications/claude/channel`
  is a research preview, and pushes are silently dropped when the session is idle
  — the exact case we care about. The REPL prioritizes stdin over MCP
  notifications. Refs: Channels reference (https://code.claude.com/docs/en/channels-reference);
  GitHub issues anthropics/claude-code #61797, #44380, #38736. No changelog entry
  shows a fix as of 2.1.161.
- **`mcp.notification()` gives no delivery signal.** Confirmed in
  `@modelcontextprotocol/sdk` 1.27.1: `Protocol._onnotification` drops an unknown
  method with a bare `return;` (no error), and `notification()` resolves on
  transport write. This is the mechanical root of the silent-consume bug. The
  server can read client capabilities via `getClientCapabilities()` after
  `oninitialized`, but that only reports what the client declared, not whether a
  given push landed.
- **stdin injection is the reliable path and is already proven in production.**
  `jawn-slack-brain/bridge/tmux_router.py` delivers into Pattern's session with
  `tmux send-keys -t <session> -l <text>` then `Enter`. Writing to stdin means
  Claude Code's native input queue handles "queue until the next tool boundary,"
  and stdin reliably wakes an idle session. Limitation: the target session is
  hardcoded via env, there is no headless support, and `send-keys` exit 0 only
  proves tmux accepted the keystrokes — not that Claude was at its prompt rather
  than a shell/permission/modal state.
- **The SDK streaming-input mode gives an acked, queued user message, but only for
  a session the caller spawned.** `claude --input-format stream-json
  --output-format stream-json --replay-user-messages`: the caller writes a
  `user` message as a JSON line on the child's stdin, and the replayed
  `user`-message event on stdout confirms it entered the queue. This is a true
  delivery ACK. It requires owning the child's stdin, so it works for a launcher
  (parent of the Claude process), not for the MCP server (a stdio child of the
  Claude process) and not for an arbitrary already-running session. Refs:
  https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode,
  https://code.claude.com/docs/en/remote-control.

## Chosen approach

Broker-side, event-driven delivery through a small set of per-session **delivery
backends**. Delivery moves out of the per-session poll loop and into the broker.
The recipient's local broker picks the backend for the recipient and uses it;
delivery is triggered by events — a send, a forward, a heartbeat — never a clock.

Two push backends plus a floor:

1. **tmux backend** — for a session whose own `$TMUX_PANE` was captured at
   registration. The broker injects with `send-keys`. This is **best-effort
   at-least-once pane injection**: a `send-keys` exit 0 means tmux accepted the
   keystrokes into the pane, which in the normal case is Claude's input prompt and
   becomes the next queued user message. It is not a guarantee that Claude was at
   its prompt rather than a modal state, so the model is best-effort, not a true
   queue-ack.
2. **launcher backend** — for a session spawned by `claude-peers launch …`, which
   runs `claude` in stream-json mode and owns its stdin. The broker hands the
   message to the launcher over a delivery stream; the launcher writes a
   stream-json `user` message and reads the replayed `user` event back as a
   **true delivery ACK**, then acks to the broker. This is the push path for
   non-tmux and headless sessions and works on any OS.
3. **`check_messages` floor** — for a session reachable by neither backend (a
   human at a bare terminal that is not in tmux and was not launched by
   `claude-peers`). Manual pull, always works, acked only on read.

### Why this shape

- The broker is the only always-running, event-receiving component, and as the
  same OS user it can `send-keys` to any local pane and hold a stream to a local
  launcher without any MCP connection of its own. The MCP server's job shrinks to
  registration plus tools.
- **Confirmation is the only thing that acks a message** — a launcher replay-ack,
  a `send-keys` exit 0 (accepted-by-pane), or a `check_messages` read. A push that
  cannot be confirmed never acks. That designs out the silent-consume failure mode
  rather than patching it.
- The launcher gives a genuinely acked push for the non-tmux case that the channel
  protocol could not, by owning the one pipe (the child's stdin) that can be
  written reliably.

## Architecture and data flow

```
A's Claude --send_message--> A's MCP server --POST /send-message--> Broker (A's machine)
                                                                      |
                                  local recipient --------------------+
                                                                      v
                                            recipient's backend (resolved locally):
                                              tmux:     tmux -S <socket> send-keys -t <pane> -l <text> ; Enter
                                              launcher: push over delivery stream --> launcher writes stream-json
                                                        user msg to child stdin --> replay event = ACK
                                                                      |
                                                          B's Claude queues it
                                  remote recipient --/forward-message--> Broker (B's machine)
                                              (B's broker resolves B's backend from its OWN registration data)
```

Cross-machine forwards carry only message content and routing identity. Pane,
socket, and launcher details are never sent across machines — the recipient's
broker resolves the recipient's backend from its own local registration data.

### Per-message delivery state and lease

To make concurrent send-time injection, heartbeat flush, and `check_messages`
safe, every message row carries a delivery state and a lease:

- `delivery_state TEXT NOT NULL DEFAULT 'queued'` — one of `queued`, `delivering`,
  `delivered`.
- `lease_expires_at INTEGER` (epoch ms, nullable) — set when a row enters
  `delivering`.

Claiming a row for delivery is a single conditional update inside one
transaction:

```
UPDATE messages
   SET delivery_state = 'delivering', lease_expires_at = :now + :lease_ms
 WHERE id = :id AND delivery_state = 'queued'
```

Only the writer whose update affected a row proceeds to inject it. On success the
row goes to `delivered`; on failure it returns to `queued` (lease cleared) for the
next heartbeat. A `delivering` row whose `lease_expires_at` is in the past is
reclaimable (covers a broker that crashed mid-delivery). `check_messages`
(`/poll-messages`) returns and acks only `queued` rows whose lease is not active,
so it never races a concurrent injection of the same row.

Migration: the existing `delivered INTEGER DEFAULT 0` column maps to
`delivery_state` (`1` → `delivered`, `0` → `queued`); `delivered` may be kept as a
generated/derived mirror for existing reads or dropped once callers move to
`delivery_state`.

### The never-ack invariant

A message reaches `delivered` only when one of these confirms it:

- the launcher reports a stream-json replay ACK, or
- `tmux send-keys` returns exit code 0 (accepted by pane, best-effort), or
- `check_messages` (`/poll-messages`) reads it.

A delivery that cannot be confirmed never sets `delivered` — it returns to
`queued`. Acking on an unconfirmed push is exactly what made the original
silent-consume bug possible, so no code path acks without one of the three
confirmations above.

## Component changes

### `server.ts`

- Remove `pollAndPushMessages`, its `setInterval`, and the `CLAUDE_PEERS_CHANNEL`
  env gate. No channel push logic remains in v1.
- At registration (a loopback POST to the local broker), report the session's own
  `tmux_pane` (`process.env.TMUX_PANE`, validated against `^%\d+$`) and
  `tmux_socket` (the path before the first comma of `process.env.TMUX`, validated
  as an absolute path; otherwise null). A session started by the launcher
  registers with `delivery_kind: "launcher"` and its launcher delivery id instead.
- `send_message` surfaces the broker's delivery result to the sender
  (`injected` for a confirmed push, `accepted` for a best-effort tmux push,
  `queued` otherwise).
- The `claude/channel` capability declaration in the `Server` constructor may stay
  (harmless; reserves the door for the deferred channel tier), but nothing pushes
  to it.

### `launcher.ts` (new)

- `claude-peers launch [claude args…]` spawns `claude --input-format stream-json
  --output-format stream-json --replay-user-messages [args…]` as a child via
  `Bun.spawn` (array args, no shell), owning the child's stdin/stdout.
- Registers the session with the local broker as `delivery_kind: "launcher"`, with
  a launcher delivery id, then holds a delivery stream from the broker
  (`GET /deliveries?session=<id>`, server-sent events; reconnect with backoff on
  drop). This stream is a plain HTTP connection held by a non-Claude process, so
  it consumes no Claude tokens — it is the free, broker-side wait Joe approved.
- On a delivery event: write one stream-json `user` message to the child's stdin,
  read the replayed `user` event from the child's stdout as the ACK, then
  `POST /ack-message` to the broker with the message id. If the replay does not
  arrive within a timeout, do not ack; the broker re-leases the row.
- Reaps the child on exit (`await proc.exited`), deregisters from the broker, and
  closes the delivery stream. One child per launcher; no extra spawns per message.

### `broker.ts`

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
  - `deliverViaLauncher(sessionId, msg)` — enqueue the message onto the session's
    open delivery stream; resolves when the launcher posts its ack, rejects on
    timeout (row returns to `queued`).
  - `tmuxAvailable()` — probe `tmux -V` once per broker and cache the result. When
    tmux is absent (typical on Windows), the tmux backend is skipped without
    spawning, so a misconfigured peer can never trigger repeated failed spawns.
- `handleSendMessage` / `handleForwardMessage`: after insert, claim the row via the
  lease and attempt the recipient's backend; mark `delivered` only on confirmation;
  return `{ ok, routed, delivery: "injected" | "accepted" | "queued" }`.
- `/deliveries` (new): per-session SSE stream the launcher subscribes to.
  `/ack-message` (new): launcher confirms a message id, moving its row to
  `delivered`.
- `/heartbeat`: flush `queued` (unleased) messages to their backend, **one
  injection per stored message** (no coalescing in v1 — each stored message becomes
  one injected user message so the receiver can reply to each), in `id` ASC order,
  stopping on the first failure to preserve ordering, skipping any row currently
  leased.
- Registration stores `tmux_pane` / `tmux_socket` / `delivery_kind` for **local**
  peers only. Gossip and `/forward-message` do not carry pane, socket, or launcher
  data; a recipient broker resolves the recipient's backend from its own DB.

### `shared/types.ts`

- `Peer` and `RegisterRequest`: add `tmux_pane: string | null`,
  `tmux_socket: string | null`, `delivery_kind: "tmux" | "launcher" | "none"`.
  These describe a peer to its **own** broker; the gossip serialization omits the
  pane/socket/launcher fields (see below).
- Add a `SendResult` type:
  `{ ok: boolean; error?: string; routed?: "local" | "remote"; delivery?: "injected" | "accepted" | "queued" }`.
- `GossipRequest` peers and `ForwardMessageRequest` carry identity and routing
  fields only (id, machine, summary, pid, cwd) — **not** `tmux_pane`,
  `tmux_socket`, or launcher data. Backend resolution is strictly local to the
  recipient broker.

## Injected message format

A single logical line, wrapped in a bracketed-paste sequence so embedded newlines
do not submit early, followed by one `Enter`:

```
ESC[200~[peer <from_id> #<id>] <text>  (reply: send_message to_id="<from_id>")ESC[201~
```

- `<text>` is the raw message; `<id>` is the message row id, included for
  traceability and as a dedup hint on the best-effort tmux path. Bracketed paste
  (`ESC[200~` / `ESC[201~`) makes Claude Code treat the whole block as one paste,
  so a multi-line message is not submitted line by line. A single trailing `Enter`
  submits it.
- If a session does not honor bracketed paste, the fallback is to collapse internal
  newlines to spaces before sending; peer messages are short.
- The launcher path does not use this terminal framing — it sends a stream-json
  `user` message whose text is `[peer <from_id> #<id>] <text>  (reply: …)`.

## Error handling

- No backend, `send-keys` failure, stale pane id, or launcher timeout -> the row
  returns to `queued` (lease cleared), retried on the next heartbeat, with
  `check_messages` as the floor. Logged at the broker (rate-limited, consistent
  with the existing gossip-failure summary style).
- Dead recipient -> the existing liveness sweep (`process.kill(pid, 0)`) removes
  the peer and its undelivered messages; a launcher that exits deregisters its
  session.
- Broker shells out only through `Bun.spawn` with array args (no shell string), so
  message text cannot inject shell commands. A 2s spawn timeout prevents a hung
  tmux call from stalling a request.
- Ordering is preserved per recipient (ASC plus stop-on-first-failure, leased rows
  skipped). The tmux path can re-inject a message after a partial failure
  (send-keys wrote keys but exited non-zero or the broker crashed before
  `delivered`); this is the at-least-once cost of having no receiver-side ack on
  that path, and the message id in the payload makes a duplicate identifiable. The
  launcher path does not double-deliver because its replay ack is exact.

## Security

- Array-arg spawn: no shell interpolation of message text or pane ids.
- Validate `tmux_pane` against `^%\d+$` and `tmux_socket` as an absolute path
  before use; reject and treat as non-tmux otherwise.
- Accept pane/socket/launcher registration data only from a **loopback**
  registration POST, and only as the registering process's report about **itself**
  (its own `$TMUX` / `$TMUX_PANE`). The broker never accepts pane coordinates from
  a remote or forwarded request and never injects into a pane it learned from
  another machine. Same-user local peers are fully trusted: a same-user process can
  register a pane the broker will inject into, which is acceptable under the
  single-user-per-machine assumption and is documented as such.
- Cross-machine traffic keeps the existing IP allowlist. The allowlist is a
  network-location check, not authentication — any process on an allowed host can
  reach `/forward-message` and `/gossip`. Strengthening that boundary (shared
  secret or mTLS) is tracked as future work, not claimed here.

## Resource hygiene and cross-platform safety

The fleet includes Windows broker nodes (a4000, legion2025) where tmux does not
exist, so the design must spawn sparingly, reap every child, and never depend on
tmux being present. The launcher backend needs no tmux, so the non-tmux push path
works on Windows and macOS too.

### Broker process (no duplicate brokers)

- Exactly one broker per machine. `ensureBroker` health-checks before spawning, but
  two sessions can race and each spawn a `bun broker.ts`. The broker binds the port;
  on `EADDRINUSE` it logs and exits 0 (the existing broker won the race) instead of
  throwing or crash-looping. Duplicate spawns are self-correcting.
- The detached spawn keeps `stdio: ["ignore", "ignore", "inherit"]` and
  `proc.unref()`, so no pipe buffers leak and the broker outlives the spawning
  session.
- Empty-broker self-exit, made race-safe: the broker tracks a `lastActivityAt`
  timestamp (updated on every request, including registration, heartbeat, and
  delivery) and an `inFlightDeliveries` counter (incremented while a row is
  `delivering`). It exits only when, checked together, there are zero live local
  peers, zero in-flight deliveries, and `lastActivityAt` is older than the grace
  window (10 minutes). A registration or heartbeat arriving during the window
  refreshes `lastActivityAt` and cancels the pending exit, so startup and self-exit
  cannot race into churn. The next session relaunches a broker.

### Child processes (injection)

- tmux: one tmux process per delivery (chained keystrokes), `proc.exited` always
  awaited, killed on the 2s timeout. No fire-and-forget spawns.
- launcher: one long-lived child per launcher (the `claude` process itself), reaped
  on exit. Delivery adds no per-message spawn — it writes to the existing child's
  stdin.
- One injection per stored message bounds tmux work to the number of `queued`
  messages per heartbeat; there is no coalescing path to reason about separately.
- `tmuxAvailable()` is probed once and cached. A machine without tmux (Windows)
  never attempts a tmux spawn; such sessions use the launcher backend or
  `check_messages`. A missing-binary result is cached, so a peer that wrongly
  reports a pane cannot cause a spawn storm.

### Cross-platform

- A session launched outside tmux and not via `claude-peers launch` registers with
  `delivery_kind: "none"` and is delivered via `check_messages`. A launcher-managed
  session registers `launcher` and gets acked push on any OS. A Windows broker
  registers, routes, and gossips normally.
- `process.kill(pid, 0)` liveness is used only for cleanup and is wrapped in
  try/catch; on a platform where it behaves differently, a peer is at worst kept
  slightly longer, never spawned against.
- tmux is an enhancement where it exists, never a requirement. No code path assumes
  it exists.

### Memory and storage

- A periodic prune runs inside the existing cleanup timer: delete `delivered`
  messages older than a short TTL, and drop `queued` messages older than a max age
  (matching the dead-peer cleanup already present). The `messages` table cannot grow
  without bound when a recipient never reads.
- `gossipFailureStates` is bounded by sibling count. Removing the message poll loop
  also removes its per-session timer.

## Testing (TDD, failing test first)

- **Regression / invariant:** a message whose push fails (tmux non-zero exit, or
  launcher timeout) is never marked delivered (reproduces the original
  silent-consume bug; must stay green forever).
- Unit: `resolveTmuxTarget` (env parse, pane-id and socket validation),
  `formatPeerMessage` (bracketed-paste wrap, newline handling, message-id and reply
  hint), `deliverViaTmux` (single chained-keystroke spawn with array args via an
  injected spawn, delivered only on exit 0, child reaped, timeout path).
- Unit: the lease state machine — a `queued` row claimed by one writer cannot be
  claimed by a second (the conditional update affects zero rows the second time);
  an expired `delivering` lease is reclaimable; `check_messages` skips a leased row;
  a failed push returns the row to `queued`.
- Unit: `handleSendMessage` marks delivered on confirmation and leaves queued on
  failure; heartbeat flush drains in `id` order, one injection per message, stops on
  first failure, skips leased rows.
- Launcher: `deliverViaLauncher` resolves only after the launcher acks; a launcher
  ack moves the row to `delivered`; a launcher timeout returns it to `queued`; the
  child is spawned once and reaped on exit. (stream-json framing and replay parsing
  tested against a fake child process.)
- Integration: extend the existing two-broker harness — inject to a fake tmux
  target and assert `accepted`; deliver to a fake launcher session and assert
  `injected` after its ack; a `none` peer yields `queued` and stays retrievable via
  `check_messages`. A forwarded cross-machine message is resolved to the recipient's
  backend by the recipient broker with no pane data in the forward payload.
- Resource hygiene: `deliverViaTmux` awaits and reaps its child and kills it on
  timeout; `tmuxAvailable()` short-circuits with no spawn when the binary is absent;
  a second broker bind exits 0 (singleton); the prune removes aged delivered and
  over-age queued rows; self-exit fires only with zero peers, zero in-flight
  deliveries, and an expired activity window, and a heartbeat during the window
  cancels it.

## What gets deleted

- The `setInterval` message poll loop and `pollAndPushMessages`.
- The `CLAUDE_PEERS_CHANNEL` opt-in.
- The ack-on-unconfirmed-notification path.

Heartbeat stays (free HTTP liveness ping, now also the injection-retry trigger).
No Claude-side `/loop` anywhere.

## Acceptance criteria

- A message sent to a peer running in a tmux pane appears in that session as a
  queued user message without the receiver calling any tool, and is marked
  delivered on `send-keys` exit 0 (best-effort, accepted-by-pane).
- A message sent to a peer launched by `claude-peers launch` appears as a queued
  user message and is marked delivered only after the launcher's stream-json replay
  ack (confirmed delivery), on any OS.
- A message sent to a peer reachable by neither backend is left `queued` (never
  marked delivered without confirmation) and remains retrievable via
  `check_messages`.
- Concurrent send-time injection, heartbeat flush, and `check_messages` never
  double-claim the same row (lease), and ordering is preserved per recipient.
- No `setInterval`-based message polling remains in `server.ts`.
- The two-broker integration test passes, including the silent-consume regression
  test, the launcher-ack test, and the cross-machine local-resolution test.
- Delivery never leaves an unreaped child process; a machine without tmux performs
  no tmux spawns; a duplicate broker spawn exits without crash-looping; self-exit is
  race-safe; the `messages` table is bounded by pruning.

## Future work

- **Cross-machine authentication** (issue #4). Replace or augment the IP allowlist
  with a shared secret or mTLS so `/forward-message` and `/gossip` authenticate the
  sender, not just its network location. (codex finding #8)
- **tmux readiness / ownership check** (issue #5). Before a tmux injection, detect
  whether the pane is at Claude's input prompt rather than a shell, permission, or
  modal state, so an injected `Enter` cannot answer the wrong thing. Until then the
  tmux path is documented as best-effort accepted-by-pane. (codex finding #2)
- **Best-effort channel tier** (issue #6) for non-tmux sessions that loaded `claude/channel`:
  push `notifications/claude/channel` without ever acking (a dropped push is never
  lost; `check_messages` stays the floor), bounded by a per-message attempt cap.
  Superseded for most cases by the launcher backend; kept as a fallback idea for
  sessions that loaded the channel but were not launcher-spawned.
- **Optional coalescing** of a peer's pending messages into one paste, opt-in for
  backpressure only (v1 sends one injection per stored message so each is
  individually replyable).
