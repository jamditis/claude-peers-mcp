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
