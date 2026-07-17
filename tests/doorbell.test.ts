// tests/doorbell.test.ts — broker side of the doorbell + /peek feature (issue #49).
//
// Spins up a real broker (with a stub tmux so a tmux recipient genuinely registers as 'tmux')
// and asserts: a send to a delivery_kind='none' recipient writes the marker with the new row
// id; a send to a tmux recipient writes no marker (it already gets an active push); /peek
// reports the backlog without consuming it; and /peek is token-gated to the caller's id.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe as bunDescribe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorbellPath, readDoorbell, writeDoorbell } from "../shared/notify.ts";
import { PROTOCOL_VERSION } from "../shared/types.ts";

// #22: this suite spins up a real broker with a shell-based `tmux` stub (shebang +
// `chmodSync` executable bit), which native Windows cannot exec. Gate it behind a
// platform check: on win32 it skips instead of failing at exec time; on POSIX
// `skipIf(false)` is a no-op. This removes the bash-stub-exec failure class only;
// the remaining unit suites still hardcode `/tmp` paths, tracked in #53.
const describe = bunDescribe.skipIf(process.platform === "win32");

const PORT = 17940;
// The pane the tmux stub deliberately stalls on, so a delivery lease is genuinely open while a
// second send lands. Any pane not equal to this one returns instantly.
const SLOW_PANE = "%77";
const work = mkdtempSync(join(tmpdir(), "doorbell-it-"));
const DB_PATH = join(work, "broker.db");
const CONFIG_PATH = join(work, "config.json");
let proc: any;

// A second broker for the drain-race suite below. Those cases need a pushable row that is
// push-due but not yet claimed at the instant a poll-only row lands, and the 2-minute default
// push_delay_ms cannot stage that inside a test. Its own port and db keep the shortened delay
// off the suites above, whose timing assertions assume the default.
const PORT_DRAIN = 17941;
const DB_PATH_DRAIN = join(work, "drain.db");
const CONFIG_PATH_DRAIN = join(work, "drain-config.json");
const PUSH_DELAY_MS = 400;
let drainProc: any;

async function callAt(port: number, path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function okAt(port: number, path: string, body: unknown, token?: string) {
  const res = await callAt(port, path, body, token);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json() as any;
}
const call = (path: string, body: unknown, token?: string) => callAt(PORT, path, body, token);
const ok = (path: string, body: unknown, token?: string) => okAt(PORT, path, body, token);

// A recipient must be a LIVE pid (sends check recipient liveness), so it uses this process's
// pid. A same-pid re-register supersedes the prior row, so only one live recipient exists at a
// time — fine, since each test uses its own and never references a prior test's recipient.
function regRcpt(overrides: Record<string, unknown> = {}, port = PORT) {
  return okAt(port, "/register", {
    pid: process.pid, cwd: "/tmp/db", git_root: null, tty: null, summary: "",
    machine: "db-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null, ...overrides,
  });
}
// A sender is never a delivery target and its liveness is never probed, so it can use a unique
// fake pid — which also keeps it from superseding the live recipient's same-pid row.
let fakePid = 900_000;
function regSender(overrides: Record<string, unknown> = {}, port = PORT) {
  return okAt(port, "/register", {
    pid: ++fakePid, cwd: "/tmp/db-s", git_root: null, tty: null, summary: "",
    machine: "db-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null, ...overrides,
  });
}

async function waitForHealth(port: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Wait for a specific row to reach a delivery_state, rather than sleeping and hoping. A fixed
// sleep pins the tmux stub's wall-clock timing instead of the invariant under test, and a race
// that silently failed to set up would pass for the wrong reason — so this throws instead.
async function waitForRowState(dbPath: string, rowId: number, state: string, timeoutMs = 8000) {
  const probe = new Database(dbPath, { readonly: true });
  try {
    const q = probe.query("SELECT delivery_state AS s FROM messages WHERE id = ?");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((q.get(rowId) as { s: string } | null)?.s === state) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`row ${rowId} never reached '${state}' within ${timeoutMs}ms; the race never set up`);
  } finally {
    probe.close();
  }
}

beforeAll(async () => {
  // #22: the suites below are gated off win32, but Bun runs a file-scoped beforeAll even when
  // every suite in the file is skipped. This setup is POSIX-only (it writes a `#!/usr/bin/env bash`
  // tmux stub, chmods it executable, and spawns a broker), so guard it too: on win32 the gated
  // suites do not run, so nothing needs it; on POSIX this returns false and the setup runs as before.
  if (process.platform === "win32") return;
  // Stub tmux: reports a version (so the broker sees tmux available and a %pane registers as
  // 'tmux'), records argv, exits 0 — enough for a tmux recipient to take the push path.
  // A send-keys to SLOW_PANE sleeps, holding the delivery lease open long enough for a second
  // send to land mid-push. Only the lease-race tests register that pane; every other pane still
  // returns instantly, so the rest of the suite keeps its old timing.
  const stub = join(work, "tmux");
  writeFileSync(stub, `#!/usr/bin/env bash
if [ "$1" = "-V" ]; then echo "tmux 3.4"; exit 0; fi
_sk=0; _slow=0
for _a in "$@"; do
  [ "$_a" = "send-keys" ] && _sk=1
  [ "$_a" = "${SLOW_PANE}" ] && _slow=1
done
[ "$_sk" = 1 ] && [ "$_slow" = 1 ] && sleep 1
exit 0
`);
  chmodSync(stub, 0o755);
  writeFileSync(CONFIG_PATH, JSON.stringify({
    machine: "db-a", tailscale_ip: "127.0.0.1", port: PORT,
    id_prefix: "dba", siblings: [], allowed_ips: ["127.0.0.1"], db_path: DB_PATH,
  }));
  proc = Bun.spawn(["bun", "broker.ts"], {
    env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG_PATH, PATH: `${work}:${process.env.PATH}` },
    stdout: "ignore", stderr: "ignore",
  });
  writeFileSync(CONFIG_PATH_DRAIN, JSON.stringify({
    machine: "db-a", tailscale_ip: "127.0.0.1", port: PORT_DRAIN,
    id_prefix: "dbd", siblings: [], allowed_ips: ["127.0.0.1"], db_path: DB_PATH_DRAIN,
    push_delay_ms: PUSH_DELAY_MS,
  }));
  drainProc = Bun.spawn(["bun", "broker.ts"], {
    env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG_PATH_DRAIN, PATH: `${work}:${process.env.PATH}` },
    stdout: "ignore", stderr: "ignore",
  });
  await waitForHealth(PORT);
  await waitForHealth(PORT_DRAIN);
});

afterAll(async () => {
  // Await the exits, don't just signal them. kill() is a SIGTERM, and the broker's handler runs
  // retire(): it keeps serving on its fixed port while it drains, answering /health but refusing
  // /register with 503. Returning here without waiting leaves that window open across a
  // back-to-back run, whose health probe then passes against the PREVIOUS run's dying broker and
  // whose first register gets the 503.
  proc?.kill();
  drainProc?.kill();
  await Promise.all([proc?.exited, drainProc?.exited]);
  try { rmSync(work, { recursive: true, force: true }); } catch {}
});

describe("doorbell marker", () => {
  it("rings the doorbell for a none recipient with the new row id", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/none-1" });
    const sender = await regSender({ cwd: "/tmp/none-1-s" });
    expect(existsSync(doorbellPath(DB_PATH, rcpt.id) as string)).toBe(false); // none yet

    const send = await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "ring" }, sender.token);
    expect(send.delivery).toBe("queued"); // no pane -> floor

    const peek = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(readDoorbell(DB_PATH, rcpt.id)).toBe(peek.max_id); // marker == max pending id
    expect(peek.max_id).toBeGreaterThan(0);
  });

  it("advances the marker on each subsequent message (monotonic)", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/none-2" });
    const sender = await regSender({ cwd: "/tmp/none-2-s" });
    await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "one" }, sender.token);
    const first = readDoorbell(DB_PATH, rcpt.id);
    await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "two" }, sender.token);
    const second = readDoorbell(DB_PATH, rcpt.id);
    expect(second).toBeGreaterThan(first);
  });

  it("does not ring for a tmux recipient (it gets an active push instead)", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/tmux-1", tmux_pane: "%9" });
    const sender = await regSender({ cwd: "/tmp/tmux-1-s" });
    const send = await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "push" }, sender.token);
    expect(send.delivery).toBe("accepted");
    expect(existsSync(doorbellPath(DB_PATH, rcpt.id) as string)).toBe(false);
  });
});

// The doorbell's question is "will anything ever push this row to this recipient?", and there
// are two independent reasons the answer is no. Neither test sees the other's case:
//   - not push-eligible: deliverNext bails at !isPushableTarget, whatever push_after holds
//     (no pane, or no tmux backend on this host).
//   - outside the push channel: nextDeliverable filters `push_after IS NOT NULL`, whatever
//     the pane holds (an fyi, or a forward floored by floor_remote_forwards).
// handleForwardMessage already computes exactly that union to report `poll_only` to the
// sending broker; ringDoorbell asked a narrower question and disagreed with it about the
// same row. These lock the two conditions apart so neither can be dropped for the other.
describe("doorbell covers every row that will never be pushed", () => {
  it("rings for a floored remote forward to a tmux recipient", async () => {
    // Written from a live failure, 2026-07-16: a normal-urgency forward from a peer on another
    // machine landed with push_after NULL and sat unseen, its doorbell dir empty. The recipient
    // HAD a pane, so the old delivery_kind check skipped the bell; floor_remote_forwards set
    // push_after NULL, so nextDeliverable skipped the push. Mail with neither.
    const rcpt = await regRcpt({ cwd: "/tmp/fwd-tmux", tmux_pane: "%20" });
    const res = await ok("/forward-message", {
      protocol_version: PROTOCOL_VERSION, from_id: "remote-peer-x", to_id: rcpt.id,
      text: "from another machine", from_machine: "db-b", urgency: "normal",
    });
    expect(res.ok).toBe(true);
    expect(res.poll_only).toBe(true); // the broker's own verdict: nothing here will push

    const peek = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(peek.count).toBe(1);
    expect(readDoorbell(DB_PATH, rcpt.id)).toBe(peek.max_id);
  });

  it("rings for an fyi to a tmux recipient (poll-only, so the bell is its only signal)", async () => {
    // pushAfterFor('fyi') is NULL, so the row sits outside the push channel exactly like a
    // floored forward. A session that armed a watcher opted into hearing about poll-only mail.
    const rcpt = await regRcpt({ cwd: "/tmp/fyi-tmux", tmux_pane: "%21" });
    const sender = await regSender({ cwd: "/tmp/fyi-tmux-s" });
    await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "no rush", urgency: "fyi" }, sender.token);
    const peek = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(readDoorbell(DB_PATH, rcpt.id)).toBe(peek.max_id);
  });

  it("still rings for a none recipient whose row IS push-due", async () => {
    // The regression guard. pushAfterFor('interrupt') returns now, NOT null, so a fix written
    // as `push_after === null` alone would silently stop ringing for the very sessions the
    // doorbell was built for (#49) — they have no pane, so push_after is meaningless to them.
    const rcpt = await regRcpt({ cwd: "/tmp/none-interrupt" });
    const sender = await regSender({ cwd: "/tmp/none-interrupt-s" });
    await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "urgent", urgency: "interrupt" }, sender.token);
    const peek = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(peek.max_id).toBeGreaterThan(0);
    expect(readDoorbell(DB_PATH, rcpt.id)).toBe(peek.max_id);
  });

  it("does not ring for a tmux recipient whose row is only delayed", async () => {
    // The other half of the guard: `normal` sets push_after = now + push_delay_ms. Non-NULL
    // and the peer is push-eligible, so the row IS in the channel and the flush will carry it.
    // Ringing here would wake a session that is already going to be interrupted.
    const rcpt = await regRcpt({ cwd: "/tmp/tmux-normal", tmux_pane: "%22" });
    const sender = await regSender({ cwd: "/tmp/tmux-normal-s" });
    await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "later", urgency: "normal" }, sender.token);
    expect(existsSync(doorbellPath(DB_PATH, rcpt.id) as string)).toBe(false);
  });
});

// The marker means "your mail is readable up to here", not "it exists up to here". A poll
// releases only the contiguous queued prefix (releasableQueuedPrefix), stopping at an in-flight
// head to preserve ordering, so a ring during an open lease announces mail the woken session
// cannot yet read. It polls, gets nothing, re-arms at the new value, and — since a poll-only row
// is never pushed and nothing writes the marker again — the row strands until unrelated mail
// happens to ring. These two hold the withhold and the re-ring together: drop either half and a
// poll-only row that lands mid-push is silently lost.
//
// Only a tmux recipient can reach this. A delivery_kind='none' peer never has a row in
// 'delivering' at all (deliverNext bails at !isPushableTarget), so its poll always drains.
describe("a ring is withheld until the mail it announces is readable", () => {
  // Wait for the lease to actually exist rather than sleeping and hoping. A fixed sleep pins
  // the stub's wall-clock timing, not the invariant: on a slow box the fyi lands before
  // claimForDelivery, the race is never set up, and the test fails against correct code.
  // Read-only, and it throws rather than proceeding if the lease never appears — a race that
  // silently failed to happen would make these tests pass for the wrong reason.
  const waitForLease = async (toId: string, timeoutMs = 5000) => {
    const probe = new Database(DB_PATH, { readonly: true });
    try {
      const q = probe.query(
        "SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND delivery_state = 'delivering'");
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((q.get(toId) as { n: number }).n > 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no delivering row for ${toId} within ${timeoutMs}ms; the race never set up`);
    } finally {
      probe.close();
    }
  };

  const raceSetup = async (tag: string) => {
    const rcpt = await regRcpt({ cwd: `/tmp/${tag}`, tmux_pane: SLOW_PANE });
    const sender = await regSender({ cwd: `/tmp/${tag}-s` });
    // Not awaited: the stub stalls send-keys for ~1s, so this call is still in flight — and its
    // lease still open — while the fyi below lands.
    const push = ok("/send-message",
      { from_id: sender.id, to_id: rcpt.id, text: "slow push", urgency: "interrupt" }, sender.token);
    await waitForLease(rcpt.id);
    await ok("/send-message",
      { from_id: sender.id, to_id: rcpt.id, text: "fyi mid-push", urgency: "fyi" }, sender.token);
    return { rcpt, push };
  };

  it("does not ring while an older row is mid-push", async () => {
    const { rcpt, push } = await raceSetup("race-hold");
    // The fyi is poll-only, so nothing will ever push it — but the poll cannot release it yet
    // either. Ringing now would spend the counter's only advance on unreadable mail.
    expect(existsSync(doorbellPath(DB_PATH, rcpt.id) as string)).toBe(false);
    await push;
  });

  it("rings once the lease settles, so the withheld row is not stranded", async () => {
    const { rcpt, push } = await raceSetup("race-settle");
    await push; // lease resolves; the queued prefix is releasable again
    const peek = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(peek.count).toBe(1); // the pushed row is delivered; only the fyi is still pending
    expect(readDoorbell(DB_PATH, rcpt.id)).toBe(peek.max_id);
  });
});

// The withhold above only asks "is a lease open right now?", and that answer goes stale the
// instant the caller opens the next one. Both drivers do exactly that: the insert path rings and
// THEN calls deliverNext, and a settle inside deliverNext's finally rings while the caller's
// drain loop is still holding older pushable rows to send. Either way the marker is spent at an
// id the poll cannot reach, the woken session re-arms at that value (cli.ts arms at the marker's
// current value, not at what it drained), and the later settle rewrites the same max-pending id —
// no advance, no second wake, and the poll-only row strands until unrelated mail rings.
//
// So the bell may only ring when no lease is open AND none is coming: the end of the recipient's
// whole delivery burst. These pin both drivers.
describe("a ring waits for the recipient's whole delivery burst, not just one lease", () => {
  it("does not ring when the send's own deliverNext is about to claim an older due row", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/burst-insert", tmux_pane: SLOW_PANE }, PORT_DRAIN);
    const sender = await regSender({ cwd: "/tmp/burst-insert-s" }, PORT_DRAIN);
    // A `normal` row is push_after = now + PUSH_DELAY_MS: pushable, so no bell, and not yet due,
    // so deliverNext leaves it queued and claims no lease.
    await okAt(PORT_DRAIN, "/send-message",
      { from_id: sender.id, to_id: rcpt.id, text: "delayed", urgency: "normal" }, sender.token);
    const older = (await okAt(PORT_DRAIN, "/peek", { id: rcpt.id }, rcpt.token)).max_id;
    expect(existsSync(doorbellPath(DB_PATH_DRAIN, rcpt.id) as string)).toBe(false);
    await new Promise((r) => setTimeout(r, PUSH_DELAY_MS + 200)); // the older row is now push-due

    // The fyi lands with no lease open, so the insert-time bell sees a clear queue — but this
    // very request's deliverNext claims the older due row next, retracting the readability the
    // bell just announced. Not awaited: the stub stalls that push, so the sample below lands
    // inside the window.
    const fyi = okAt(PORT_DRAIN, "/send-message",
      { from_id: sender.id, to_id: rcpt.id, text: "fyi", urgency: "fyi" }, sender.token);
    await waitForRowState(DB_PATH_DRAIN, older, "delivering");
    expect(existsSync(doorbellPath(DB_PATH_DRAIN, rcpt.id) as string)).toBe(false);

    await fyi;
    const peek = await okAt(PORT_DRAIN, "/peek", { id: rcpt.id }, rcpt.token);
    expect(peek.count).toBe(1); // the pushed row is delivered; only the fyi is still pending
    expect(readDoorbell(DB_PATH_DRAIN, rcpt.id)).toBe(peek.max_id);
  }, 20_000);

  it("does not ring while the drain still has an older pushable row to send", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/burst-drain", tmux_pane: SLOW_PANE }, PORT_DRAIN);
    const sender = await regSender({ cwd: "/tmp/burst-drain-s" }, PORT_DRAIN);
    // Two delayed pushable rows: neither is claimed on insert, so the drain below has more than
    // one lease to take — the case a single settle cannot see the end of.
    await okAt(PORT_DRAIN, "/send-message",
      { from_id: sender.id, to_id: rcpt.id, text: "one", urgency: "normal" }, sender.token);
    const first = (await okAt(PORT_DRAIN, "/peek", { id: rcpt.id }, rcpt.token)).max_id;
    await okAt(PORT_DRAIN, "/send-message",
      { from_id: sender.id, to_id: rcpt.id, text: "two", urgency: "normal" }, sender.token);
    const second = (await okAt(PORT_DRAIN, "/peek", { id: rcpt.id }, rcpt.token)).max_id;
    await new Promise((r) => setTimeout(r, PUSH_DELAY_MS + 200)); // both are now push-due

    // An interrupt starts the burst: its own row rings nothing (it is pushable), and its
    // deliverNext takes the head-of-line lease, so the fyi below is withheld for the right
    // reason — leaving only the settle-side driver under test.
    const push = okAt(PORT_DRAIN, "/send-message",
      { from_id: sender.id, to_id: rcpt.id, text: "now", urgency: "interrupt" }, sender.token);
    await waitForRowState(DB_PATH_DRAIN, first, "delivering");
    await okAt(PORT_DRAIN, "/send-message",
      { from_id: sender.id, to_id: rcpt.id, text: "fyi mid-drain", urgency: "fyi" }, sender.token);

    // The first lease settles here, but the drain claims `second` immediately after. Ringing on
    // that settle spends the counter on mail the next claim makes unreadable again.
    await waitForRowState(DB_PATH_DRAIN, second, "delivering");
    expect(existsSync(doorbellPath(DB_PATH_DRAIN, rcpt.id) as string)).toBe(false);

    await push;
    const peek = await okAt(PORT_DRAIN, "/peek", { id: rcpt.id }, rcpt.token);
    expect(peek.count).toBe(1); // all three pushable rows delivered; only the fyi is pending
    expect(readDoorbell(DB_PATH_DRAIN, rcpt.id)).toBe(peek.max_id);
  }, 30_000);

  // Every case above rings at the recipient's max pending id, which is right while that id only
  // climbs. It does not climb here. A settle fires whenever a burst ends, and a burst that
  // delivers a LATER pushable row while an EARLIER poll-only row waits leaves a smaller max
  // pending id behind than the settle before it rang. Ringing that id walks the marker backwards,
  // under a watcher that already armed at the higher one and now cannot fire.
  it("holds the marker when a burst delivers a later row than the waiting poll-only one", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/burst-mixed", tmux_pane: "%12" }, PORT_DRAIN);
    const sender = await regSender({ cwd: "/tmp/burst-mixed-s" }, PORT_DRAIN);
    // Nothing ever pushes an fyi, so it rings and then waits for a check_messages.
    await okAt(PORT_DRAIN, "/send-message",
      { from_id: sender.id, to_id: rcpt.id, text: "fyi", urgency: "fyi" }, sender.token);
    const fyiId = (await okAt(PORT_DRAIN, "/peek", { id: rcpt.id }, rcpt.token)).max_id;
    expect(readDoorbell(DB_PATH_DRAIN, rcpt.id)).toBe(fyiId);

    // A later `normal` row is pushable but not yet due, so this send delivers nothing and its
    // settle rings the higher id. This is the value a woken watcher arms at.
    await okAt(PORT_DRAIN, "/send-message",
      { from_id: sender.id, to_id: rcpt.id, text: "delayed", urgency: "normal" }, sender.token);
    const normalId = (await okAt(PORT_DRAIN, "/peek", { id: rcpt.id }, rcpt.token)).max_id;
    expect(normalId).toBeGreaterThan(fyiId);
    const armed = readDoorbell(DB_PATH_DRAIN, rcpt.id);
    expect(armed).toBe(normalId);

    // The row comes due and a heartbeat drains it, so the fyi is all that is left pending.
    await new Promise((r) => setTimeout(r, PUSH_DELAY_MS + 200));
    await okAt(PORT_DRAIN, "/heartbeat", { id: rcpt.id }, rcpt.token);

    const peek = await okAt(PORT_DRAIN, "/peek", { id: rcpt.id }, rcpt.token);
    expect(peek.count).toBe(1);      // the pushed row is delivered
    expect(peek.max_id).toBe(fyiId); // and max pending id really has fallen back to the fyi
    // The marker must not follow it down. A watcher armed at `armed` would never fire again, and
    // the fyi would strand until unrelated mail climbed back past it.
    expect(readDoorbell(DB_PATH_DRAIN, rcpt.id)).toBe(armed);
  }, 20_000);
});

// The reconcile runs at startup, so everything it reaches must already be initialized. It calls
// ringDoorbellAfterSettle -> isPushableTarget -> tmuxAvailable, and tmuxAvailable closes over a
// `let` declared further down the module: reading it from a startup statement is a temporal dead
// zone throw, and the broker dies before it ever listens. Only a tmux recipient reaches it —
// isPushableTarget short-circuits on kind !== 'tmux' — which is exactly the backlog shape this
// reconcile exists to repair.
describe("startup reconcile over a persisted poll-only backlog", () => {
  it("starts, and rings, when a tmux recipient already holds a queued poll-only row", async () => {
    const PORT_BOOT = 17942;
    const DB_PATH_BOOT = join(work, "boot.db");
    const CONFIG_PATH_BOOT = join(work, "boot-config.json");
    writeFileSync(CONFIG_PATH_BOOT, JSON.stringify({
      machine: "db-a", tailscale_ip: "127.0.0.1", port: PORT_BOOT,
      id_prefix: "dbb", siblings: [], allowed_ips: ["127.0.0.1"], db_path: DB_PATH_BOOT,
    }));
    const spawnBroker = () => Bun.spawn(["bun", "broker.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG_PATH_BOOT, PATH: `${work}:${process.env.PATH}` },
      stdout: "ignore", stderr: "ignore",
    });

    let boot = spawnBroker();
    try {
      expect(await waitForHealth(PORT_BOOT)).toBe(true);
      const rcpt = await regRcpt({ cwd: "/tmp/boot-tmux", tmux_pane: "%30" }, PORT_BOOT);
      const sender = await regSender({ cwd: "/tmp/boot-tmux-s" }, PORT_BOOT);
      await okAt(PORT_BOOT, "/send-message",
        { from_id: sender.id, to_id: rcpt.id, text: "fyi", urgency: "fyi" }, sender.token);
      const peek = await okAt(PORT_BOOT, "/peek", { id: rcpt.id }, rcpt.token);
      expect(peek.count).toBe(1);

      boot.kill();
      await boot.exited;
      // Drop the marker the live broker wrote, so what the restart reports is the reconcile's own
      // work and not a leftover file.
      rmSync(doorbellPath(DB_PATH_BOOT, rcpt.id) as string, { force: true });

      boot = spawnBroker();
      expect(await waitForHealth(PORT_BOOT)).toBe(true);
      expect(readDoorbell(DB_PATH_BOOT, rcpt.id)).toBe(peek.max_id);
    } finally {
      boot.kill();
      await boot.exited; // same fixed-port handover as afterAll: drain before the next run binds
    }
  }, 30_000);

  // push_after is computed from urgency alone at insert and never from the target, so a peer
  // this host cannot push to still gets a push_after on a normal or interrupt row. Nothing will
  // ever push it: isPollOnly reads (push_after === null) OR (target not pushable), and only the
  // second disjunct is true here. A reconcile keyed on "push_after IS NULL" asks the first and
  // so cannot see this backlog at all.
  it("rings for a none recipient whose queued row carries a push_after", async () => {
    const PORT_NONE = 17944;
    const DB_PATH_NONE = join(work, "none-boot.db");
    const CONFIG_PATH_NONE = join(work, "none-boot-config.json");
    writeFileSync(CONFIG_PATH_NONE, JSON.stringify({
      machine: "db-a", tailscale_ip: "127.0.0.1", port: PORT_NONE,
      id_prefix: "dbn", siblings: [], allowed_ips: ["127.0.0.1"], db_path: DB_PATH_NONE,
    }));
    const spawnBroker = () => Bun.spawn(["bun", "broker.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG_PATH_NONE, PATH: `${work}:${process.env.PATH}` },
      stdout: "ignore", stderr: "ignore",
    });

    let boot = spawnBroker();
    try {
      expect(await waitForHealth(PORT_NONE)).toBe(true);
      // No pane: delivery_kind 'none', so isPushableTarget is false for every row it holds.
      const rcpt = await regRcpt({ cwd: "/tmp/boot-none", tmux_pane: null }, PORT_NONE);
      const sender = await regSender({ cwd: "/tmp/boot-none-s" }, PORT_NONE);
      await okAt(PORT_NONE, "/send-message",
        { from_id: sender.id, to_id: rcpt.id, text: "normal", urgency: "normal" }, sender.token);
      const peek = await okAt(PORT_NONE, "/peek", { id: rcpt.id }, rcpt.token);
      expect(peek.count).toBe(1);

      const probe = new Database(DB_PATH_NONE, { readonly: true });
      const row = probe.query(
        "SELECT push_after FROM messages WHERE to_id = ? ORDER BY id DESC LIMIT 1",
      ).get(rcpt.id) as { push_after: number | null };
      probe.close();
      // The premise: poll-only by target, yet carrying a push_after. If this ever goes null the
      // test below passes for a reason that has nothing to do with the reconcile.
      expect(row.push_after).not.toBeNull();

      boot.kill();
      await boot.exited;
      // writeDoorbell swallows its own IO errors and the marker lives outside the db, so a lost
      // or unwritten marker is exactly the state the reconcile exists to repair.
      rmSync(doorbellPath(DB_PATH_NONE, rcpt.id) as string, { force: true });

      boot = spawnBroker();
      expect(await waitForHealth(PORT_NONE)).toBe(true);
      expect(readDoorbell(DB_PATH_NONE, rcpt.id)).toBe(peek.max_id);
    } finally {
      boot.kill();
      await boot.exited;
    }
  }, 30_000);

  // The other half: a recipient whose backlog still has a push coming must NOT be rung here.
  // resetDeliveringOnStart requeues every lease before this runs, so ringDoorbellAfterSettle's
  // own "is anything delivering?" guard sees zero and cannot see the push one heartbeat away.
  it("stays silent when a push is still coming, and rings once it settles", async () => {
    const PORT_MIX = 17945;
    const DB_PATH_MIX = join(work, "mix-boot.db");
    const CONFIG_PATH_MIX = join(work, "mix-boot-config.json");
    writeFileSync(CONFIG_PATH_MIX, JSON.stringify({
      machine: "db-a", tailscale_ip: "127.0.0.1", port: PORT_MIX,
      id_prefix: "dbm", siblings: [], allowed_ips: ["127.0.0.1"], db_path: DB_PATH_MIX,
      push_delay_ms: 600_000,
    }));
    const spawnBroker = () => Bun.spawn(["bun", "broker.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG_PATH_MIX, PATH: `${work}:${process.env.PATH}` },
      stdout: "ignore", stderr: "ignore",
    });

    let boot = spawnBroker();
    try {
      expect(await waitForHealth(PORT_MIX)).toBe(true);
      const rcpt = await regRcpt({ cwd: "/tmp/boot-mix", tmux_pane: SLOW_PANE }, PORT_MIX);
      const sender = await regSender({ cwd: "/tmp/boot-mix-s" }, PORT_MIX);
      // The long push_delay_ms keeps this queued rather than pushed while the broker is up.
      await okAt(PORT_MIX, "/send-message",
        { from_id: sender.id, to_id: rcpt.id, text: "pushable", urgency: "normal" }, sender.token);
      await okAt(PORT_MIX, "/send-message",
        { from_id: sender.id, to_id: rcpt.id, text: "poll only", urgency: "fyi" }, sender.token);
      const peek = await okAt(PORT_MIX, "/peek", { id: rcpt.id }, rcpt.token);
      expect(peek.count).toBe(2);

      boot.kill();
      await boot.exited;
      rmSync(doorbellPath(DB_PATH_MIX, rcpt.id) as string, { force: true });
      // A broker down long enough for its delayed rows to come due is the ordinary case; make
      // the older row due so the restart's heartbeat claims it, without waiting out the delay.
      const rw = new Database(DB_PATH_MIX);
      rw.run("UPDATE messages SET push_after = ? WHERE to_id = ? AND push_after IS NOT NULL",
        [Date.now() - 1000, rcpt.id]);
      rw.close();

      boot = spawnBroker();
      // The reconcile is synchronous after the port bind, so a served /health proves it has
      // already run: no handler, and no heartbeat, can interleave ahead of it.
      expect(await waitForHealth(PORT_MIX)).toBe(true);
      expect(existsSync(doorbellPath(DB_PATH_MIX, rcpt.id) as string)).toBe(false);

      // Silence is only correct if the bell still arrives by the other road. The recipient's
      // own heartbeat is what claims a due row -- there is no broker-side push timer -- and it
      // awaits the whole burst, so the settle, and its ring, are done when this returns.
      await okAt(PORT_MIX, "/heartbeat", { id: rcpt.id }, rcpt.token);

      // Assert the push actually happened before reading the marker. The heartbeat's burst rings
      // from its finally whatever the drain did, so the fyi row alone is enough to produce the
      // expected marker -- this test would pass on a broker that never claimed the older row at
      // all, and would then be asserting nothing about the skip it exists to justify.
      const probe = new Database(DB_PATH_MIX, { readonly: true });
      const states = probe.query(
        "SELECT delivery_state, push_after FROM messages WHERE to_id = ? ORDER BY id",
      ).all(rcpt.id) as { delivery_state: string; push_after: number | null }[];
      probe.close();
      expect(states.map((s) => s.delivery_state)).toEqual(["delivered", "queued"]);
      expect(states[1].push_after).toBeNull(); // the survivor is the poll-only row, not a push

      expect(readDoorbell(DB_PATH_MIX, rcpt.id)).toBe(peek.max_id);
    } finally {
      boot.kill();
      await boot.exited;
    }
  }, 30_000);

  // The test above makes the pushable row due before the restart, which is why silence is right
  // there: a burst is one heartbeat away. Leave it ahead instead and the same skip is wrong --
  // nothing claims a row that is not due, so nothing settles and nothing rings, and the poll-only
  // row behind it waits out a push_delay_ms it has no part in. "A push exists" and "a push is
  // due" are the same question only until a delay separates them, and nextDeliverable has always
  // asked the second.
  it("rings for a poll-only row when the push behind it is not due yet", async () => {
    const PORT_LATE = 17946;
    const DB_PATH_LATE = join(work, "late-boot.db");
    const CONFIG_PATH_LATE = join(work, "late-boot-config.json");
    writeFileSync(CONFIG_PATH_LATE, JSON.stringify({
      machine: "db-a", tailscale_ip: "127.0.0.1", port: PORT_LATE,
      id_prefix: "dbl", siblings: [], allowed_ips: ["127.0.0.1"], db_path: DB_PATH_LATE,
      push_delay_ms: 600_000,
    }));
    const spawnBroker = () => Bun.spawn(["bun", "broker.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG_PATH_LATE, PATH: `${work}:${process.env.PATH}` },
      stdout: "ignore", stderr: "ignore",
    });

    let boot = spawnBroker();
    try {
      expect(await waitForHealth(PORT_LATE)).toBe(true);
      const rcpt = await regRcpt({ cwd: "/tmp/boot-late", tmux_pane: SLOW_PANE }, PORT_LATE);
      const sender = await regSender({ cwd: "/tmp/boot-late-s" }, PORT_LATE);
      await okAt(PORT_LATE, "/send-message",
        { from_id: sender.id, to_id: rcpt.id, text: "not due for ten minutes", urgency: "normal" }, sender.token);
      await okAt(PORT_LATE, "/send-message",
        { from_id: sender.id, to_id: rcpt.id, text: "poll only", urgency: "fyi" }, sender.token);
      const peek = await okAt(PORT_LATE, "/peek", { id: rcpt.id }, rcpt.token);
      expect(peek.count).toBe(2);

      boot.kill();
      await boot.exited;
      // The lost marker the reconcile exists to repair. Unlike the test above, push_after is left
      // where it was: ten minutes out, and the restart cannot claim it.
      rmSync(doorbellPath(DB_PATH_LATE, rcpt.id) as string, { force: true });

      boot = spawnBroker();
      expect(await waitForHealth(PORT_LATE)).toBe(true);

      // Prove the push really is still withheld, so this is testing the skip and not a broker
      // that quietly delivered everything.
      const probe = new Database(DB_PATH_LATE, { readonly: true });
      const states = probe.query(
        "SELECT delivery_state FROM messages WHERE to_id = ? ORDER BY id",
      ).all(rcpt.id) as { delivery_state: string }[];
      probe.close();
      expect(states.map((s) => s.delivery_state)).toEqual(["queued", "queued"]);

      expect(readDoorbell(DB_PATH_LATE, rcpt.id)).toBe(peek.max_id);
    } finally {
      boot.kill();
      await boot.exited;
    }
  }, 30_000);

  // The reconcile is the only doorbell write that runs without an HTTP request behind it, so it
  // is the only one that can happen in a broker that never serves. ensureBroker() checks /health
  // and then spawns, which is a check-then-act: two sessions racing that gap both spawn, and the
  // loser of the port bind is still a live process with the db open until Bun.serve throws.
  // writeDoorbell's clamp is a read-then-write, safe only for a single writer -- and two of these
  // interleaving leave a torn count ("10" over "9" truncates at open, not at write, so the file
  // reads "90"). Ringing only after the bind is what makes the winner the sole writer, so a
  // second process cannot exist to interleave with. Verified against Bun: a taken port throws out
  // of Bun.serve, and nothing catches it here.
  it("writes no marker when it loses the port bind", async () => {
    const PORT_LOSER = 17943;
    const DB_PATH_LOSER = join(work, "loser.db");
    const CONFIG_PATH_LOSER = join(work, "loser-config.json");
    writeFileSync(CONFIG_PATH_LOSER, JSON.stringify({
      machine: "db-a", tailscale_ip: "127.0.0.1", port: PORT_LOSER,
      id_prefix: "dbl", siblings: [], allowed_ips: ["127.0.0.1"], db_path: DB_PATH_LOSER,
    }));
    const spawnBroker = () => Bun.spawn(["bun", "broker.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG_PATH_LOSER, PATH: `${work}:${process.env.PATH}` },
      stdout: "ignore", stderr: "ignore",
    });

    // Leave a persisted poll-only backlog, which is the one shape the reconcile rings for.
    const first = spawnBroker();
    let marker: string;
    try {
      expect(await waitForHealth(PORT_LOSER)).toBe(true);
      const rcpt = await regRcpt({ cwd: "/tmp/loser-tmux", tmux_pane: "%31" }, PORT_LOSER);
      const sender = await regSender({ cwd: "/tmp/loser-tmux-s" }, PORT_LOSER);
      await okAt(PORT_LOSER, "/send-message",
        { from_id: sender.id, to_id: rcpt.id, text: "fyi", urgency: "fyi" }, sender.token);
      expect((await okAt(PORT_LOSER, "/peek", { id: rcpt.id }, rcpt.token)).count).toBe(1);
      marker = doorbellPath(DB_PATH_LOSER, rcpt.id) as string;
    } finally {
      first.kill();
      await first.exited;
    }
    // Drop the marker the live broker wrote. Anything here afterwards was written by the loser.
    rmSync(marker, { force: true });
    expect(existsSync(marker)).toBe(false);

    // Hold the port with something that is not a broker, so the losing broker is provably the
    // only process that could write the marker -- a real broker here could ring on its own.
    const squatter = Bun.serve({ port: PORT_LOSER, hostname: "0.0.0.0", fetch: () => new Response("squat") });
    try {
      const loser = spawnBroker();
      await loser.exited; // the bind throws, uncaught, so this must terminate on its own
      expect(existsSync(marker)).toBe(false);
    } finally {
      squatter.stop(true);
    }
  }, 30_000);
});

describe("/peek (non-consuming read)", () => {
  it("reports count and max_id without flipping rows to delivered", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/peek-1" });
    const sender = await regSender({ cwd: "/tmp/peek-1-s" });
    await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "a" }, sender.token);
    await ok("/send-message", { from_id: sender.id, to_id: rcpt.id, text: "b" }, sender.token);

    const peek = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(peek.id).toBe(rcpt.id);
    expect(peek.count).toBe(2);
    expect(peek.max_id).toBeGreaterThan(0);

    // A peek must not consume: the mail is still retrievable, and a second peek is identical.
    const peek2 = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(peek2.count).toBe(2);
    const poll = await ok("/poll-messages", { id: rcpt.id }, rcpt.token);
    expect(poll.messages).toHaveLength(2);
    // After consuming, peek reports an empty backlog.
    const peek3 = await ok("/peek", { id: rcpt.id }, rcpt.token);
    expect(peek3.count).toBe(0);
    expect(peek3.max_id).toBeNull();
  });

  it("is token-gated to the caller's id", async () => {
    const rcpt = await regRcpt({ cwd: "/tmp/peek-auth" });
    expect((await call("/peek", { id: rcpt.id })).status).toBe(401); // no token
    expect((await call("/peek", { id: rcpt.id }, "wrong-token")).status).toBe(401); // wrong token
    expect((await call("/peek", { id: rcpt.id }, rcpt.token)).status).toBe(200); // own token
  });
});

describe("cli.ts doorbell watcher", () => {
  it("blocks until the marker advances past the baseline, then prints and exits 0", async () => {
    const id = "dba-watchme";
    writeDoorbell(DB_PATH, id, 3); // an existing marker; --since 3 means only >3 wakes us
    const watcher = Bun.spawn(["bun", "cli.ts", "doorbell", id, "--since", "3", "--poll-ms", "300"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CLAUDE_PEERS_CONFIG: CONFIG_PATH },
      stdout: "pipe", stderr: "ignore",
    });
    // Give it a beat to arm the watch, then ring with a higher counter.
    await new Promise((r) => setTimeout(r, 600));
    writeDoorbell(DB_PATH, id, 7);
    const exited = await Promise.race([
      watcher.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 6000)),
    ]);
    const out = await new Response(watcher.stdout).text();
    if (exited === "timeout") { watcher.kill(); throw new Error("doorbell did not wake within 6s"); }
    expect(exited).toBe(0);
    expect(out).toContain(`mail for ${id} (mark=7)`);
  }, 12_000);
});
