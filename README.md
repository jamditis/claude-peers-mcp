# claude-peers

[![CI](https://github.com/jamditis/claude-peers-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jamditis/claude-peers-mcp/actions/workflows/ci.yml)

Let your Claude Code instances find each other and talk. When you're running several sessions across different projects — or across several machines — any Claude can discover the others and send messages that get typed straight into the recipient's session.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: what files │          │ message arrives in   │
  │  are you editing?"    │  <────── │  the session,        │
  │                       │          │  Claude B responds   │
  └───────────────────────┘          └──────────────────────┘
```

## Quick start

### 1. Install

```bash
git clone https://github.com/jamditis/claude-peers-mcp.git ~/claude-peers-mcp   # or wherever you like
cd ~/claude-peers-mcp
bun install
```

### 2. Create a config file

The broker and MCP server read their settings from a JSON config file, not from environment variables. Without it, the first `claude` session fails at startup with `Config file not found`. Create `~/.claude-peers.json` with a minimal single-host config:

```json
{
  "machine": "my-laptop",
  "tailscale_ip": "127.0.0.1",
  "port": 7899,
  "id_prefix": "local",
  "siblings": [],
  "allowed_ips": ["127.0.0.1"]
}
```

All six fields shown are required. `siblings: []` and `allowed_ips: ["127.0.0.1"]` keep everything on one machine — see [Multi-machine setup](#multi-machine-setup) to federate across hosts. The default path is `~/.claude-peers.json`; override it with `CLAUDE_PEERS_CONFIG`. See [Configuration](#configuration) for the full field reference. (A future single-host default that removes this step is tracked as [issue #21](https://github.com/jamditis/claude-peers-mcp/issues/21).)

### 3. Register the MCP server

This makes claude-peers available in every Claude Code session, from any directory:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

Replace `~/claude-peers-mcp` with wherever you cloned it.

### 4. Run Claude Code (use tmux for live delivery)

Once a config file exists, start Claude Code normally — the broker daemon launches automatically the first time, and no special channel flags are needed:

```bash
claude
```

For messages to be **pushed into your session the moment they arrive**, run Claude inside a tmux pane — the broker types each incoming message straight into the pane:

```bash
tmux new -s work    # then run `claude` inside it
```

Outside tmux everything still works; you just read incoming messages with `check_messages` instead of having them pushed.

### 5. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo`. With `machine` scope, remote peers from federated nodes are included and tagged `[remote]`. |
| `send_message`   | Send a message to another instance by ID. `urgency` picks the delivery tier: `interrupt` pushes into their tmux session now; `normal` (the tool default) queues until they poll or the push deadline passes; `fyi` is poll-only, no reply expected. Cross-machine targets route automatically to the owning broker. |
| `set_summary`    | Describe what you're working on (visible to other peers). The summary starts as an auto-generated git snapshot (`[auto] <branch>; recent: <files>`) seeded at registration; this tool overwrites it. |
| `check_messages` | Read and clear messages that were queued instead of pushed. A poll marks the returned messages delivered, so a second call won't re-return them. |

## How it works

A **broker daemon** runs on port `7899` (set by the config file's `port` field) with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker, reporting its tmux pane (if any) as a delivery target. When a message is sent, the broker delivers it straight into the recipient's pane by typing it in (a bracketed-paste write via `tmux send-keys`), so the other Claude sees it as if it were typed at the prompt. A session with no tmux pane keeps its messages queued for `check_messages`.

Not every message interrupts the recipient. Each message carries an **urgency tier** that maps to a `push_after` deadline: `interrupt` is push-due immediately; `normal` waits `push_delay_ms` (default 2 minutes) so the recipient can drain it cheaply via `check_messages` at a task boundary first — if the deadline lapses, the recipient's next heartbeat pushes it; `fyi` never auto-pushes (`push_after` NULL) and is only ever returned by a poll. When one row comes due, the broker promotes the recipient's other pending pushable rows so they ride the same flush instead of interrupting again later. Never-push rows sit outside the push channel entirely, so an `fyi` can't jam pushable mail behind it (FIFO holds within each channel, push vs poll, not across them).

Delivery is tracked per message with a short-lived lease (`queued` → `delivering` → `delivered`): the broker claims the head-of-line message (FIFO — newer mail never overtakes older), injects it, then re-probes the recipient's liveness before confirming, because a `0` exit from `send-keys` doesn't prove a live Claude consumed it. A failed or interrupted attempt releases the lease back to `queued` rather than dropping the message; expired leases and rows orphaned by a broker restart are reclaimed automatically. The broker and MCP server negotiate a protocol version (currently `4`); an MCP server that finds an older broker running asks it to retire and starts a current one.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  port 7899 + SQLite       │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

The broker auto-launches when the first session starts and cleans up dead peers automatically. The control plane is loopback-only: every route except the two federation routes (`/gossip`, `/forward-message`) rejects non-localhost callers. Same-machine delivery never leaves localhost. Cross-machine messaging is opt-in — see [Multi-machine setup](#multi-machine-setup).

## Security / authentication

The control plane is authenticated per session. When a Claude Code session registers, the broker mints a 256-bit capability token, stores it on that peer's row, and returns it in the register response. The MCP server holds that token for its lifetime and presents it as `Authorization: Bearer <token>` on every mutating control-plane call (`send_message`, `set_summary`, heartbeats, unregister, message polling).

The broker binds each call to its principal: `from_id` for `/send-message`, `id` for the rest. A call must present the token that matches that principal or it gets a `401`. So a local process can no longer forge another peer's `from_id` to drive a message — and the tmux-pane injection that rides on it — into that peer's session: the forged id looks up the wrong token and fails the gate. (Before this, the broker trusted `from_id` outright.)

`/list-peers` is read-only and token-exempt, but it strips the token column from its output so the secret is never serialized to a caller. The federation routes (`/gossip`, `/forward-message`) are also token-exempt — tokens never cross a machine boundary — and stay gated only by the source-IP allowlist. On a single host that allowlist must include `127.0.0.1`, so a local process can still reach a federation route to queue a forged-sender message without a token; that residual is tracked as [issue #15](https://github.com/jamditis/claude-peers-mcp/issues/15) and is mitigated today by `floor_remote_forwards` defaulting true (a forward only queues — it never auto-pastes into a pane). Full cross-machine federation auth is [issue #4](https://github.com/jamditis/claude-peers-mcp/issues/4).

To neutralize bracketed-paste escape injection, the broker strips C0/C1 control characters (including `ESC` and the C1 CSI byte) from every message body before it reaches a pane.

## Upgrading a live broker to v3

v3 is the protocol that added the capability token. A fresh install gets it with no action — every v3 server mints and presents a token. The care is only for rolling a broker that already has **running** pre-v3 sessions: those registered before the token column existed, so their rows carry a `NULL` token and they present no `Authorization` header. A plain v3 broker would `401` their next heartbeat.

`CLAUDE_PEERS_ALLOW_UNSIGNED=1` is the cutover grace flag. Its semantics are narrow on purpose:

- it accepts a **missing** token only for a genuine pre-v3 row whose token is still `NULL`;
- a **wrong** token always `401`s, even under the flag (active forgery is never graced);
- a principal that has already minted a token must always present it — the grace never re-opens forgery for an authenticated peer.

Roll sequence:

1. Start the new v3 broker with `CLAUDE_PEERS_ALLOW_UNSIGNED=1` so existing tokenless sessions keep working.
2. Let each live session re-register (restarting its MCP server is enough) — it then mints and stores a token.
3. Once every session has re-registered, restart the broker **without** the flag to close the grace window.

## Multi-machine setup

Each machine runs its own broker. Brokers gossip their local peer lists to their configured siblings over Tailscale every few seconds; a peer registered on one node becomes visible (tagged `[remote]`) in `list_peers` on the others, and a message addressed to a remote peer is forwarded to that peer's owning broker. Machine-name matching is case-insensitive, so casing drift between independently-edited config files won't break routing.

To federate, give each node a config that lists the others as `siblings` and allows their IPs:

```json
{
  "machine": "host-b",
  "tailscale_ip": "100.64.0.2",
  "port": 7899,
  "id_prefix": "ofj",
  "siblings": [
    { "machine": "host-a", "url": "http://100.64.0.1:7899" },
    { "machine": "host-c",  "url": "http://100.64.0.3:7899" }
  ],
  "allowed_ips": ["127.0.0.1", "100.64.0.1", "100.64.0.3"]
}
```

Each node lists the other nodes under `siblings` and puts those nodes' IPs (plus `127.0.0.1`) in `allowed_ips`, so brokers accept each other's gossip and forwards. The allowlists must be symmetric. Per-host example configs live in [`deploy/configs/`](deploy/configs/).

By default a forward arriving from another machine is left queued for `check_messages` rather than auto-pasted into your live pane (`floor_remote_forwards`, see [Configuration](#configuration)) — a remote machine cannot type into your session until you opt in. The residual federation-auth gaps are tracked as [issue #15](https://github.com/jamditis/claude-peers-mcp/issues/15) and [issue #4](https://github.com/jamditis/claude-peers-mcp/issues/4).

For a long-lived federated node, run the broker under a supervisor so it never idles out. [`deploy/install.sh`](deploy/install.sh) installs against the per-machine config files; [`deploy/claude-peers-broker.service`](deploy/) is a sample systemd unit. It hard-codes the maintainer's layout (`User=peer`, `HOME=/home/peer`, and the `broker.ts` path under `/home/peer/projects/`), so edit those for your own account and clone location before enabling it on any other host — otherwise the service starts under the wrong user or fails outright. A supervised broker sets `CLAUDE_PEERS_IDLE_EXIT_MS=0` so it never self-exits and restart-loops. On Windows, [`deploy/install-host-d-broker-task.ps1`](deploy/) registers the equivalent Task Scheduler entry. (Note: the tmux delivery path is POSIX-oriented today, but native Windows broker spawn and a Windows `kill-broker` landed via [PR #19](https://github.com/jamditis/claude-peers-mcp/pull/19), merged 2026-06-04.)

## CLI

You can also inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status            # broker status + all peers (local and remote)
bun cli.ts peers             # list peers
bun cli.ts send <id> [--urgency interrupt|normal|fyi] <msg>   # send a message into a Claude session (default: interrupt)
bun cli.ts ping-siblings     # ping each configured sibling broker, report latency
bun cli.ts kill-broker       # stop the broker
```

`bun cli.ts send` is authenticated like any other session: it registers a short-lived, queued-only ephemeral peer (no tmux pane, so it is never a delivery target) to obtain a capability token, sends under that identity, and unregisters automatically in a `finally`. It does not bypass the token gate. (The `cli.ts kill-broker` command locates the broker process via `netstat -ano` on Windows and `lsof` elsewhere, so it works on both ([PR #19](https://github.com/jamditis/claude-peers-mcp/pull/19)); a supervised broker is better stopped through its service or Task Scheduler entry.)

## Configuration

### Config-file fields

These live in `~/.claude-peers.json` (or the path in `CLAUDE_PEERS_CONFIG`). The first six are required; the broker and MCP server read `port`, `machine`, and the federation settings from here, not from environment variables.

| Field                   | Required | Description                                                                                  |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `machine`               | yes      | This node's name. Used to tag peers and to match siblings (matched case-insensitively).      |
| `tailscale_ip`          | yes      | This node's reachable IP. Use `127.0.0.1` for a single-host setup.                            |
| `port`                  | yes      | Broker port. `7899` by convention.                                                           |
| `id_prefix`             | yes      | Prefix for the peer IDs this node mints.                                                      |
| `siblings`              | yes      | Array of `{ "machine": "<name>", "url": "http://<ip>:<port>" }` for federated nodes. `[]` for single-host. |
| `allowed_ips`           | yes      | Source IPs allowed to reach the federation routes. Include `127.0.0.1`; add each sibling's IP to federate. |
| `db_path`               | no       | SQLite database path. Falls back to `CLAUDE_PEERS_DB`, then `~/.claude-peers.db`.             |
| `floor_remote_forwards` | no       | Default `true`. A message forwarded from a sibling broker is left queued for `check_messages` rather than pushed into your live pane (its `push_after` is NULL, so neither the immediate inject nor a later heartbeat drain or flush can auto-paste it). Set `false` to opt in to cross-node push. Local same-machine peers always push. This is the secure default — a remote machine can't auto-paste into your session unless you opt in, because the federation routes are authenticated only by the source-IP allowlist ([issue #15](https://github.com/jamditis/claude-peers-mcp/issues/15), [issue #4](https://github.com/jamditis/claude-peers-mcp/issues/4)). |
| `push_delay_ms`         | no       | Default `120000` (2 minutes). How long a `normal`-urgency message stays queued before the broker pushes it anyway. The window gives the recipient a chance to drain it via `check_messages` at a task boundary — the cheap path that doesn't interrupt their session. |
| `auto_summary`          | no       | Default `true`. Seed each session's summary at registration from git state (`[auto] <branch>; recent: <files>`). Summaries gossip to sibling brokers like `cwd` and `git_root` already do; set `false` to keep summaries empty until a session calls `set_summary`. |

`~/.claude-peers.json` and the SQLite database are gitignored — the database holds per-session capability tokens, so it must never be committed.

### Environment variables

| Environment variable          | Default              | Description                                                                            |
| ----------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `CLAUDE_PEERS_CONFIG`         | `~/.claude-peers.json` | Overrides the config-file location.                                                  |
| `CLAUDE_PEERS_DB`             | `~/.claude-peers.db` | SQLite database path. Overrides the config file's `db_path`.                            |
| `CLAUDE_PEERS_IDLE_EXIT_MS`   | `0` (disabled)       | If `> 0`, an idle broker with no peers self-exits after this many ms. The auto-launched broker sets 10 min so it reaps itself; a supervised (systemd) broker leaves it `0` so it never restart-loops. |
| `CLAUDE_PEERS_ALLOW_UNSIGNED` | unset (`0`)          | Upgrade-window grace for rolling a live broker to v3. When `1`, the broker accepts a missing token only for a pre-v3 NULL-token peer row; a wrong token still `401`s. See [Upgrading a live broker to v3](#upgrading-a-live-broker-to-v3). Leave unset on steady-state brokers. |
| `CLAUDE_PEERS_PORT`           | `7899`               | CLI-only fallback. The broker and MCP server take the port from the config file's `port`; this is read by `cli.ts` only when no config file loads. |

## Requirements

- [Bun](https://bun.sh)
- Claude Code
- `tmux` — only needed for live push delivery into a session. Without it, messaging still works through `check_messages`.

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome lint --error-on-warnings .
bun test            # the test suite
```

CI runs all three on every push and pull request, plus a CodeQL security scan, and treats them as required checks. The Biome formatter is left off on purpose so adopting the linter doesn't reflow the tree. The test suite is POSIX-only — it shells out to `tmux` — so on Windows `bun test` won't pass even though the broker itself runs there ([issue #22](https://github.com/jamditis/claude-peers-mcp/issues/22)).

## Credits

Forked from [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp), which introduced peer discovery and messaging for Claude Code. This fork adds broker-side delivery: messages are typed straight into the recipient's tmux pane through a lease state machine, so a peer message arrives in a running session instead of waiting for a manual `check_messages`. It also adds per-session capability-token auth, cross-machine federation over Tailscale, and a CI/CodeQL/lint gate.
