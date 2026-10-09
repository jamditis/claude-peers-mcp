# Contributing

This is a Bun/TypeScript MCP project: a singleton broker daemon (`broker.ts`), one MCP stdio server per client session (`server.ts`), delivery logic (`delivery.ts`), and a CLI (`cli.ts`). For installation and operation, start with the [user guides](docs/README.md). This guide covers development, checks, and repository conventions.

## Requirements

- [Bun](https://bun.sh) (CI follows `latest`; it does not pin an exact version).
- Ubuntu for the full test suite. Windows runs the platform-independent suites and skips the POSIX integration cases; see [Platform test coverage](#platform-test-coverage-issue-22) below.
- `tmux`, if you want a broker to type messages straight into a live Claude Code pane. Without it, messages queue and are read with the `check_messages` tool.

## Local dev setup

Clone the repo and install dependencies:

```bash
bun install
```

CI installs with `bun install --frozen-lockfile`, so commit `bun.lock` changes alongside any dependency change and make sure your local install matches the lockfile before you push.

The broker stores per-session capability tokens and message text in its SQLite database. Keep databases, SQLite sidecars, and private machine configs out of commits. Generic configs with documentation placeholders belong in `deploy/configs/`; real deployment values belong outside this repository.

## Running the broker and an MCP session

Local clients reach the broker at `127.0.0.1:7899` by default. Its socket binds to all interfaces, with request allowlists and loopback-only control-plane POST routes enforcing access. The MCP server normally auto-launches it. The two ways to run things:

```bash
# Run the MCP stdio server directly (this is what Claude Code spawns).
# It registers with the broker, auto-launching one if none is running.
bun run server      # = bun server.ts

# Run a broker explicitly (rarely needed — the server spawns it for you).
bun run broker      # = bun broker.ts
```

To wire the MCP server into a Claude Code instance, add it to `.mcp.json`:

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

Replace the absolute path with your checkout. Inspect or drive a running broker with the CLI:

```bash
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> --urgency fyi "Review notes are ready."
bun cli.ts doctor
bun cli.ts kill-broker
```

`bun cli.ts send` registers an ephemeral queued-only peer, authenticates the send with that peer's token, and unregisters in a `finally`. It does not bypass the token gate.

No config file is needed for local single-host development. When `~/.claude-peers.json` is absent and `CLAUDE_PEERS_CONFIG` is unset, the broker uses the loopback-only allowlist from `singleHostDefault()`. Create a config only to customize the host or enable federation. A config that exists must include `machine`, `tailscale_ip`, `port`, `id_prefix`, `siblings`, and `allowed_ips`; an explicitly selected `CLAUDE_PEERS_CONFIG` path must exist. See the [configuration reference](docs/configuration.md) and generic samples under `deploy/configs/`.

## Test suite

Run the full suite with:

```bash
bun test
```

Tests live under `tests/`, including broker, configuration, delivery, integration, tool-contract, privacy, recovery, and generic stdio-client cases. To run a single file or filter by name:

```bash
bun test tests/delivery.test.ts
bun test --test-name-pattern "lease"
```

The delivery logic in `delivery.ts` is written to be pure and testable so the tests can import it directly rather than spinning up a broker for every case. New behavior in `broker.ts`, `delivery.ts`, or `shared/` should land with tests in the matching file.

### Platform test coverage (issue #22)

CI runs typecheck, lint, the docs privacy check, and `bun test` on Ubuntu and native Windows ([#22](https://github.com/jamditis/claude-peers-mcp/issues/22)). The shell-based `tmux`, named-pipe, and signal integration suites use `skipIf(win32)`; platform-independent units still run on Windows. Ubuntu is the release gate for the full integration suite. macOS remains best effort until it has its own CI leg.

## CI gate

CI (`.github/workflows/ci.yml`) runs on pull requests and pushes to `main`. Its matrix produces `test (ubuntu-latest)` and `test (windows-latest)` jobs. Branch-protection requirements are repository settings, separate from the workflow file. Run these checks locally before you push:

```bash
bun run typecheck   # = tsc --noEmit
bun run lint        # = biome lint --error-on-warnings .
bun run check:docs:privacy
bun test
```

All four must pass. `--error-on-warnings` means any Biome warning fails the lint step, so treat warnings as errors locally too. Run the docs privacy check before committing a documentation change: CI can block a merge, but it cannot hide an address already pushed to a public branch. Use `192.0.2.x` addresses in new examples, and review machine names separately.

A second workflow, `.github/workflows/codeql.yml`, runs CodeQL `javascript-typescript` security analysis on pull requests, on `main`, and on a weekly schedule. Address actionable findings and check the current repository rules for merge requirements.

## Biome conventions

Linting is [Biome](https://biomejs.dev) `2.4.16` (pinned exact in `devDependencies`), configured in `biome.json`:

- **The formatter is off on purpose.** `biome.json` sets `"formatter": { "enabled": false }` so adopting Biome on the existing tree doesn't reflow every file. Do not turn it on or run `biome format` across the repo — that would explode unrelated diffs. Match the surrounding code's style by hand.
- **The recommended ruleset is on, with `--error-on-warnings`.** Fix findings in source. To silence a deliberate, justified case, suppress it inline with a Biome ignore comment rather than disabling the rule globally.
- **`tests/**` has an override.** Test files re-allow `noExplicitAny` and `noNonNullAssertion` so JSON test plumbing can use `any` and `!`. Source files stay strict — keep `any` and non-null assertions out of `broker.ts`, `server.ts`, `delivery.ts`, `cli.ts`, and `shared/`.

`tsconfig.json` runs strict `tsc`; `bun run typecheck` must be clean (`tsc --noEmit`, zero errors).

## Commit and PR conventions

- **Sentence case** for commit subjects and PR titles. Keep the subject short and imperative ("Add case-insensitive machine routing"), not Title Case.
- **Explain why, not what.** The diff already shows what changed; the commit body and PR description should explain the decision and any trade-off.
- **No AI attribution** anywhere — no "Generated with" lines, no `Co-Authored-By` trailers for an assistant, no model or tool credit in commits, PR bodies, code comments, or docs.
- **One logical change per PR.** Land a feature with its tests; file unrelated findings as separate issues instead of widening the PR.
- **Reference the issue** a PR closes (`Closes #N`) when there is one.
- **Make CI green before requesting review.** Run the four checks listed above locally first and satisfy the repository's current merge requirements.
- Update the README, `CLAUDE.md`, and `CHANGELOG.md` when a change affects setup, behavior, or the public surface. Stale docs are worse than no docs.

## Project layout

| Path | Purpose |
| --- | --- |
| `broker.ts` | Singleton HTTP broker daemon: routing, delivery, the lease state machine, capability-token auth, federation routes. |
| `server.ts` | MCP stdio server, one per client session; registers with the broker and exposes the tools. |
| `delivery.ts` | Pure, testable delivery logic (lease machine, tmux target resolution, bracketed-paste formatting, liveness probe, retention prune, token generation). |
| `cli.ts` | CLI for inspecting broker state and sending messages. |
| `shared/` | Config, types, tool contracts/results, recovery, diagnostics, repository identity, summaries, and doorbell helpers. |
| `bin/claude-peers-mcp.ts` | Package entry point: starts stdio MCP by default or dispatches `cli` commands. |
| `docs/` | Current user guides, compatibility contract, decisions, and dated design records. |
| `tests/` | Bun test suite. POSIX integration tests skip on Windows; platform-independent tests still run. |
| `deploy/` | Install scripts, the systemd unit, and per-host config samples. |
| `.github/workflows/` | Ubuntu/Windows checks in `ci.yml` and separate security analysis in `codeql.yml`. |
