# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Bind relative database overrides in doorbell recipes to the MCP working directory. Validate marker readability and file type before reporting armed, and stop visibly on persistent read failures instead of silently polling an unreadable counter.

- Ask clients to arm the doorbell at session startup and after each signal, including when `peek_messages` finds queued mail. Return a peer-bound, explicit-path launch recipe with a pre-launch baseline; the host must start and own the background task and schedule a turn on completion. Add watcher readiness, exclusive managed-watcher guards, owner-exit cleanup, and documented unsupported-host and adoption behavior. This does not hot-reload or repair existing sessions.

## [0.4.0] - 2026-10-09

This release supersedes v0.3.1 with a minor version number that reflects the capabilities and upgrade requirements introduced since v0.3.0. The v0.3.1 tag and release remain available. Runtime behavior is unchanged from v0.3.1; only version metadata and documentation change.

The changes since v0.3.0 include delivery recovery and failed-push demotion, poll-only doorbells and `peek_messages`, friendly peer names, `doctor` diagnostics, worktree discovery, optional push coalescing, and expanded setup and operations guides. See the [v0.3.1 notes](#031---2026-10-09) below for the full change list.

### Compatibility and upgrading

- The broker protocol remains `10`, as in v0.3.1. Upgrading from v0.3.1 adds no schema or protocol migration; update the checkout to `v0.4.0`, run `bun install --frozen-lockfile`, and restart clients to report the new version.
- Users upgrading from v0.3.0 (protocol `4`) must follow the coordinated stopped-upgrade procedure below, checking out `v0.4.0` in step 3. Only protocol 9-to-10 mixed-version rolling upgrades have been tested.
- Federation authentication is still pending. This release does not complete that roadmap gate, and the npm package remains private.

## [0.3.1] - 2026-10-09

This source release includes the completed reliability milestone from [roadmap #85](https://github.com/jamditis/claude-peers-mcp/issues/85), plus discovery, diagnostics, and documentation improvements since v0.3.0. The npm package remains private. Federation authentication and the public npm beta are still pending.

### Added

- `peek_messages` reports the caller's peer ID and pending count without consuming mail. The `doorbell` CLI watches a content-free marker for readable poll-only mail, including `fyi` and default-floored remote messages to tmux sessions. A client harness must react to the watcher and poll; it does not force an idle model to wake (#50, #69).
- Friendly session names appear in discovery and can be used as message targets. Exact peer IDs take precedence, and ambiguous names require an ID (#61, #62).
- `bun cli.ts doctor [--json]` provides read-only broker, sibling, process, pane, and queue diagnostics without exposing message text or capability tokens (#95).
- Opt-in `coalesce_pushes` groups up to eight pending pushable messages and 64 KiB into one tmux paste. Each message retains its own delivery state; an oversized head message sends alone (#104, #106).
- Executable MCP tool/result contracts and an Ubuntu stdio round-trip test for two generic SDK clients. The support matrix distinguishes verified client/platform paths from expected behavior (#98, #101, #109).
- Guides for setup, configuration, delivery, federation, and operations; beta issue forms and private security reporting (#105, #111, #114).
- CLI sends with `normal` or `fyi` urgency warn when the local broker predates urgency support. This check does not establish a remote sibling's protocol version (#59).

### Changed

- Repo-scoped discovery groups the main checkout and linked worktrees through a shared Git repository key (#97).
- The broker uses protocol 10, up from protocol 4 in v0.3.0. Package and protocol versions are independent.
- The package manifest is named `claude-peers-mcp` and includes a Bun entry point for stdio MCP and CLI commands. It retains `private: true`; this is preparation for packaging, not a public npm release (#107).
- Ubuntu and native Windows CI exercise their supported suites; POSIX-only integration cases skip on Windows (#54, #56).

### Fixed

- Tmux delivery checks pane readiness and rechecks it in the guarded send. Known shell prompts defer delivery, and persistent deferrals are reported. The guard narrows the probe-to-send race; it does not prove model processing or provide a fully atomic readiness guarantee (#41, #47, #96).
- Repeated failed pushes demote the recipient's queued pushable backlog to polling after the failure cap, allowing the doorbell to announce readable mail instead of leaving it silently stuck (#94).
- Doorbell notifications cover all poll-only delivery paths and wait for readable queue state before signaling (#69).
- Live MCP sessions recover from a stopped broker with bounded, shared recovery and preserve their stored registration when possible. Ambiguous transport failures are not blindly retried (#89).
- Disconnected and stale peers are reaped; delivery confirmation avoids requeuing a completed push solely because its heartbeat aged; prune grace resets after long process stalls (#58).
- Cross-machine sends distinguish pushes from queues and report poll-only, push-eligible, or unknown queue eligibility (#63).
- Invalid discovery scopes and send targets are rejected at the broker boundary (#66).
- Setup instructions now describe the shipped single-host defaults, Bun PATH requirements, and the limits of channels, automatic wakeups, and remote push (#105, #114). Public examples and privacy checks keep private deployment details out of documentation (#37, #112).
- The POSIX installer stops if Bun remains unavailable after installation instead of writing an unusable service definition (#55).

### Upgrading from v0.3.0

Use a coordinated stopped upgrade from protocol 4. The tested mixed-version rolling path is protocol 9 to 10; do not assume arbitrary old and new processes can coexist.

1. Drain important mail and record task outcomes before stopping clients. Unregistering a peer removes its pending mail.
2. Stop the MCP clients and broker, including any supervisor, and back up the stopped database and remaining SQLite sidecars as sensitive data.
3. Update the source checkout to `v0.3.1` and run `bun install --frozen-lockfile`.
4. Start the broker and clients, run `bun cli.ts doctor`, and verify a send/poll round trip. Update federated nodes deliberately and verify both directions.

The schema migrates forward on startup. Rollback requires the old source and its pre-upgrade database copy; running old code against a migrated store is unsupported. A backup does not restore durable session identity.

See the [operations guide](docs/operations.md#upgrading) and [support contract](docs/compatibility.md) for the full limits. Federation remains IP-allowlist based, native Windows has partial coverage and an open SQLite prune issue, and no channel adapter ships.

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

[Unreleased]: https://github.com/jamditis/claude-peers-mcp/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/jamditis/claude-peers-mcp/releases/tag/v0.4.0
[0.3.1]: https://github.com/jamditis/claude-peers-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/jamditis/claude-peers-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/jamditis/claude-peers-mcp/releases/tag/v0.2.0
