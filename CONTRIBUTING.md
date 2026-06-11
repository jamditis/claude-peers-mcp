# Contributing

Thanks for working on claude-peers. This is a Bun/TypeScript MCP project: a singleton broker daemon (`broker.ts`), one MCP stdio server per Claude Code instance (`server.ts`), the pure delivery logic both share (`delivery.ts`), and a CLI (`cli.ts`). This guide covers local setup, running a session, the test suite, the CI gate, and the conventions a PR has to follow.

## Requirements

- [Bun](https://bun.sh) (CI pins `latest`).
- A POSIX environment (Linux or macOS) for the test suite. The broker itself runs on Windows, but `bun test` does not — see [POSIX-only test suite](#posix-only-test-suite-issue-22) below.
- `tmux`, if you want a broker to type messages straight into a live Claude Code pane. Without it, messages queue and are read with the `check_messages` tool.

## Local dev setup

Clone the repo and install dependencies:

```bash
bun install
```

CI installs with `bun install --frozen-lockfile`, so commit `bun.lock` changes alongside any dependency change and make sure your local install matches the lockfile before you push.

The broker stores per-session capability tokens in its SQLite database, so `*.db`, `*.sqlite`, `*.sqlite3`, and `.claude-peers.json` are gitignored. Never commit a broker database or a config file — they hold secrets.

## Running the broker and an MCP session

The broker is a singleton HTTP daemon on `localhost:7899`. You normally don't start it by hand: the MCP server auto-launches one the first time a Claude Code instance registers. The two ways to run things:

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
      "args": ["./server.ts"]
    }
  }
}
```

Inspect or drive a running broker with the CLI:

```bash
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
bun cli.ts kill-broker
```

`bun cli.ts send` registers an ephemeral queued-only peer, authenticates the send with that peer's token, and unregisters in a `finally`. It does not bypass the token gate.

Both the broker and the MCP server read `port`, `machine`, federation `siblings`, and the IP `allowed_ips` from a config file (`~/.claude-peers.json` by default, overridable with `CLAUDE_PEERS_CONFIG`), not from environment variables. A missing or incomplete config file throws on startup, so you need a valid one to run a session locally. The required fields are `machine`, `tailscale_ip`, `port`, `id_prefix`, `siblings`, and `allowed_ips`; `db_path` and `floor_remote_forwards` are optional. See the README and the per-host samples under `deploy/configs/` for the field reference.

## Test suite

Run the full suite with:

```bash
bun test
```

Tests live under `tests/`: `broker.test.ts`, `config.test.ts`, `delivery.test.ts`, and `integration.test.ts`. To run a single file or filter by name:

```bash
bun test tests/delivery.test.ts
bun test --test-name-pattern "lease"
```

The delivery logic in `delivery.ts` is written to be pure and testable so the tests can import it directly rather than spinning up a broker for every case. New behavior in `broker.ts`, `delivery.ts`, or `shared/` should land with tests in the matching file.

### POSIX-only test suite (issue #22)

The test suite is POSIX-only and does not run on native Windows ([#22](https://github.com/example-org/claude-peers-mcp/issues/22)). `integration.test.ts` writes shell-based `tmux` stub scripts (shebang + executable bit), uses named pipes and Unix temp paths, and the delivery/broker tests rely on signal-based liveness checks with no native-Windows equivalent. On native Windows, `bun test` fails the `integration.test.ts` cases that wait on a marker the `tmux` stub never writes. This is a known limitation, not a regression — the broker daemon runs on Windows; only the harness is POSIX-bound. Develop and run the suite on Linux or macOS (or WSL).

## CI gate

CI (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main` as a single `test` job. Branch protection requires the `test` check to pass before merge, so run all three steps locally before you push:

```bash
bun run typecheck   # = tsc --noEmit
bun run lint        # = biome lint --error-on-warnings .
bun test
```

All three must pass. `--error-on-warnings` means any Biome warning fails the lint step, so treat warnings as errors locally too.

A second workflow, `.github/workflows/codeql.yml`, runs CodeQL `javascript-typescript` security analysis on pull requests, on `main`, and on a weekly cron. It is not a required merge check, but address anything it flags.

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
- **Make CI green before requesting review.** Run `bun run typecheck`, `bun run lint`, and `bun test` locally first; the `test` check is required for merge.
- Update the README, `CLAUDE.md`, and `CHANGELOG.md` when a change affects setup, behavior, or the public surface. Stale docs are worse than no docs.

## Project layout

| Path | Purpose |
| --- | --- |
| `broker.ts` | Singleton HTTP broker daemon: routing, delivery, the lease state machine, capability-token auth, federation routes. |
| `server.ts` | MCP stdio server, one per Claude Code instance; registers with the broker and exposes the tools. |
| `delivery.ts` | Pure, testable delivery logic (lease machine, tmux target resolution, bracketed-paste formatting, liveness probe, retention prune, token generation). |
| `cli.ts` | CLI for inspecting broker state and sending messages. |
| `shared/` | Shared types (`types.ts`), config loader (`config.ts`), and summary helper (`summarize.ts`). |
| `tests/` | Bun test suite (POSIX-only). |
| `deploy/` | Install scripts, the systemd unit, and per-host config samples. |
| `.github/workflows/` | `ci.yml` (the required gate) and `codeql.yml`. |
