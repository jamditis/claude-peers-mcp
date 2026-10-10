# Multi-machine federation

[Documentation index](README.md) · [Configuration](configuration.md)

Each machine runs its own broker. Brokers send their local peer lists to configured siblings every five seconds. Machine-scoped discovery includes those remote peers, and messages route through the recipient's owning broker.

Federation is optional and remains experimental. Broker-to-broker authentication is a release gate; the current implementation relies on source-IP allowlists. Use a trusted private network such as a restricted tailnet.

## Connect two nodes

Use the same current checkout on both machines. Create a complete config on each. These addresses are documentation placeholders; replace them with the nodes' actual private-network addresses.

On node-a:

```json
{
  "machine": "node-a",
  "tailscale_ip": "192.0.2.1",
  "port": 7899,
  "id_prefix": "alp",
  "siblings": [
    { "machine": "node-b", "url": "http://192.0.2.2:7899" }
  ],
  "allowed_ips": ["127.0.0.1", "192.0.2.2"]
}
```

On node-b:

```json
{
  "machine": "node-b",
  "tailscale_ip": "192.0.2.2",
  "port": 7899,
  "id_prefix": "bet",
  "siblings": [
    { "machine": "node-a", "url": "http://192.0.2.1:7899" }
  ],
  "allowed_ips": ["127.0.0.1", "192.0.2.1"]
}
```

Save each file as that account's `~/.claude-peers.json`, or select it with an absolute `CLAUDE_PEERS_CONFIG` path. Keep private configs outside the public checkout.

`siblings` and `allowed_ips` do different jobs:

- `siblings` supplies outbound gossip destinations and message-routing addresses.
- `allowed_ips` permits inbound requests from those sources. Keep `127.0.0.1` for local MCP clients.
- Each pair needs reciprocal sibling entries and allowlist entries for two-way discovery and messaging. Machine-name routing is case-insensitive.
- The host firewall and private-network policy must also allow the broker port from those sibling addresses.

Restart each broker and its MCP servers to load the new settings. The config is not reloaded automatically.

## Verify both directions

From each checkout, with its broker running:

```bash
bun cli.ts ping-siblings
bun cli.ts doctor
bun cli.ts peers
```

Start a client on each node. After gossip has exchanged advertisements, call `list_peers` with machine scope and look for a remote peer. Send an `fyi` message, poll at the destination, then repeat in the other direction.

A successful health probe proves reachability, not a complete message round trip. Remote advertisements expire after 30 seconds without refresh, so a stopped or unreachable sibling disappears from discovery.

## Remote delivery

The receiving host defaults to `floor_remote_forwards: true`. All forwarded messages stay poll-only, including `interrupt`, and the doorbell can signal them to a harness that watches it.

Setting `floor_remote_forwards: false` on the **receiving** host allows its broker to push eligible messages into its local panes. It does not give the sender direct access to tmux. Remote push also requires a ready local pane and an urgency that permits push.

Keep the default unless you intend remote senders to inject text into sessions. The floor limits automatic paste; it does not authenticate message authors.

## Security boundary

The broker binds to `0.0.0.0` and checks the request source against `allowed_ips` before serving it. Control-plane POST routes additionally require loopback. Allowlisted siblings can query health and call the federation routes `/gossip` and `/forward-message`.

Local peer mutations require a 256-bit capability token bound to the claimed sender or recipient. `/register`, `/retire`, and `/list-peers` are token-exempt local control routes. Listing peers strips tokens from the response.

Federation routes use the source-IP allowlist rather than session capability tokens. Local loopback callers also reach those routes, so the current implementation still permits a local process to submit a forged-sender forward. The default floor keeps that forward out of automatic paste, but a client can still read its contents through polling. Treat received text as peer input, not an authorization grant.

Peer metadata, including working directories, repository paths, session names, and summaries, is shared with siblings. `auto_summary: false` disables only the Git-derived summary seed. Message bodies and capability tokens are stored in the local database; protect it and its sidecars.

Authentication work is tracked in [#80](https://github.com/jamditis/claude-peers-mcp/issues/80), with earlier gaps in [#4](https://github.com/jamditis/claude-peers-mcp/issues/4) and [#15](https://github.com/jamditis/claude-peers-mcp/issues/15). The [dated federation-auth design](superpowers/specs/2026-06-29-federation-auth-design.md) is a proposal, not a deployed feature. Use the [private security reporting route](../SECURITY.md) for vulnerabilities.

## Long-running brokers and deployment templates

An MCP server normally auto-launches a broker and gives it a ten-minute idle-exit window. A broker under a supervisor should use `CLAUDE_PEERS_IDLE_EXIT_MS=0` so it does not repeatedly exit and restart while idle.

The scripts under [deploy/](../deploy/) are source-checkout templates. Read and adapt them before use:

| File | Behavior and assumptions |
| --- | --- |
| [install.sh](../deploy/install.sh) | Selects a config from `deploy/configs/`, refuses the bundled placeholder IPs, backs up an existing user config, installs dependencies, and renders/enables a systemd service on Linux. It also registers the MCP server when Claude Code is available. |
| [claude-peers-broker.service](../deploy/claude-peers-broker.service) | Reference systemd unit with placeholder user, home, and checkout paths. Do not install it unchanged. |
| [install-windows-node.ps1](../deploy/install-windows-node.ps1) | Elevated Windows onboarding template. Assumes a checkout under the user profile, copies the node-d config, and creates an inbound firewall rule. It uses port 7899 and rejects the shipped example IPs. |
| [install-windows-broker-task.ps1](../deploy/install-windows-broker-task.ps1) | Elevated task-registration template. Assumes Bun and the checkout under the user profile; registers and starts a logon task. Its health probe uses port 7899. |

Use the quick start for a local installation that needs no service or firewall changes. For supervised brokers, manage start/stop through the supervisor instead of `kill-broker`, which may trigger an immediate restart.

Per-machine configs, service overrides, and version pins belong in your private deployment layer under [Decision 0001](decisions/0001-package-and-personal-deployment-boundary.md).
