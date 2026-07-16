// tests/doorbell.test.ts — broker side of the doorbell + /peek feature (issue #49).
//
// Spins up a real broker (with a stub tmux so a tmux recipient genuinely registers as 'tmux')
// and asserts: a send to a delivery_kind='none' recipient writes the marker with the new row
// id; a send to a tmux recipient writes no marker (it already gets an active push); /peek
// reports the backlog without consuming it; and /peek is token-gated to the caller's id.

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

async function call(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${PORT}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function ok(path: string, body: unknown, token?: string) {
  const res = await call(path, body, token);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json() as any;
}
// A recipient must be a LIVE pid (sends check recipient liveness), so it uses this process's
// pid. A same-pid re-register supersedes the prior row, so only one live recipient exists at a
// time — fine, since each test uses its own and never references a prior test's recipient.
function regRcpt(overrides: Record<string, unknown> = {}) {
  return ok("/register", {
    pid: process.pid, cwd: "/tmp/db", git_root: null, tty: null, summary: "",
    machine: "db-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null, ...overrides,
  });
}
// A sender is never a delivery target and its liveness is never probed, so it can use a unique
// fake pid — which also keeps it from superseding the live recipient's same-pid row.
let fakePid = 900_000;
function regSender(overrides: Record<string, unknown> = {}) {
  return ok("/register", {
    pid: ++fakePid, cwd: "/tmp/db-s", git_root: null, tty: null, summary: "",
    machine: "db-a", tailscale_ip: "127.0.0.1", tmux_pane: null, tmux_socket: null, ...overrides,
  });
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
  for (let i = 0; i < 20; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
});

afterAll(() => {
  proc?.kill();
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
  const raceSetup = async (tag: string) => {
    const rcpt = await regRcpt({ cwd: `/tmp/${tag}`, tmux_pane: SLOW_PANE });
    const sender = await regSender({ cwd: `/tmp/${tag}-s` });
    // Not awaited: the stub stalls send-keys for ~1s, so this call is still in flight — and its
    // lease still open — while the fyi below lands.
    const push = ok("/send-message",
      { from_id: sender.id, to_id: rcpt.id, text: "slow push", urgency: "interrupt" }, sender.token);
    await new Promise((r) => setTimeout(r, 250)); // let deliverNext claim the lease
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
