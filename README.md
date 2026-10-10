# claude-peers

[![CI](https://github.com/jamditis/claude-peers-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jamditis/claude-peers-mcp/actions/workflows/ci.yml)

Peer discovery and messaging for MCP client sessions. Find another session, see what it is working on, and send it a message across projects, Git worktrees, or machines.

Each client runs a stdio MCP server connected to a local broker. The broker stores messages in SQLite and either queues them for the recipient to read or pushes them into a ready tmux pane. Optional federation connects brokers on a trusted private network.

**Current status:** Source-checkout installation. The package manifest is `0.4.0` with `private: true`; the npm public beta is not released. Bun is required. Claude Code is the primary exercised client; other clients and platforms have different levels of evidence in the [support matrix](docs/compatibility.md#client-and-delivery-matrix).

## Quick start

You need [Bun](https://bun.sh), Git, and Claude Code or another stdio MCP client. tmux is optional and provides push delivery on POSIX systems. Native Windows uses polling.

### Install from source

On Linux or macOS:

```bash
git clone https://github.com/jamditis/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install --frozen-lockfile
claude mcp add --scope user --transport stdio claude-peers -- bun "$HOME/claude-peers-mcp/server.ts"
```

On Windows, use PowerShell:

```powershell
git clone https://github.com/jamditis/claude-peers-mcp.git "$env:USERPROFILE\claude-peers-mcp"
Set-Location "$env:USERPROFILE\claude-peers-mcp"
bun install --frozen-lockfile
claude mcp add --scope user --transport stdio claude-peers -- bun "$env:USERPROFILE\claude-peers-mcp\server.ts"
```

Change the paths if you clone elsewhere. The registration uses an absolute server path so it works from other projects. Bun must be on the client process's `PATH` for automatic broker startup. An absolute Bun executable path can launch the MCP server, but the server still starts the broker by running `bun` from that inherited `PATH`. Restart your terminal or client after installing Bun so it receives the updated environment.

For a different MCP client, configure a stdio server with `command: "bun"` and `args: ["/absolute/path/to/claude-peers-mcp/server.ts"]`. See [client setup](docs/getting-started.md#other-mcp-clients) for a JSON example and support limits.

Claude Code channels are unsupported/planned: This package has no channel adapter. Use stdio MCP without channel flags.

### Start two sessions

Start two new Claude Code sessions in separate terminals:

```bash
claude
```

The first session starts the broker automatically. With no `~/.claude-peers.json` and no `CLAUDE_PEERS_CONFIG` override, it uses port `7899`, a local database, and a loopback-only allowlist. No config file is needed.

Ask the first session:

> List peers with machine scope, then send the other peer "Can you review the current diff?" with normal urgency.

Ask the second session:

> Check peer messages.

Have it reply with the claude-peers `send_message` tool. In Claude Code, this is separate from the built-in `SendMessage` team tool.

`normal` messages queue first. A ready tmux recipient becomes eligible for push after two minutes by default; a recipient without tmux must call `check_messages`. A successful send reports transport state and does not guarantee a reply.

For push delivery, start Claude inside tmux on a POSIX host:

```bash
tmux new -s work
claude
```

Use `interrupt` urgency when a message should be eligible for immediate push. `fyi` and default-floored remote messages remain poll-only even in tmux. See [delivery and the doorbell](docs/delivery.md).

## Tools

| Tool | Purpose |
| --- | --- |
| `list_peers` | Discover sessions by `machine`, `directory`, or `repo` scope. Machine scope includes federated peers; repo scope groups a checkout and its linked worktrees. |
| `send_message` | Send to a peer ID or an unambiguous session name. Optional urgency is `normal` by default, `interrupt`, or `fyi`. |
| `set_summary` | Advertise a short description of your current work. Replaces the initial Git-derived summary. |
| `check_messages` | Read pending, readable mail and remove the returned messages from the pending queue. |
| `peek_messages` | Get your peer ID, pending count, highest pending message ID, and a session-owned doorbell launch recipe without consuming mail. Call at startup and after a mail signal; [host integration is required](docs/delivery.md#session-startup-handoff). |

Peer IDs belong to live MCP registrations. Restarting a client can produce a new ID; use discovery again before addressing it. Names are convenient labels, and duplicate names require an ID.

## Documentation

| Guide | Use it for |
| --- | --- |
| [Getting started](docs/getting-started.md) | Client setup, Windows notes, session names, and a first-message walkthrough. |
| [Configuration](docs/configuration.md) | All config fields, defaults, environment variables, and path precedence. |
| [Delivery](docs/delivery.md) | Urgency, tmux, polling, the doorbell watcher, batching, and delivery guarantees. |
| [Federation](docs/federation.md) | Connecting machines, allowlists, remote push, and deployment templates. |
| [Operations](docs/operations.md) | CLI commands, diagnostics, upgrades, retention, and troubleshooting. |
| [Compatibility and support](docs/compatibility.md) | Tested client/platform paths, public contracts, and beta release gates. |
| [Contributing](CONTRIBUTING.md) | Development setup, tests, CI, and repository conventions. |

The [documentation index](docs/README.md) also separates current guides from historical designs and plans.

## Configuration

Use a config file to change the port, identity, database, or federation settings. See the [configuration reference](docs/configuration.md) for required fields and environment precedence.

`CLAUDE_PEERS_PORT` is a CLI-only fallback: `cli.ts` consults it only when config loading throws and config is null. The normal zero-config default remains port `7899`. Set the config's `port` field to change the broker and MCP server port.

## Security / authentication

Local session mutations use per-session capability tokens. Federation currently relies on source-IP allowlists and remains an experimental security boundary. Leave `floor_remote_forwards` enabled unless you deliberately want trusted remote brokers to push into local panes.

The broker listens on `0.0.0.0`; the default single-host isolation comes from its request allowlist, not a loopback-only socket bind. Control-plane POST routes require a loopback caller. Keep the port on a trusted private network and protect the database, which contains tokens and message text.

See [federation security](docs/federation.md#security-boundary) for the remaining impersonation limits. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Upgrading

The broker protocol is currently `10`; it is separate from the package version.

From your checkout, pull the current source and install its locked dependencies:

```bash
git pull --ff-only
bun install --frozen-lockfile
```

Restart the MCP client/server to load changed code. A new MCP server retires an older-protocol broker automatically; a same-protocol update may require an explicit broker restart. For a running deployment, follow the [upgrade procedure](docs/operations.md#upgrading), including a stopped-database backup before migrations.

## Development

```bash
bun run typecheck
bun run lint
bun run check:docs:privacy
bun test
```

CI runs these checks on Ubuntu and Windows for pull requests and pushes to `main`. POSIX integration suites skip on Windows. CodeQL runs separately. See [Contributing](CONTRIBUTING.md) for details.

## Project boundary and roadmap

This repository owns the reusable broker, protocol, MCP tools, and generic deployment examples. Machine-specific configuration, service overrides, credentials, and personal automation belong outside the public core.

[Decision 0001](docs/decisions/0001-package-and-personal-deployment-boundary.md) defines that boundary. [Roadmap #85](https://github.com/jamditis/claude-peers-mcp/issues/85) tracks package and release gates; the [project board](https://github.com/users/jamditis/projects/27) tracks current work. Use the [issue forms](https://github.com/jamditis/claude-peers-mcp/issues/new/choose) for install, delivery, and federation reports.

## Credits

Forked from [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp), which introduced peer discovery and messaging for Claude Code. This fork adds broker-side tmux delivery, per-session capability tokens, federation, diagnostics, and delivery recovery.

[MIT license](LICENSE).
