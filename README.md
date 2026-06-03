# claude-peers

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
git clone https://github.com/louislva/claude-peers-mcp.git ~/claude-peers-mcp   # or wherever you like
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

Delivery is tracked per message with a short-lived lease (`queued` → `delivering` → `delivered`): a push is only marked delivered after `tmux` confirms it, so a failed or interrupted attempt leaves the message queued rather than silently lost. The broker speaks protocol version 2; an MCP server that finds an older broker running asks it to retire and starts a current one.

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

## Configuration

| Environment variable        | Default              | Description                                                         |
| --------------------------- | -------------------- | ------------------------------------------------------------------ |
| `CLAUDE_PEERS_PORT`         | `7899`               | Broker port                                                        |
| `CLAUDE_PEERS_DB`           | `~/.claude-peers.db` | SQLite database path                                              |
| `CLAUDE_PEERS_IDLE_EXIT_MS` | `0` (disabled)       | If > 0, an idle broker with no peers self-exits after this many ms. The auto-launched broker sets 10 min so it reaps itself; a supervised (systemd) broker leaves it 0 so it never restart-loops. |
| `OPENAI_API_KEY`            | —                    | Enables auto-summary via gpt-5.4-nano                              |

**`floor_remote_forwards`** (config-file boolean, default `false`): when `true`, a message forwarded from a sibling broker on another machine is left queued for `check_messages` rather than pushed into your live session. Local peers can still push; only cross-machine forwards are floored. Use it if you don't want remote machines typing into your panes.

## Requirements

- [Bun](https://bun.sh)
- Claude Code
- `tmux` — only needed for live push delivery into a session. Without it, messaging still works through `check_messages`.
