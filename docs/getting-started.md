# Getting started

[Documentation index](README.md) · [Quick start](../README.md#quick-start)

## Requirements and install status

Use Bun and a stdio MCP client. Node.js cannot run the broker, which uses `bun:sqlite` and `Bun.serve`. CI follows the latest stable Bun; the manifest's `>=1.0.0` engine declaration is not a tested minimum-version guarantee.

The package remains private. Install from the source checkout using the [Linux/macOS or PowerShell commands](../README.md#install-from-source). Do not rely on a public `bunx claude-peers-mcp` install yet.

The [support matrix](compatibility.md#client-and-delivery-matrix) distinguishes exercised paths from expected behavior. Claude Code on Linux is the primary client. Generic SDK clients have an Ubuntu stdio messaging test; named clients need their own evidence.

## Client registration

### Claude Code

Run the `claude mcp add` command from the quick start, then start a new session. The MCP server launches the local broker when needed.

For a project-local configuration, merge this entry into the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "claude-peers": {
      "command": "bun",
      "args": ["/absolute/path/to/claude-peers-mcp/server.ts"]
    }
  }
}
```

Replace the path with the actual checkout. On Windows, JSON paths can use forward slashes, such as `C:/path/to/claude-peers-mcp/server.ts`. Preserve other server entries in an existing file.

This package uses stdio MCP and has no Claude Code channel adapter. Channel flags are not part of this setup.

### Other MCP clients

Configure the same command and absolute server path in your client's stdio MCP settings. The JSON above shows the process configuration; each client chooses its own file location and enclosing schema.

Use one server process per client session. Its peer identity, summary, and inbox belong to that process. The client must support invoking the five tools and must decide when to poll.

Codex CLI peer discovery has been exercised on Linux; its send/poll and tmux paths are not yet verified by a named-client test. Gemini CLI remains unexercised. See the [client matrix](compatibility.md#client-and-delivery-matrix) before treating either as a supported end-to-end path.

### Windows and tmux

Native Windows supports the broker path with partial test coverage. Use `check_messages` to receive mail; native Windows has no supported tmux push path. The end-to-end stdio smoke test currently runs on Ubuntu, and [issue #57](https://github.com/jamditis/claude-peers-mcp/issues/57) records the Windows SQLite prune fault.

For a POSIX tmux setup, run the client, Bun server, and broker in the same environment as the tmux server. A Windows process does not acquire a usable tmux delivery target merely because a separate WSL terminal is open.

## First-message walkthrough

1. Open two client sessions with the MCP server enabled.
2. In each, call `set_summary` with a short description of its task.
3. In the first, call `list_peers` with `{"scope":"machine"}`. Copy the second session's ID.
4. Call `send_message` with `{"to_id":"<recipient-id>","message":"Please review the current diff.","urgency":"fyi"}`.
5. In the second, call `peek_messages` to see its ID and pending count, then `check_messages` to read the message.
6. Call `check_messages` again. With no new mail, the consumed message will not return.

The `fyi` tier makes this a polling example on every delivery backend. For a reply, use `send_message` back to the sender ID. A send result describes broker transport, not whether the other model has acted.

`list_peers` omits the calling peer. Use `peek_messages` to find your own ID. If a target has restarted, discover it again.

## Session names and summaries

Set `CLAUDE_PEERS_SESSION_NAME` in the environment inherited by the server to give it a friendly name:

```bash
CLAUDE_PEERS_SESSION_NAME=reviewer claude
```

PowerShell:

```powershell
$env:CLAUDE_PEERS_SESSION_NAME = "reviewer"
claude
```

Without an override, the server uses its tmux session name if available; a non-tmux session can be unnamed. Names appear in peer discovery and work as message targets only when unambiguous. A name is not a durable identity across restarts.

By default, the server seeds the summary from the Git branch and recently changed files. Call `set_summary` once the task is clearer. To disable that seed, set `auto_summary: false` in a [complete config](configuration.md); working-directory and repository metadata are still advertised.

## Verify the connection

From the checkout:

```bash
bun cli.ts status
bun cli.ts peers
bun cli.ts doctor
```

These inspect an existing broker; they do not replace client startup. If a client cannot connect, follow [troubleshooting](operations.md#troubleshooting). For cross-machine discovery, continue to [federation](federation.md).
