# Reliable peer-message delivery via stdin injection

- Date: 2026-06-03
- Status: approved (design)
- Author: Claude (officejawn) with Joe Amditis
- Scope: `claude-peers-mcp` message delivery path (`server.ts`, `broker.ts`, `shared/types.ts`)

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
- Works for any running session that can receive it, interactive or not.
- A delivery that cannot be confirmed must never be silently consumed.

## Non-goals

- Injecting into a truly headless session that no supervisor spawned and that did
  not load a channel. Claude Code exposes no API for that (see research notes);
  such sessions fall back to `check_messages`.
- Becoming a session supervisor (the SDK streaming-input model). Out of scope.
- Guaranteed-once delivery. The model is at-least-once on the primary path and
  best-effort on the fallback, with `check_messages` as the floor.

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
  `oninitialized`, including `experimental['claude/channel']` — but that only
  reports what the client declared, not whether a given push landed.
- **stdin injection is the reliable path and is already proven in production.**
  `jawn-slack-brain/bridge/tmux_router.py` delivers into Pattern's session with
  `tmux send-keys -t <session> -l <text>` then `Enter`. Writing to stdin means
  Claude Code's native input queue handles "queue until the next tool boundary,"
  and stdin reliably wakes an idle session. Limitation in that implementation: the
  target tmux session is hardcoded via env, and there is no headless support.
- **No injection API exists for arbitrary already-running sessions.** SDK
  streaming input (`--input-format stream-json`) gives acked, queued user messages
  but only for sessions the caller spawned. Remote control is human-in-the-loop
  only. Refs: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode,
  https://code.claude.com/docs/en/remote-control.

## Chosen approach

Broker-side tmux injection, event-driven, with a best-effort never-ack channel
tier and `check_messages` as the floor.

Delivery moves out of the per-session poll loop and into the broker. The recipient's
local broker resolves the recipient's tmux pane (captured at registration from the
session's own `$TMUX_PANE`) and injects the message with `send-keys`. Because that
writes to the session's stdin, the message queues natively and wakes the session.
Delivery is triggered by events — a send, a forward, a heartbeat — never a clock.

### Why this shape

- The broker is the only always-running, event-receiving component, and as the
  same OS user it can `send-keys` to any local pane without any MCP connection of
  its own. The MCP server's job shrinks to registration plus tools.
- Making **injection success the only event that acks a message** designs out the
  silent-consume failure mode rather than patching it.

## Architecture and data flow

```
A's Claude --send_message--> A's MCP server --POST /send-message--> Broker (A's machine)
                                                                      |
                                  local recipient --------------------+
                                                                      v
                          tmux -S <socket> send-keys -t <pane> -l <text> ; Enter
                                                                      |
                                                          B's pane stdin --> B's Claude queues it
                                  remote recipient --/forward-message--> Broker (B's machine) --> (same inject)
```

### Delivery tiers (in order)

1. **tmux injection (primary).** Any session whose `$TMUX_PANE` was captured.
   Confirmable via the `send-keys` exit code, instant, wakes an idle session.
2. **channel push (best-effort, never-ack).** Non-tmux sessions that loaded
   `claude/channel`. Bounded re-pushes, never marks the message delivered, so a
   dropped push is never lost. May produce a duplicate if the session later calls
   `check_messages` — an accepted trade-off.
3. **`check_messages` (floor).** Always works, manual pull. Unchanged.

### The never-ack invariant

A message is marked `delivered=1` only when:

- `tmux send-keys` returns exit code 0, or
- `check_messages` (`/poll-messages`) reads it.

The channel tier never sets `delivered`; it only increments `channel_attempts`.
A push that cannot be confirmed cannot consume a message.

## Component changes

### `server.ts`

- Remove `pollAndPushMessages`, its `setInterval`, and the `CLAUDE_PEERS_CHANNEL`
  env gate.
- At registration, report `tmux_pane` (`process.env.TMUX_PANE`, validated against
  `^%\d+$`) and `tmux_socket` (the path before the first comma of `process.env.TMUX`,
  validated as an absolute path; otherwise null).
- Set `mcp.oninitialized` to capture
  `getClientCapabilities()?.experimental?.["claude/channel"]` into a local
  `channelCapable` flag.
- `send_message` surfaces the broker's delivery result to the sender
  ("injected into peer's session" vs "queued for peer").
- Channel tier, active only when `channelCapable && tmux_pane === null`: on the
  heartbeat response, emit `notifications/claude/channel` for each pending message
  whose `channel_attempts < MAX_CHANNEL_ATTEMPTS` (2), then POST
  `/mark-channel-attempt` with their ids. Never acks.

### `broker.ts`

- Delivery module (pure where possible, for testing):
  - `resolveTmuxTarget(env)` — parse and validate `$TMUX` / `$TMUX_PANE`.
  - `formatPeerMessage(msg, sender)` — build the injected text (see below).
  - `deliverViaTmux(pane, socket, text)` — one `Bun.spawn` with **array args, no
    shell** and a 2s timeout, chaining both keystrokes in a single tmux process so
    delivery costs one spawn, not two:
    `tmux [-S socket] send-keys -t <pane> -l <wrapped-text> ';' send-keys -t <pane> Enter`.
    `proc.exited` is always awaited and the child is killed on timeout, so no
    process is left unreaped. Returns success only on exit 0.
  - `tmuxAvailable()` — probe `tmux -V` once per broker and cache the result. When
    tmux is absent (typical on Windows), injection is skipped without spawning, so
    a misconfigured peer can never trigger repeated failed spawns.
- `messages` table gains `channel_attempts INTEGER NOT NULL DEFAULT 0` (distinct
  from `delivered`). Add a migration guard (`ALTER TABLE ... ADD COLUMN` wrapped in
  a try, since the table is created with `IF NOT EXISTS`).
- `handleSendMessage` / `handleForwardMessage`: after insert, attempt injection
  when the recipient has a `tmux_pane`; mark `delivered=1` only on success; return
  `{ ok, routed, delivered: "tmux" | "queued" }`.
- `/heartbeat`: flush undelivered messages to tmux peers, coalescing a peer's
  pending messages into a single injection (one paste, one spawn) per heartbeat
  rather than one spawn per message; in `id` ASC order, stopping on the first
  failure to preserve ordering; include still-pending messages in the response for
  the channel tier.
- New endpoint `/mark-channel-attempt` ( `{ ids: number[] }` -> increment
  `channel_attempts`, never deliver ).
- Registration stores `tmux_pane` / `tmux_socket`; gossip and `/forward-message`
  carry them so a remote broker can inject for a remote-origin send.

### `shared/types.ts`

- `Peer` and `RegisterRequest`: add `tmux_pane: string | null`, `tmux_socket: string | null`.
- `Message`: add `channel_attempts: number`.
- Add a `SendResult` type: `{ ok: boolean; error?: string; routed?: "local" | "remote"; delivered?: "tmux" | "queued" }`.
- `GossipRequest` peers and `ForwardMessageRequest`: carry `tmux_pane` / `tmux_socket`.

## Injected message format

A single logical line, wrapped in a bracketed-paste sequence so embedded newlines
do not submit early, followed by one `Enter`:

```
ESC[200~[peer <from_id>] <text>  (reply: send_message to_id="<from_id>")ESC[201~
```

- `<text>` is the raw message. Bracketed paste (`ESC[200~` / `ESC[201~`) makes
  Claude Code treat the whole block as one paste, so a multi-line message is not
  submitted line by line. A single trailing `Enter` submits it.
- If a session does not honor bracketed paste, the fallback is to collapse
  internal newlines to spaces before sending; peer messages are short.

## Error handling

- No pane, `send-keys` failure, or stale pane id -> message stays `delivered=0`,
  retried on the next heartbeat, with `check_messages` as the floor. Logged at the
  broker (rate-limited, consistent with the existing gossip-failure summary style).
- Dead recipient -> the existing liveness sweep (`process.kill(pid, 0)`) removes
  the peer and its undelivered messages.
- Broker shells out only through `Bun.spawn` with array args (no shell string), so
  message text cannot inject shell commands. A 2s spawn timeout prevents a hung
  tmux call from stalling a request.
- Ordering is preserved (ASC plus stop-on-first-failure). Because injection is the
  only confirmable ack, a silent no-op cannot consume a message.

## Security

- Array-arg spawn: no shell interpolation of message text or pane ids.
- Validate `tmux_pane` against `^%\d+$` and `tmux_socket` as an absolute path
  before use; reject and treat as non-tmux otherwise.
- The broker targets only same-user panes; document the single-user-per-machine
  assumption. Cross-machine traffic keeps the existing IP allowlist.

## Resource hygiene and cross-platform safety

The fleet includes Windows broker nodes (a4000, legion2025) where tmux does not
exist, so the design must spawn sparingly, reap every child, and never depend on
tmux being present.

### Broker process (no duplicate brokers)

- Exactly one broker per machine. `ensureBroker` health-checks before spawning, but
  two sessions can race and each spawn a `bun broker.ts`. The broker binds the port;
  on `EADDRINUSE` it logs and exits 0 (the existing broker won the race) instead of
  throwing or crash-looping. Duplicate spawns are self-correcting.
- The detached spawn keeps `stdio: ["ignore", "ignore", "inherit"]` and
  `proc.unref()`, so no pipe buffers leak and the broker outlives the spawning
  session.
- Empty-broker self-exit: if the broker has zero live local peers and has served no
  request for a grace period (10 minutes), it shuts down. Brokers do not accumulate
  across long machine uptime after all sessions close; the next session relaunches
  one.

### Child processes (injection)

- One tmux process per delivery (chained keystrokes), `proc.exited` always awaited,
  killed on the 2s timeout. No fire-and-forget spawns.
- Per-peer coalescing on heartbeat bounds spawns to (live tmux peers) per heartbeat
  interval, independent of how many messages are queued.
- `tmuxAvailable()` is probed once and cached. A machine without tmux (Windows) never
  attempts a tmux spawn; it falls straight through to the channel tier or
  `check_messages`. A missing-binary result is cached, so a peer that wrongly reports
  a pane cannot cause a spawn storm.

### Cross-platform

- Windows and macOS sessions launched outside tmux register with `tmux_pane = null`,
  so the broker never injects to them — they deliver via the channel tier or
  `check_messages`. A Windows broker still registers, routes, and gossips normally.
- `process.kill(pid, 0)` liveness is used only for cleanup and is wrapped in
  try/catch; on a platform where it behaves differently, a peer is at worst kept
  slightly longer, never spawned against.
- tmux is an enhancement, never a requirement. No code path assumes it exists.

### Memory and storage

- A periodic prune runs inside the existing cleanup timer: delete `delivered = 1`
  messages older than a short TTL, and drop undelivered messages older than a max age
  (matching the dead-peer cleanup already present). The `messages` table cannot grow
  without bound when a recipient never reads.
- `channel_attempts` caps re-pushes; `gossipFailureStates` is bounded by sibling
  count. Removing the message poll loop also removes its per-session timer.

## Testing (TDD, failing test first)

- **Regression / invariant:** a message whose injection fails is never marked
  delivered (reproduces the original silent-consume bug; must stay green forever).
- Unit: `resolveTmuxTarget` (env parse, pane-id and socket validation),
  `formatPeerMessage` (bracketed-paste wrap, newline handling, reply hint),
  `deliverViaTmux` (single chained-keystroke spawn with array args via an injected
  spawn, delivered only on exit 0, child reaped, timeout path).
- Unit: `handleSendMessage` marks delivered on injection success and leaves queued
  on failure; heartbeat flush drains in order and stops on first failure; channel
  tier increments `channel_attempts`, never sets `delivered`, and stops at
  `MAX_CHANNEL_ATTEMPTS`.
- Integration: extend the existing two-broker harness — inject to a fake tmux
  target and assert the delivery result; a non-tmux peer yields `queued` plus a
  bounded channel-attempt count.
- Resource hygiene: `deliverViaTmux` awaits and reaps its child and kills it on
  timeout (no lingering process); `tmuxAvailable()` short-circuits with no spawn
  when the binary is absent; a second broker bind exits 0 (singleton); the prune
  removes aged delivered and over-age undelivered rows; coalescing turns N pending
  messages for one peer into a single injection call.

## What gets deleted

- The `setInterval` message poll loop and `pollAndPushMessages`.
- The `CLAUDE_PEERS_CHANNEL` opt-in.
- The ack-on-unconfirmed-notification path.

Heartbeat stays (free HTTP liveness ping, now also the injection-retry trigger).
No Claude-side `/loop` anywhere.

## Acceptance criteria

- A message sent to a peer running in a tmux pane appears in that session as a
  queued user message without the receiver calling any tool, and is marked
  delivered.
- A message sent to a peer with no tmux pane is never marked delivered by a push;
  it remains retrievable via `check_messages`.
- No `setInterval`-based message polling remains in `server.ts`.
- The two-broker integration test passes, including the silent-consume regression
  test.
- Delivery never leaves an unreaped child process; a machine without tmux performs
  no tmux spawns; a duplicate broker spawn exits without crash-looping; the
  `messages` table is bounded by pruning.

## Future work

- Optional supervisor mode (SDK streaming input) for daemon-spawned headless
  sessions that need acked delivery.
- A small readiness check before injection (detect a confirmation/permission
  prompt) if accidental `Enter` answers prove to be a problem in practice.
