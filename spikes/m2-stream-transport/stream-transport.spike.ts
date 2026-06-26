// Throwaway spike for issue #8 (M2 entry gate 1): does Bun.serve hold a
// long-lived streaming response per launcher session while it keeps serving
// normal POST traffic on the same single server?
//
// This is NOT M1 broker code. It is a standalone proof that runs one Bun.serve
// instance, opens N concurrent GET /deliveries SSE streams against it, pushes
// events down them, and fires POSTs at the same server while the streams are
// held open. It measures per-stream memory/fd cost and checks the lifecycle
// behaviors M2 needs: GET-with-querystring routing, exclusive-per-session
// replacement, and cleanup on client cancel.
//
// Run: bun run spikes/m2-stream-transport/stream-transport.spike.ts [N]
// Exits non-zero if any checkpoint fails, so it doubles as a smoke test.

import { readdirSync } from "node:fs";

const N = Number(process.argv[2] ?? 50); // concurrent launcher streams to hold open
const enc = new TextEncoder();

// --- server: one Bun.serve, streams + POSTs share the same fetch handler ----

type Session = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  keepalive: ReturnType<typeof setInterval>;
};
const sessions = new Map<string, Session>();
let postsServedWhileStreaming = 0;
let discCancelObserved = false; // did the "disc" stream's server cancel callback fire?

function sseFrame(event: string, data: unknown): Uint8Array {
  // Pinned wire format: SSE. One framed event per delivery.
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function closeSession(id: string, reason: string) {
  const s = sessions.get(id);
  if (!s) return;
  clearInterval(s.keepalive);
  sessions.delete(id);
  try {
    s.controller.close();
  } catch {
    // already closed (client cancelled) — fine
  }
  log(`  server: closed stream ${id} (${reason}); live=${sessions.size}`);
}

const server = Bun.serve({
  port: 0, // ephemeral — never EADDRINUSE, so the spike runs in any dev env
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    // GET-with-querystring routing — the handler must branch on method+path,
    // not assume POST. /deliveries?session=<id> opens the long-lived stream.
    if (req.method === "GET" && url.pathname === "/deliveries") {
      const id = url.searchParams.get("session");
      if (!id) return new Response("missing session", { status: 400 });

      // Exclusive per session: a reconnect for the same id closes the prior
      // stream so deliveries never fan out to two readers.
      if (sessions.has(id)) closeSession(id, "superseded by reconnect");

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sseFrame("open", { session: id }));
          // Keepalive so a half-dead socket surfaces sooner than OS keepalive.
          const keepalive = setInterval(() => {
            try {
              controller.enqueue(enc.encode(": keepalive\n\n"));
            } catch {
              closeSession(id, "keepalive write failed");
            }
          }, 1000);
          sessions.set(id, { controller, keepalive });
        },
        // Fires when the client cancels / the request is aborted: drop the
        // per-session entry so a dead launcher can't leak the stream.
        cancel() {
          if (id === "disc") discCancelObserved = true; // proves which path reaped
          const s = sessions.get(id);
          if (s) {
            clearInterval(s.keepalive);
            sessions.delete(id);
            log(`  server: stream ${id} cancelled by client; live=${sessions.size}`);
          }
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    // Normal POST traffic served concurrently while streams stay open.
    if (req.method === "POST" && url.pathname === "/echo") {
      const body = await req.json();
      postsServedWhileStreaming++;
      return Response.json({ ok: true, echo: body });
    }

    // Push a delivery down one session's open stream (stands in for the
    // broker's deliverNext writing to /deliveries).
    if (req.method === "POST" && url.pathname === "/push") {
      const { session: id, payload } = (await req.json()) as {
        session: string;
        payload: unknown;
      };
      const s = sessions.get(id);
      if (!s) return Response.json({ ok: false, error: "no stream" }, { status: 404 });
      s.controller.enqueue(sseFrame("message", payload));
      return Response.json({ ok: true });
    }

    return new Response("spike", { status: 200 });
  },
});
const PORT = server.port; // the ephemeral port Bun chose

// --- client helpers ---------------------------------------------------------

const LOG: string[] = [];
function log(line: string) {
  LOG.push(line);
}

function fdCount(): number | null {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return null; // non-Linux: fd count unavailable, skip that metric
  }
}

// Open an SSE stream and collect framed events until `want` messages arrive or
// the deadline passes. Returns the message payloads in receipt order.
async function openStream(id: string, want: number, deadlineMs: number) {
  const res = await fetch(`http://127.0.0.1:${PORT}/deliveries?session=${id}`);
  if (!res.body) throw new Error(`no body for ${id}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const messages: unknown[] = [];
  let buf = "";
  const start = performance.now();
  (async () => {
    try {
      while (messages.length < want && performance.now() - start < deadlineMs) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const f of frames) {
          const evLine = f.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = f.split("\n").find((l) => l.startsWith("data: "));
          if (evLine?.slice(7) === "message" && dataLine) {
            messages.push(JSON.parse(dataLine.slice(6)));
          }
        }
      }
    } catch {
      // reader cancelled — expected for the supersede test
    }
  })();
  return { messages, reader };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: boolean, label: string, results: Record<string, boolean>) {
  results[label] = cond;
  log(`  [${cond ? "PASS" : "FAIL"}] ${label}`);
}

// --- run --------------------------------------------------------------------

const results: Record<string, boolean> = {};

const rssBefore = process.memoryUsage().rss;
const fdBefore = fdCount();

// Hold N concurrent launcher streams open.
const streams: Awaited<ReturnType<typeof openStream>>[] = [];
for (let i = 0; i < N; i++) {
  streams.push(await openStream(`s${i}`, 1, 8000));
}
await sleep(300); // let all `start()` callbacks register their sessions

const rssAfter = process.memoryUsage().rss;
const fdAfter = fdCount();

assert(sessions.size === N, `server holds ${N} concurrent open streams`, results);

// POSTs are served while every stream is held open.
const postResults = await Promise.all(
  Array.from({ length: 20 }, (_, i) =>
    fetch(`http://127.0.0.1:${PORT}/echo`, {
      method: "POST",
      body: JSON.stringify({ i }),
    }).then((r) => r.status),
  ),
);
assert(
  postResults.every((s) => s === 200) && postsServedWhileStreaming === 20,
  "20 POSTs served concurrently while streams stay open",
  results,
);

// Push one delivery to every stream; each client receives exactly its own.
for (let i = 0; i < N; i++) {
  await fetch(`http://127.0.0.1:${PORT}/push`, {
    method: "POST",
    body: JSON.stringify({ session: `s${i}`, payload: { to: `s${i}`, n: i } }),
  });
}
await sleep(500);
const allDelivered = streams.every((st, i) => {
  const m = st.messages[0] as { to: string; n: number } | undefined;
  return m?.to === `s${i}` && m?.n === i;
});
assert(allDelivered, "each stream received exactly its own pushed delivery", results);

// Ordering: three pushes to one session arrive in order.
const ord = await openStream("ord", 3, 6000);
await sleep(100);
for (const n of [1, 2, 3]) {
  await fetch(`http://127.0.0.1:${PORT}/push`, {
    method: "POST",
    body: JSON.stringify({ session: "ord", payload: { seq: n } }),
  });
}
await sleep(400);
assert(
  ord.messages.length === 3 &&
    (ord.messages as { seq: number }[]).every((m, idx) => m.seq === idx + 1),
  "three deliveries to one session arrive in order",
  results,
);

// Exclusive per session: a reconnect closes the prior stream (count stays flat).
const sizeBeforeReconnect = sessions.size;
await openStream("ord", 1, 3000); // reconnect for the live "ord" session
await sleep(300);
assert(
  sessions.size === sizeBeforeReconnect,
  "reconnect for a live session supersedes, not duplicates, the stream",
  results,
);

// reader.cancel() vs abort: a read-side cancel leaves the underlying socket
// open, so it does NOT fire the server's `cancel` callback — the broker cannot
// treat it as a disconnect. Prove that here (poll 1.5s, expect NOT reaped) so
// the caveat the README and spec record is backed by the spike, not just
// observed once. If a future Bun reaps read-side cancels, this flips to FAIL and
// surfaces that the caveat no longer holds.
const rc = await openStream("rc", 1, 3000);
await sleep(300);
const rcRegistered = sessions.has("rc");
await rc.reader.cancel();
let rcReaped = false;
for (let i = 0; i < 15; i++) {
  if (!sessions.has("rc")) {
    rcReaped = true;
    break;
  }
  await sleep(100);
}
assert(
  rcRegistered && !rcReaped,
  "read-side reader.cancel() leaves the server entry live (broker must not rely on it)",
  results,
);
closeSession("rc", "spike cleanup"); // drop the lingering entry so counts stay clean

// Disconnect cleanup: an aborted request (a real client disconnect, not just a
// reader.cancel that leaves the socket open) must eventually drop the
// server-side entry. We poll up to 3s and record the DETECTION LATENCY, the
// load-bearing number for M2: if the ReadableStream `cancel` callback does not
// fire promptly on disconnect, the broker cannot rely on it alone and must reap
// via keepalive-write-failure + the pid-anchored cleanStalePeers sweep (which
// the spec's M2 sketch already calls for).
const ac = new AbortController();
const discRes = await fetch(`http://127.0.0.1:${PORT}/deliveries?session=disc`, {
  signal: ac.signal,
});
void discRes.body?.getReader().read(); // start consuming so the stream is live
await sleep(300);
const sizeBeforeCancel = sessions.size;
const hadDisc = sessions.has("disc");
ac.abort();
const cancelStart = performance.now();
let cancelLatencyMs = -1;
for (let i = 0; i < 30; i++) {
  if (!sessions.has("disc")) {
    cancelLatencyMs = Math.round(performance.now() - cancelStart);
    break;
  }
  await sleep(100);
}
// Assert on discCancelObserved too: the entry could in principle be reaped by
// the keepalive-write-failure path instead, so checking it disappeared isn't
// enough to back the docs' "via the cancel callback" claim. Requiring the
// callback flag makes this checkpoint a real tripwire — symmetric with the
// read-side-cancel checkpoint above — that flips to FAIL if a future Bun stops
// firing `cancel` on abort and the keepalive path quietly reaps instead.
const reaped = hadDisc && !sessions.has("disc");
const reapedViaCallback = reaped && discCancelObserved;
assert(
  reapedViaCallback,
  reapedViaCallback
    ? `aborted request reaps the entry via the server cancel callback (within ~${cancelLatencyMs}ms)`
    : "aborted request did NOT reap via the cancel callback within 3s (M2 must reap via pid-sweep + keepalive, not the cancel callback)",
  results,
);
log(
  `  note: server entries before/after abort = ${sizeBeforeCancel}/${sessions.size}; ` +
    `same-process loopback may not model a cross-process launcher exit — confirm in M2 with a real launcher process`,
);

// --- report -----------------------------------------------------------------

const rssPerStreamKb = Math.round((rssAfter - rssBefore) / N / 1024);
const fdPerStream =
  fdBefore != null && fdAfter != null
    ? ((fdAfter - fdBefore) / N).toFixed(2)
    : "n/a (non-linux)";

console.log(LOG.join("\n"));
console.log("\n=== measurements ===");
console.log(`bun: ${Bun.version}`);
console.log(`concurrent streams (N): ${N}`);
console.log(
  `rss: ${Math.round(rssBefore / 1024 / 1024)}MB -> ${Math.round(rssAfter / 1024 / 1024)}MB ` +
    `(~${rssPerStreamKb} KB/stream)`,
);
console.log(`fd: ${fdBefore} -> ${fdAfter} (~${fdPerStream} fd/stream server-side+client)`);
console.log(`posts served while N streams held open: ${postsServedWhileStreaming}`);

const passed = Object.values(results).filter(Boolean).length;
const total = Object.keys(results).length;
console.log(`\n=== ${passed}/${total} checkpoints passed ===`);

// cleanup
for (const s of sessions.values()) clearInterval(s.keepalive);
server.stop(true);
process.exit(passed === total ? 0 : 1);
