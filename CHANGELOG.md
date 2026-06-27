# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Near-real-time doorbell for non-tmux sessions (#49): a `delivery_kind='none'` interactive session has no pane to push into, so until now it saw mail only at its next manual `check_messages` — multi-minute lag during active multi-peer coordination. The broker now writes a per-recipient marker file (`shared/notify.ts`, a sibling of `db_path`: `~/.claude-peers.db.doorbells/<id>.mark`) holding the recipient's max pending row id whenever mail is queued for a `none` recipient (`ringDoorbell`, after insert in the local-send and forward paths; tmux recipients are skipped — they already get an active push). `bun cli.ts doorbell <id>` watches that marker with `fs.watch` (near-zero idle CPU) plus a slow poll fallback, treats it as level-triggered state (debounce + read-after-arm; the counter only grows, so a coalesced or missed event costs at most one poll interval, never a message), and exits the instant it advances so the harness re-wakes the session — which reads via `check_messages` and re-arms. The path is notify-only: the marker is a content-free counter, never the message body or the SQLite store, and nothing in it marks a row delivered, so `check_messages` stays the single consume path and the never-ack invariant is unchanged. A session with no watcher is unaffected (the write lands in an unwatched file) and degrades to the existing poll-only floor.
- `/peek` control-plane route and `peek_messages` MCP tool (#49): a non-consuming, token-gated, recipient-scoped read that reports the caller's own id and its pending count/max-id without flipping any row to `delivered` (the read equivalent of `/poll-messages` minus `markPolled`). It is how a session discovers the id to arm the doorbell with, and the schema-decoupled, authenticated source a watcher can poll instead of reading the SQLite file directly. Adds protocol version 5: a server holding `peek_messages` retires an older broker that lacks `/peek` and the doorbell write, so the feature can't silently no-op against a pre-upgrade broker.
- Stuck-pane escalation for tmux delivery (#42, follow-up to the #5 readiness probe): when a recipient pane stays a bare shell across `DEFAULT_DEFERRAL_ESCALATION_CAP` consecutive deferrals, the broker emits one louder structured log instead of only the per-attempt defer line, so a permanently shelled session — whose still-live pid the dead-pid sweep cannot reap — does not silently stop receiving mail. The streak is counted per recipient, resets on any delivered (or otherwise not-deferred) attempt and whenever the recipient drains its mail by polling, and is dropped when the peer is removed. The bound lives in the pure `decideDeferralEscalation` decision (fires once at the cap, never re-fires above it); `deliverViaTmux` gained an optional `onDefer` callback that the broker wires to the counter.

## [0.3.0] - 2026-06-11

This release cuts the token cost of running the peer network: message delivery is urgency-tiered so most mail no longer costs the recipient an inference turn, summaries seed themselves from git at registration, and the per-call tool output is a fraction of its old size.

### Added

- Message urgency tiers (protocol version 4): `send_message` takes `urgency` — `interrupt` pushes into the recipient's session at once and flushes their pending pushable mail with it; `normal` (the MCP tool default) queues with a `push_after` deadline, delivered free at the recipient's next `check_messages` or pushed by their heartbeat once `push_delay_ms` (default 2 minutes) lapses; `fyi` never auto-pushes, is poll-only, and is tagged `[fyi]` with no reply expected. Absent urgency on the wire still means `interrupt`, so pre-urgency clients and sibling brokers keep their old push-on-send behavior. The point is token economics: a pushed message costs the recipient a full inference turn over their whole context, a polled one costs only its own text, and a flush batches a backlog into one turn instead of several.
- `push_delay_ms` config field (optional, default `120000`) controlling the `normal`-urgency push deadline.
- `--urgency` flag on `bun cli.ts send` (CLI default stays `interrupt` so existing scripts keep push-on-send).
- The local `/send-message` route now reports the sent message's own delivery disposition (via its row id) instead of the queue head's, matching the cross-broker honesty fix from #14.
- Auto-summary at registration: a fresh session's summary is seeded from git state (`[auto] <branch>; recent: <files>`, capped at 140 chars, empty outside a git repo) via `buildAutoSummary` in `shared/summarize.ts`, so peers can read what a session is touching without that session spending an inference turn on `set_summary` first. `set_summary` overwrites it once the task is clearer. The seed gossips to sibling brokers like any summary (same-class metadata as the `cwd`/`git_root` fields that already federate); `auto_summary: false` in the config disables it for nodes federating across a sensitive boundary.

### Changed

- Rewrote the MCP `instructions` block ~60% smaller and replaced the respond-immediately rule with messaging norms: telegraphic style, no acknowledgment-only replies, file-pointer for long content, honest urgency selection, and `check_messages` at task boundaries.
- The injected peer line carries the `(reply: send_message ...)` hint only on `interrupt` messages, and tags `fyi` ones; `send_message`'s tool result is terse (`Sent to <id> (pushed|queued)`).
- `set_summary` no longer echoes the summary text back in its tool result (the caller just wrote it), and the instructions block describes the auto-seeded summary instead of demanding a `set_summary` call on start.
- Compact `list_peers` rendering (`shared/format-peers.ts`): one head line per peer (`<id>  <machine> [remote]  <cwd>  (repo <git_root-when-different>)  (seen <relative-age>)`) plus an indented summary line, replacing the ~8-line block per peer. Dropped fields were redundant or rarely consulted (repo when equal to cwd, tty, tailscale_ip — routing is by id) and raw ISO timestamps became relative ages. Summaries display capped at 200 chars (truncation keeps the head, where identifying markers live) with newlines collapsed.

### Fixed

- `floor_remote_forwards` now actually floors: a floored forward gets `push_after` NULL, keeping it out of the push channel entirely. Previously the floor only skipped the immediate inject and the recipient's next heartbeat drain (~15s later) pushed the remote text into the pane anyway.

## [0.2.0] - 2026-06-04

This release turns claude-peers from a single-machine discovery tool into a federated, security-gated peer messaging fabric: cross-machine gossip across four broker nodes, broker-side tmux delivery backed by a per-message lease state machine, and per-session capability-token auth (protocol version 3) that closes the `from_id` forgery hole.

### Added

- Federated cross-machine peer discovery: each node's broker POSTs its live local peer list to every sibling on a 5s gossip loop over Tailscale and TTLs remote rows out after 30s, so `list_peers` scope:machine merges local and remote peers (#1).
- Cross-machine message routing: `send_message` to a non-local peer resolves the owning broker from gossiped machine names and forwards over `/forward-message`, which the receiver queues for the local peer (#1, #16).
- NODE-D (Tailscale name `node-d`, 100.64.0.4) as a 4th broker node, with symmetric sibling configs for all four machines and two PowerShell installers (Bun + clone + firewall rule for inbound TCP 7899, and a logon Task Scheduler entry) (#2).
- Reliable broker-side tmux delivery: the broker types each message into the recipient's pane via `tmux send-keys` bracketed-paste, tracked by a per-message `queued -> delivering -> delivered` lease machine that re-probes liveness before confirming and requeues on failure so a message is never silently lost (#16).
- Per-session capability-token auth (protocol version 3): `/register` mints a 256-bit token bound to the peer, and every mutating control-plane call must present `Authorization: Bearer` matching its principal, so a forged `from_id` returns 401 (#16, closes #13).
- `CLAUDE_PEERS_ALLOW_UNSIGNED=1` upgrade-grace flag that forgives only a missing token on a pre-v3 NULL-token row during the v2-to-v3 window; a wrong token always 401s (#16).
- Source-IP allowlist and `floor_remote_forwards` secure-by-default behavior so cross-machine forwards queue for pull instead of auto-pasting unless opted out (#1, #16).
- CI workflow running typecheck, Biome lint, and `bun test` as a single required-check job, a CodeQL JavaScript/TypeScript workflow on PRs and a weekly cron, and a `biome.json` pinned to Biome 2.4.16 (#20).
- Native Windows support for the broker process: `fileURLToPath` for the auto-spawn path (replacing `new URL(...).pathname`, which `Bun.spawn` can't resolve on Windows) and a `kill-broker` that branches on `process.platform` — `netstat -ano` on Windows, `lsof` elsewhere (#19).

### Changed

- Match peer machine names case-insensitively in broker routing, so config casing drift (a node broadcasting `NODE-D` listed as sibling `node-d`) no longer returns a null forward URL (#18, closes #17).
- Collapse repeated gossip failures into periodic summaries: log the first failure, stay silent within a 5-minute window, then emit one `still failing` summary per interval and a `recovered` line on recovery, replacing the ~17,280 log lines/day a single dead sibling produced (#3).
- Drop the OpenAI auto-summary dependency in favor of each instance setting its own summary via the `set_summary` tool (#1).
- Gate the broker control plane to loopback only, exempting just the two federation routes (`/gossip`, `/forward-message`), so off-machine traffic cannot reach the mutating endpoints (#16).
- Strip the token column from `/list-peers` responses so the read route never leaks the per-session secret (#16).
- Bump `PROTOCOL_VERSION` to 3 and retire any older broker on startup via a `/health` version handshake (#16).

### Fixed

- Clear 16 pre-existing strict `tsc` errors that blocked a typecheck gate, including the control-plane request cast at the `req.json()` boundary, an env index-signature widening in `resolveTmuxTarget`, and an unhonored federation-test timeout moved onto the hooks (#20).
- Keep an in-flight delivery's peer row from being deleted out from under it across unregister and same-pid re-register, making the active-lease invariant total (#16).
- Drain an in-flight remote forward before a retire or idle-exit so cross-machine mail is not dropped on shutdown (#16).
- Strip C0/C1 control characters (including ESC and the C1 CSI byte) before injection to neutralize bracketed-paste escape injection (#16).

[0.3.0]: https://github.com/jamditis/claude-peers-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/jamditis/claude-peers-mcp/releases/tag/v0.2.0
