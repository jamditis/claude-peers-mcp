# Configuration

[Documentation index](README.md)

## Choose a config

The broker and MCP server load configuration at startup:

1. Use the file named by `CLAUDE_PEERS_CONFIG`, if set. A missing file is an error.
2. Otherwise, read `~/.claude-peers.json` if it exists.
3. If that default file is absent, use the single-host defaults.

A present but unreadable, malformed, or incomplete file fails startup. It does not silently fall back to a different configuration.

The single-host default uses the computer's hostname, a prefix derived from its first three normalized alphanumeric characters (or `peer` if empty), port `7899`, no siblings, and `allowed_ips: ["127.0.0.1"]`. The default database is `~/.claude-peers.db`.

The HTTP listener binds to `0.0.0.0`. Single-host access is restricted by the loopback-only request allowlist. `tailscale_ip` is advertised metadata, not a bind-address setting.

To customize a host, create a complete JSON config:

```json
{
  "machine": "my-laptop",
  "tailscale_ip": "127.0.0.1",
  "port": 7899,
  "id_prefix": "lap",
  "siblings": [],
  "allowed_ips": ["127.0.0.1"]
}
```

Use an absolute `CLAUDE_PEERS_CONFIG` path, especially when the broker, clients, and CLI start from different directories. Restart the broker and MCP servers after changing their configuration; there is no live reload. Use [the operations guide](operations.md#upgrading) to coordinate restarts on a busy host.

## Config fields

The first six fields are required whenever a config file is present.

| Field | Default without a file | Meaning |
| --- | --- | --- |
| `machine` | Hostname | Node name. Sibling routing compares machine names case-insensitively. |
| `tailscale_ip` | `127.0.0.1` | This node's advertised reachable address. |
| `port` | `7899` | Broker HTTP port. The local server and CLI must use the same port. |
| `id_prefix` | Derived from hostname | Prefix for IDs minted on this node. Use distinct prefixes across federated nodes. |
| `siblings` | `[]` | Array of `{"machine":"node-b","url":"http://192.0.2.2:7899"}` entries. These are outbound federation destinations. |
| `allowed_ips` | `["127.0.0.1"]` | Allowed request source IPs. Include loopback for local clients and each sibling's source IP for federation. |
| `db_path` | `~/.claude-peers.db` | SQLite file location. `CLAUDE_PEERS_DB` overrides this field. |
| `floor_remote_forwards` | `true` | Keep incoming federation messages poll-only. Only literal `false` enables remote push eligibility. |
| `push_delay_ms` | `120000` | Delay before a `normal` message becomes eligible for push. A non-finite, negative, or nonnumeric value falls back to the default. Zero is allowed. |
| `coalesce_pushes` | `false` | Only literal `true` enables bounded multi-message tmux pastes. See [coalescing](delivery.md#push-coalescing). |
| `auto_summary` | `true` | Seed new summaries from Git state. Only literal `false` disables the seed. `set_summary` can still publish a summary. |

The loader checks required-field presence; it is not a full schema validator. Keep names and addresses as strings, `port` as a valid numeric port, and sibling/allowlist values as arrays.

The `192.0.2.x` addresses in documentation are placeholders. Replace them with real private-network addresses in your local config before enabling federation.

## Database paths

Precedence is `CLAUDE_PEERS_DB`, then the config's `db_path`, then the default home-directory path.

With a config file, relative database paths resolve against that config file's directory. The loader does not expand a literal `~` in a JSON string. Use an absolute path, or a path such as `./state/peers.db` relative to the config.

With the no-file single-host default, `CLAUDE_PEERS_DB` is used as supplied. Use an absolute override to avoid different working directories resolving it differently.

The broker and doorbell watcher must resolve the same database path: the marker directory is `<db_path>.doorbells/`. Protect the database and its SQLite sidecar files; they contain message text and session tokens. Do not commit them or include them in public reports.

## Environment variables

| Variable | Behavior |
| --- | --- |
| `CLAUDE_PEERS_CONFIG` | Select a config file. Unset means try the default file, then the single-host fallback. |
| `CLAUDE_PEERS_DB` | Override the database path. Prefer an absolute path. |
| `CLAUDE_PEERS_SESSION_NAME` | Override the MCP session's friendly name. Otherwise, use its tmux session name when available. |
| `CLAUDE_PEERS_IDLE_EXIT_MS` | Broker idle-exit interval. A directly launched broker defaults to `0` (disabled). Auto-launch supplies `600000` unless the environment already sets it. Positive values permit exit when there are no local peers and the idle window expires. Use `0` under a supervisor. |
| `CLAUDE_PEERS_PORT` | CLI-only fallback when config loading fails. It does not override a successfully loaded config or the no-file single-host default. |
| `CLAUDE_PEERS_ALLOW_UNSIGNED` | Legacy migration escape hatch. `1` accepts a missing token only for a genuine pre-protocol-3 row whose stored token is null. Wrong tokens still fail. Leave unset during normal operation. See [legacy migration](operations.md#legacy-token-migration). |
| `CLAUDE_PEERS_STALE_PRUNE_GRACE_MS` | Advanced broker override for the additional stale-peer prune grace, normally `45000` ms. Keep the default unless diagnosing lifecycle behavior. This does not change the initial heartbeat TTL. |
| `CLAUDE_PEERS_CHANNEL_PUSH_CAP` | Read by doctor for legacy channel-attempt diagnostics. It does not enable channel delivery; this build has no channel adapter. |

Environment settings must reach the process that uses them. Changing a terminal's variables does not update an already-running broker or MCP server.
