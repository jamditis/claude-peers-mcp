# M2 entry gate 1 — broker-to-launcher stream transport spike

Throwaway spike for issue #8. It answers the load-bearing M2 question: can a
single `Bun.serve` instance hold a long-lived streaming response per launcher
session (`/deliveries`) while it keeps serving normal POST traffic on the same
server? Nothing in M1 had validated this, and the launcher backend's true-ack
path depends on it.

This is not M1 broker code. It runs its own `Bun.serve`, opens N concurrent
SSE streams against it, pushes events down them, and fires POSTs at the same
server while the streams stay open.

## Run

```
bun run spikes/m2-stream-transport/stream-transport.spike.ts [N]   # N defaults to 50
```

Exits non-zero if any checkpoint fails, so it also works as a smoke test.

## Result (Bun 1.3.11, Raspberry Pi 5, N=50)

7/7 checkpoints pass:

- 50 concurrent open streams held on one server.
- 20 POSTs served concurrently while every stream stays open.
- GET-with-querystring routing (`/deliveries?session=<id>`) works alongside the
  POST routes.
- Each stream receives exactly its own pushed delivery; three deliveries to one
  session arrive in order.
- Exclusive per session: a reconnect for a live session id supersedes the prior
  stream instead of duplicating it.
- A read-side `reader.cancel()` (socket left open) does NOT reap the server-side
  entry — the broker must not treat it as a disconnect.
- An aborted request (`AbortController.abort()`, a real disconnect) drops the
  server-side stream entry via the ReadableStream `cancel` callback within
  ~100 ms (the checkpoint asserts the callback fired, not just that the entry
  disappeared, so it can't be masked by the keepalive reap path).

The spike binds an ephemeral port (`port: 0`), so it never collides with a local
service and the smoke-test claim holds in any dev environment.

Measured cost: ~550-640 KB RSS and ~2 fd per stream. That RSS figure is an upper
bound that counts both ends in one process (the spike's 50 in-process fetch
clients plus the server); the broker-only per-stream cost is lower, and a
machine runs only a handful of launcher sessions, so the total is small.

## Decision

Adopt SSE over `Bun.serve` for the M2 `/deliveries` channel. The wire format is
Server-Sent Events: one `event: message` / `data: <json>` frame per delivery,
plus a periodic `: keepalive` comment line.

## Caveats for the M2 build (not blockers)

- `reader.cancel()` on the client (read side only, socket left open) does NOT
  fire the server `cancel` callback, but `AbortController.abort()` (a real
  disconnect) does. The broker must not treat a quiet stream as alive: reap dead
  streams via keepalive-write-failure plus the pid-anchored `cleanStalePeers`
  sweep, exactly as the spec's M2 sketch already requires — do not rely on the
  `cancel` callback alone.
- This spike runs client and server in one process over loopback. A cross-
  process launcher exit (the real M2 case) should be confirmed during M2 with a
  separate launcher process, to measure reap latency when the peer's pid dies
  without a clean abort.
