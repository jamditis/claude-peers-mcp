# claude-peers

[![CI](https://github.com/jamditis/claude-peers-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jamditis/claude-peers-mcp/actions/workflows/ci.yml)

Continuous integration runs typecheck, lint, and tests on every push and pull request.

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others and send messages that arrive instantly.

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

### 2. Register the MCP server

This makes claude-peers available in every Claude Code session, from any directory:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

Replace `~/claude-peers-mcp` with wherever you cloned it.

### 3. Run Claude Code (use tmux for live delivery)

Just start Claude Code normally — the broker daemon launches automatically the first time, and no special channel flags are needed:

```bash
claude
```

For messages to be **pushed into your session the moment they arrive**, run Claude inside a tmux pane — the broker types each incoming message straight into the pane:

```bash
tmux new -s work    # then run `claude` inside it
```

Outside tmux everything still works; you just read incoming messages with `check_messages` instead of having them pushed.

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message to another instance by ID (pushed into their tmux session, else queued) |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Read messages that were queued instead of pushed (non-tmux sessions)           |

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker, reporting its tmux pane (if any) as a delivery target. When a message is sent, the broker delivers it straight into the recipient's pane by typing it in (a bracketed-paste write via `tmux send-keys`), so the other Claude sees it as if it were typed at the prompt. A session with no tmux pane keeps its messages queued for `check_messages`.

Delivery is tracked per message with a short-lived lease (`queued` → `delivering` → `delivered`): a push is only marked delivered after `tmux` confirms it, so a failed or interrupted attempt leaves the message queued rather than silently lost. The broker and MCP server negotiate a protocol version (currently 3); an MCP server that finds an older broker running asks it to retire and starts a current one.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

The broker auto-launches when the first session starts. It cleans up dead peers automatically. Everything is localhost-only.

## Security / authentication

The control plane is authenticated per session. When a Claude Code session registers, the broker mints a 256-bit capability token, stores it on that peer's row, and returns it in the register response. The MCP server holds that token for its lifetime and presents it as `Authorization: Bearer <token>` on every mutating control-plane call (`send_message`, `set_summary`, heartbeats, unregister, message polling).

The broker binds each call to its principal: `from_id` for `/send-message`, `id` for the rest. A call must present the token that matches that principal or it gets a `401`. So a local process can no longer forge another peer's `from_id` to drive a message — and the tmux-pane injection that rides on it — into that peer's session: the forged id looks up the wrong token and fails the gate. (Before this, the broker trusted `from_id` outright.)

`/list-peers` is read-only and token-exempt, but it strips the token column from its output so the secret is never serialized to a caller. The federation routes (`/gossip`, `/forward-message`) are also token-exempt — tokens never cross a machine boundary — and stay gated only by the source-IP allowlist. On a single host that allowlist must include `127.0.0.1`, so a local process can still reach a federation route to queue a forged-sender message without a token; that residual is tracked as [issue #15](https://github.com/jamditis/claude-peers-mcp/issues/15) and is mitigated today by `floor_remote_forwards` defaulting true (a forward only queues — it never auto-pastes into a pane). Full cross-machine federation auth is [issue #4](https://github.com/jamditis/claude-peers-mcp/issues/4).

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

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## CLI

You can also inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts kill-broker       # stop the broker
```

`bun cli.ts send` is authenticated like any other session: it registers a short-lived, queued-only ephemeral peer (no tmux pane, so it is never a delivery target) to obtain a capability token, sends under that identity, and unregisters automatically in a `finally`. It does not bypass the token gate.

## Configuration

| Environment variable        | Default              | Description                                                         |
| --------------------------- | -------------------- | ------------------------------------------------------------------ |
| `CLAUDE_PEERS_PORT`         | `7899`               | Broker port                                                        |
| `CLAUDE_PEERS_DB`           | `~/.claude-peers.db` | SQLite database path                                              |
| `CLAUDE_PEERS_IDLE_EXIT_MS` | `0` (disabled)       | If > 0, an idle broker with no peers self-exits after this many ms. The auto-launched broker sets 10 min so it reaps itself; a supervised (systemd) broker leaves it 0 so it never restart-loops. |
| `CLAUDE_PEERS_ALLOW_UNSIGNED` | unset (`0`)        | Upgrade-window grace for rolling a live broker to v3. When `1`, the broker accepts a missing token only for a pre-v3 NULL-token peer row; a wrong token still `401`s. See "Upgrading a live broker to v3". Leave unset on steady-state brokers. |
| `OPENAI_API_KEY`            | —                    | Enables auto-summary via gpt-5.4-nano                              |

**`floor_remote_forwards`** (config-file boolean, default `true`): a message forwarded from a sibling broker on another machine is left queued for `check_messages` rather than pushed into your live session. Local same-machine peers still push into panes; only cross-machine forwards are floored. This is the secure default — a remote machine cannot auto-paste into your live session unless you opt in. To enable cross-node push, set it `false` explicitly. The per-session token gate (see "Security / authentication") covers the local control plane, but the federation routes stay token-exempt and authenticated only by the source-IP allowlist, so push-by-default would let any allowlisted sibling type a peer-attributed line into every local pane. The residual loopback-federation reachability is [issue #15](https://github.com/jamditis/claude-peers-mcp/issues/15); full cross-machine federation auth is [issue #4](https://github.com/jamditis/claude-peers-mcp/issues/4).

## Requirements

- [Bun](https://bun.sh)
- Claude Code
- `tmux` — only needed for live push delivery into a session. Without it, messaging still works through `check_messages`.

## Credits

Forked from [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp), which introduced peer discovery and messaging for Claude Code. This fork adds broker-side delivery: messages are typed straight into the recipient's tmux pane through a lease state machine, so a peer message arrives in a running session instead of waiting for a manual `check_messages`.
