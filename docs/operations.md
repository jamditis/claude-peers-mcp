# Operations and troubleshooting

[Documentation index](README.md)

## CLI reference

Run these commands from the source checkout. They use the same config selection as the server. Inspection commands expect an existing broker; they do not auto-start it.

| Command | Effect |
| --- | --- |
| `bun cli.ts status` | Read broker health and list peers. |
| `bun cli.ts peers` | List local and remote peers. |
| `bun cli.ts send <id> [--urgency interrupt\|normal\|fyi] <message>` | Send as an ephemeral peer. Default urgency is `interrupt`, unlike the MCP tool's `normal`. |
| `bun cli.ts doorbell <id> [--since <id>] [--timeout <sec>] [--watch] [--poll-ms <ms>]` | Watch a local marker for poll-only mail. See the [watcher procedure](delivery.md#doorbell-watcher). |
| `bun cli.ts doctor [--json]` | Run read-only broker, store, sibling, peer, and queue diagnostics. |
| `bun cli.ts ping-siblings` | Probe configured sibling brokers and report reachability/latency. |
| `bun cli.ts kill-broker` | Stop the process found listening on the configured port. Uses `netstat` on Windows and `lsof` on POSIX. Use the service manager instead for a supervised broker. |

Quote a multiword CLI message:

```bash
bun cli.ts send <peer-id> --urgency fyi "The review notes are ready."
```

CLI sends register a temporary peer, authenticate with its token, and unregister afterward. That identity is not a persistent reply inbox. Use a client session's MCP tool for a conversation.

The package dispatcher also supports `bun bin/claude-peers-mcp.ts cli status` from a checkout. An installed local package can use `bunx --no-install claude-peers-mcp cli status` from the directory whose `node_modules` contains it. The public npm package is not released; these are not public-registry install instructions.

## Diagnose before restarting

```bash
bun cli.ts doctor
bun cli.ts doctor --json
```

Doctor reads broker health, peer discovery, the SQLite store, process liveness, tmux readiness, and sibling health. It reports an explanation and suggested action for each check. Exit codes are:

| Code | Meaning |
| --- | --- |
| `0` | Clean report. |
| `1` | Warnings, no failures. |
| `2` | At least one failure. |

It does not retire old brokers, consume mail, write the database, or keep an otherwise idle broker alive. It can inspect queue state while the broker is down. Queue diagnostics contain counts and ages rather than message text or capability tokens. Still review reports for private paths and machine names before posting them.

A healthy `/health` response alone does not prove that peer reads, tmux delivery, or queued mail are healthy.

## Troubleshooting

| Symptom | Check and next action |
| --- | --- |
| Server fails with a config error | Check the inherited `CLAUDE_PEERS_CONFIG` path. An explicitly named missing file is an error. A present config needs all six required fields. Use [configuration](configuration.md). |
| No peers appear | Start a second registered client; discovery excludes the caller. Try machine scope. Confirm both processes use the same port/config and that heartbeats are current. Use `peek_messages` for your own ID. |
| A send is queued | Check urgency, whether the recipient has tmux, and the receiving host's remote floor. Queuing is expected for `fyi`, non-tmux clients, and default remote delivery. Poll at the recipient. |
| Mail stays queued in tmux | Use doctor to check the pane and peer process. A bare-shell pane defers push. A normal message waits until due unless another push flushes it sooner. Repeated failed writes can demote the backlog to polling. |
| Peek shows mail but polling returns none | A delivery lease can temporarily block the readable prefix. Use doctor for stalled leases and backend state. Avoid consuming the store manually. |
| The doorbell does not wake the model | Confirm the harness reacts to process completion/output, the watcher uses the correct ID and database path, and it was armed before polling. A standalone watcher does not start a model turn. |
| A session name is ambiguous | Discover peers and send to the exact ID. Multiple panes can share a tmux session name. |
| A peer disappeared after restart | Registrations are tied to live MCP processes. Discover the new ID; old registrations and their mail can be removed. |
| Siblings are missing or return 403 | Check reciprocal sibling entries, source-IP allowlists, private-network/firewall reachability, and the receiving port. Run `ping-siblings` on both hosts. |
| A broker is an older protocol | Doctor reports the mismatch without changing it. Follow the upgrade procedure and restart the relevant processes. |
| Native Windows reports SQLite prune failures | See [#57](https://github.com/jamditis/claude-peers-mcp/issues/57) and the [platform matrix](compatibility.md#client-and-delivery-matrix). Do not treat skipped POSIX tests as Windows end-to-end evidence. |

For a reproducible install, delivery, or federation problem, use the [issue forms](https://github.com/jamditis/claude-peers-mcp/issues/new/choose). Include the commit/version, platform, Bun version, delivery path, expected result, and sanitized diagnostics. Do not attach a database, tokens, private configs, or message contents. Security flaws go through [SECURITY.md](../SECURITY.md).

## Upgrading

Package version and broker protocol are separate. The current broker protocol is 10; the supported mixed-version path from 9 to 10 is described in the [compatibility contract](compatibility.md#protocol-and-upgrade-rules).

For a source checkout:

```bash
git pull --ff-only
bun install --frozen-lockfile
```

A running process keeps its loaded code. Restart the MCP client/server to load server changes. When the new server finds an older-protocol local broker, it asks that broker to retire and starts a current one. A same-protocol code change does not force replacement of an already-running broker.

For an operator-managed upgrade:

1. Read the changelog and supported migration path. Drain important mail or record its outcome before ending client sessions.
2. Stop the clients and stop the broker through its supervisor, if present. Confirm it stays stopped.
3. Back up the stopped database and any remaining SQLite `-wal` and `-shm` sidecars together. Protect the copy as sensitive data. Live backup is not a supported beta path.
4. Update the checkout and locked dependencies, then start the upgraded broker and clients.
5. Run doctor and verify a local send/poll round trip. For federation, verify both directions and check each receiving broker's version.

Stopping clients can unregister peers and remove their pending mail. A database backup is not a supported way to resurrect an old session inbox. Coordinate the interruption before stopping active sessions.

Only keep old and new processes mixed for a transition with named compatibility tests. Protocol/schema downgrades are unsupported: rollback requires the old binary and its pre-upgrade database copy, not the migrated store.

For legacy remote nodes predating protocol 4, `normal` and `fyi` can be ignored and pushed immediately. Upgrade the receiving broker before relying on quiet delivery. The local CLI warning does not establish a remote sibling's protocol.

### Legacy token migration

`CLAUDE_PEERS_ALLOW_UNSIGNED=1` exists for a rolling migration from pre-protocol-3 registrations. It accepts a missing token only for an existing row with a null token. A wrong token, unknown principal, or missing token on an authenticated row still fails.

If maintaining that historical migration, use the flag only during cutover, restart the old MCP servers so they register with tokens, then restart the broker without it. Fresh installs do not need it. It is not a general fix for authorization errors or a promise of arbitrary old-version compatibility.

## Identity and retention

The queue belongs to live peer registrations:

- MCP servers heartbeat every 15 seconds. A local peer becomes stale after 45 seconds, with another 45-second prune grace by default. A dead process can be removed sooner.
- A broker restart using the same store can preserve a live server's ID and queued mail. A new MCP server registration receives a new identity.
- Remote advertisements expire after 30 seconds without refresh.
- Settled messages are pruned after 60 seconds; queued messages have a lossy 24-hour backstop.
- Removing a peer removes its mail. Friendly names do not make that mail durable.

Store important decisions or task results somewhere durable and use peer messages to coordinate them. See the [delivery contract](compatibility.md#delivery-terms) for the difference between transport settlement and model processing.
