---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite. Auto-launched by the MCP server. Owns delivery: it routes each message to the recipient's backend (tmux pane via `send-keys`, or none → leave queued for `check_messages`) and runs the lease state machine. Push is gated on urgency: a row is pushed only once its `push_after` deadline is due (`interrupt` = now, `normal` = after `push_delay_ms`, `fyi`/floored forward = never — NULL, poll-only); when one row comes due the rest of the recipient's pushable backlog is promoted to ride the same flush. `PROTOCOL_VERSION = 4`; a newer MCP server retires an older broker via a version handshake on `/health`. Owns per-session capability-token auth: mints a 256-bit token at `/register` (stored on the `peers.token` column) and gates every mutating control-plane call on `Authorization: Bearer <token>` matching the call principal (`from_id` for `/send-message`, `id` otherwise), so a forged `from_id` 401s. `/register`, `/retire`, `/list-peers`, and the federation routes (`/gossip`, `/forward-message`) are token-exempt; `/list-peers` strips the token column via `stripToken` so the read route never leaks the secret. `CLAUDE_PEERS_ALLOW_UNSIGNED=1` is an upgrade-window grace that accepts only a missing token on a genuine pre-v3 NULL-token row (a wrong token always 401s).
- `server.ts` — MCP stdio server, one per Claude Code instance. Registers with the broker, reporting its own tmux pane as a delivery target, and exposes the tools. Captures the capability token returned by `/register` and presents it as `Authorization: Bearer` on every subsequent control-plane call. No channel push — delivery is broker-side. The `peek_messages` tool calls `/peek` and reports the session's own id plus its pending count/max-id without consuming — how a session learns the id to arm the doorbell with.
- The doorbell (#49) — the near-real-time wake for a `delivery_kind='none'` interactive session, which has no pane to push into and otherwise sees mail only at its next manual `check_messages`. The broker writes a per-recipient marker file (`shared/notify.ts`) holding the recipient's max pending row id whenever mail is queued for a `none` recipient (`ringDoorbell`, called after insert in `handleSendMessage`/`handleForwardMessage`; tmux recipients are skipped — they already get a push). `bun cli.ts doorbell <id>` watches that marker (`fs.watch` + debounce + read-after-arm + slow poll fallback), treats it as level-triggered state (the counter only grows, so a missed event costs at most one poll interval, never a message), and exits the instant it advances so the harness re-wakes the session — which re-arms the watcher and then reads via `check_messages` (arm-before-check: a message landing during the drain is caught by that check, while one landing after rings the freshly-armed bell, so nothing falls in the gap). Notify-only: the marker is a content-free counter, never the message body or the SQLite store, and nothing in this path marks a row delivered, so `check_messages` stays the single consume path. `/peek` is the authenticated (token-gated, recipient-scoped) non-consuming read behind `peek_messages`. A session with no watcher is unaffected (the write lands in an unwatched file) and degrades to today's poll-only floor.
- `shared/notify.ts` — Pure doorbell-marker helpers: `doorbellDir`/`doorbellPath` (derive the marker location as a sibling of `db_path`, `${db_path}.doorbells/<id>.mark`, so broker and watcher agree without a new config field; a filename-safe-id guard blocks path traversal), `writeDoorbell`/`readDoorbell` (write/read the monotonic counter, best-effort and never throwing), and `removeDoorbell` (drop a stale marker on peer removal, wired into `deletePeerAndMail`).
- `delivery.ts` — Pure, testable delivery logic (lease state machine, tmux target resolution, bracketed-paste formatting + C0 stripping (urgency-aware: reply hint only on `interrupt`, `fyi` tag), ordered next-deliverable selection over the pushable channel, the urgency helpers (`pushAfterFor`, `hasDuePush`, `promoteQueuedForFlush`), liveness probe, retention prune, `generateAuthToken` for the capability token). `broker.ts` composes these; tests import them directly.
- `shared/types.ts` — Shared types for the broker API, including `PROTOCOL_VERSION`, the `delivery_state` schema, and the per-session capability `token` field on `RegisterResponse`.
- `shared/config.ts` — Config loader. Notable: `floor_remote_forwards` (default true, secure-by-default) leaves cross-machine forwards queued for `check_messages` instead of pushing them into the local pane; set it `false` to opt in to cross-node push. Local same-machine peers always push.
- `shared/summarize.ts` — Git-context helpers (`getGitBranch`, `getRecentFiles`) and `buildAutoSummary`, which seeds a peer's summary at registration from git state (`[auto] <branch>; recent: <files>`, ≤140 chars, empty outside a git repo, never throws). `set_summary` overwrites the seed once the session knows its task.
- `shared/format-peers.ts` — Compact `list_peers` rendering: `formatPeerList` (one head line per peer + indented summary, 200-char display cap that keeps the head of the summary, newlines collapsed) and `formatAge` (relative ages, clock-skew clamp, null on unparseable).
- `cli.ts` — CLI utility for inspecting broker state and sending messages. `send` registers an ephemeral queued-only peer (no tmux pane, so never a delivery target), authenticates the send with that peer's token, and unregisters in a `finally`. `doorbell <id>` is the #49 watcher: it blocks on the recipient's marker file and exits when mail arrives (see the doorbell note above).

## Running

Both the broker and the MCP server read their settings from a config file — `~/.claude-peers.json` by default, overridable with `CLAUDE_PEERS_CONFIG` — not from environment variables. A missing or incomplete config throws on startup, so a valid one is required to run a session. Required fields: `machine`, `tailscale_ip`, `port`, `id_prefix`, `siblings`, `allowed_ips`. Optional: `db_path`, `floor_remote_forwards`, `push_delay_ms` (default 120000 — how long a `normal`-urgency message waits queued before the broker pushes it anyway), `auto_summary` (default true — seed each session's summary from git state at registration; false keeps summaries empty until `set_summary`). Per-host samples live under `deploy/configs/`.

```bash
# Plain MCP — no channel flags needed. Delivery into a session works when Claude
# runs inside a tmux pane; otherwise messages queue for check_messages.
# Add to .mcp.json:
# { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }

# CLI:
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
bun cli.ts doorbell <peer-id>   # block until <peer-id> has mail, then exit (non-tmux wake, #49)
bun cli.ts kill-broker
```

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
