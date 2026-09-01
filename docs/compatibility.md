# Compatibility and support contract

This document records the contract that the public beta must prove before
version 1.0 can freeze it. It is a beta baseline, not a claim that 1.0 is ready.
The remaining release gates are tracked in [roadmap #85](https://github.com/jamditis/claude-peers-mcp/issues/85)
and [the stable-contract epic](https://github.com/jamditis/claude-peers-mcp/issues/83).

## Contract status

The 0.x package manifest still has `private: true`. During 0.x:

- patch releases do not intentionally break a working tool or wire contract;
- minor releases can make breaking changes when the changelog gives the
  migration path;
- only upgrade paths with a mixed-version test are supported;
- downgrades after a broker protocol or database migration are unsupported.

Version 1.0 must replace this beta baseline with the tested release matrix from
the install study. Open [federation-authentication #80](https://github.com/jamditis/claude-peers-mcp/issues/80),
[durable-identity #81](https://github.com/jamditis/claude-peers-mcp/issues/81),
[public-beta #82](https://github.com/jamditis/claude-peers-mcp/issues/82), and
[release-blocker #83](https://github.com/jamditis/claude-peers-mcp/issues/83)
issues remain release gates. They cannot be converted into support claims by
documentation.

## MCP tool contract

The executable tool manifest is in
[`shared/mcp-contract.ts`](../shared/mcp-contract.ts). The compatibility test
pins tool names, required inputs, property types, enums, and the server version.
Descriptions and exact result prose can improve without a version bump.

Every tool returns an MCP `CallToolResult` with one text content block. An error
sets `isError: true`; callers must not parse the human-readable error sentence
as a machine code.

| Tool | Input | Success meaning |
| --- | --- | --- |
| `list_peers` | Required `scope`: `machine`, `directory`, or `repo` | A formatted peer list, or a no-peers sentence. It is a liveness-filtered view, not a durable directory. |
| `send_message` | Required `to_id` and `message`; optional `urgency`: `interrupt`, `normal`, or `fyi` | The broker accepted the message and reports pushed or queued transport state. It does not prove that the recipient model processed it. |
| `set_summary` | Required `summary` string | The current registration now advertises that summary. |
| `check_messages` | No input | Pending readable messages were returned and transport-settled, or no mail was pending. This call consumes the returned rows. |
| `peek_messages` | No input | The caller's peer ID and pending count were read without consuming mail. |

Adding an optional input is backward compatible. Renaming a tool, removing an
input, changing an enum, adding a required input, changing success versus error
classification, or changing the result from one text block is breaking after
1.0.

## Delivery terms

The transport uses these terms:

1. **Send:** the sending server asks its broker to route a message.
2. **Receive:** the destination broker stores the row for a live peer.
3. **Process:** the recipient client or model acts on the message. The broker
   cannot observe this state.
4. **Settle:** the broker hands the row to a client path and removes it from the
   pending queue. A tmux push settles after the guarded write and liveness
   confirmation. A poll settles when `check_messages` returns the row.

The SQLite `delivered` state means transport-settled. It does not mean read,
understood, answered, or completed. The product does not promise exactly-once
model processing.

Urgency changes the transport path:

| Urgency and target | Current behavior |
| --- | --- |
| Local `interrupt` with a ready tmux pane | Push now. |
| Local `normal` with a ready tmux pane | Queue until a poll or the configured push deadline. |
| `fyi` | Poll-only. |
| Local peer without tmux | Queue for `check_messages`; the doorbell can wake an attached harness. |
| Remote peer with the default floor | Queue on the remote broker as poll-only. |
| Remote peer with remote push enabled | The remote broker can push when due; the sending broker never types into a pane on another host. |
| Channel or other transport | Experimental until it has its own delivery-state and mixed-version tests. |

## Identity, resume, and retention

- A peer ID and its capability token identify one live MCP server
  registration. A friendly session name is an addressable label, not a durable
  identity. Duplicate names are rejected as ambiguous.
- A live server that restarts its broker can prove its stored registration and
  keep the same ID and queued mail. A new MCP server registration gets a new ID.
- Local peers become stale after 45 seconds without a heartbeat and receive one
  further 45-second prune grace. A dead process can be removed immediately.
  Remote peer advertisements expire after 30 seconds.
- A delivery lease lasts 5 seconds. An expired or holderless lease returns to
  the queue.
- Transport-settled rows are pruned after 60 seconds. Queued rows have a
  24-hour lossy backstop. Removing a peer removes its mail.
- The queue is coordination mail, not archival storage. There is no supported
  live-backup or cross-version restore path in the beta.

## Protocol and upgrade rules

The current broker protocol is 10. A current server refuses to run silently
against an older local broker: it retires that broker and starts the required
version. Protocol 9 to 10 is the current mixed-version path and has tests for
legacy registrations and stored rows without `repo_key`.

The supported rolling-upgrade rule is:

- upgrade the broker before relying on a new protocol feature;
- keep old and new binaries mixed only when that transition has a named
  compatibility test;
- migrate the SQLite schema forward automatically and additively;
- back up the stopped database before starting an upgraded broker;
- roll back with the old binary and its pre-upgrade database copy. Running an
  old binary against a migrated database is not supported.

The protocol number is an internal broker-server negotiation value. It does not
match the package major version. A protocol bump can ship in a compatible
package release when the tested rolling path preserves existing behavior.

## Current support evidence

| Surface | Beta status | Evidence and limit |
| --- | --- | --- |
| Bun | Supported on the current stable release used by CI | CI follows `latest`; a minimum version is not yet pinned. |
| Ubuntu | Supported | Full typecheck, lint, unit, integration, and broker tests run on `ubuntu-latest`. |
| Windows | Partial | Typecheck, lint, and platform-independent tests run on `windows-latest`. POSIX tmux and shell-stub integration tests skip. |
| macOS | Best effort | The code uses POSIX paths for tmux delivery, but no macOS CI or release test exists. |
| tmux | Supported push transport on POSIX systems | Exact minimum and maximum tmux versions are not yet release-pinned. |
| Headless or non-tmux client | Supported polling transport | Uses `check_messages`; the doorbell is an optional wake signal. |
| Claude Code over stdio MCP | Supported beta client | This is the client exercised by the repository and deployment. |
| Other MCP clients | Experimental | Tool discovery can work over stdio, but cross-client versions and lifecycle behavior are not yet in the test matrix. |
| Federation | Experimental security boundary | Source-IP allowlists protect broker routes, but broker-to-broker authentication remains a release gate in issue #80. |

The 1.0 release notes must replace every partial, best-effort, or experimental
row with a supported tier or an explicit out-of-scope statement.

## Security, data, and incidents

- The control plane is loopback-only. Each session gets a 256-bit capability
  token for principal-bound local mutations.
- Peer tokens and message bodies live in the SQLite database. The file must be
  readable only by the service account and must not be committed or copied into
  diagnostics.
- Federation routes do not accept session capability tokens. Their current
  source-IP allowlist is not the final 1.0 authentication boundary.
- To revoke one local capability, stop that MCP server and remove its
  registration. To revoke all local capabilities, stop the clients and broker,
  preserve evidence if needed, replace the database, and restart the clients.
  Replacing the database discards queued mail.
- For a suspected broker compromise, isolate the federation port, stop routing,
  preserve the database and logs as sensitive evidence, rotate affected
  credentials, upgrade or repair the broker, and verify with `doctor` before
  reconnecting peers.

The 1.0 contract must add a public security-reporting address, supported-version
window, signed federation-key rotation, and tested recovery procedure.

## Deprecation policy for 1.0

After 1.0, a public tool, input, result shape, config field, or supported wire
behavior gets:

1. an operator-visible warning in the affected tool, broker, CLI, or `doctor`
   path;
2. a changelog entry and a migration path;
3. at least one minor release and 90 days of notice, whichever is longer;
4. removal only in the next major release.

An actively unsafe behavior can be disabled sooner. That exception requires a
security notice, a safe replacement or shutdown path, and a clear statement of
which versions are affected.

## Out of scope for the stable core

The stable contract does not imply model-processing acknowledgments, exactly-once
processing, a task board, terminal management, durable channels, or permanent
message history. Optional coordination features stay outside the 1.0 core until
they have separate research and compatibility evidence.
