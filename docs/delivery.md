# Message delivery

[Documentation index](README.md)

## Choose urgency

| Urgency | Local recipient with a ready tmux pane | Recipient without a push backend |
| --- | --- | --- |
| `interrupt` | Eligible for immediate push. | Queued for polling. |
| `normal` | Queued until polled or push-due, after `push_delay_ms` (two minutes by default). | Queued for polling. |
| `fyi` | Poll-only; never auto-pushed. | Queued for polling. |

The MCP tool defaults to `normal`. The CLI `send` command defaults to `interrupt`. Set urgency explicitly when that difference matters.

When one message becomes due, the broker promotes the recipient's other pending pushable messages into the same flush. A `normal` row can therefore be pushed before its own deadline. Poll-only rows stay outside the push channel.

A receiving broker with the default `floor_remote_forwards: true` keeps all remote forwards poll-only, including `interrupt`. With the floor disabled, the receiving broker can push eligible messages through its own delivery path. The sender never types into a pane on another host. Older receiving brokers may ignore urgency; see [mixed-version limits](compatibility.md#remote-urgency-during-old-broker-upgrades).

## What a send result proves

A send can report a local push, a local queue, or a remote queue. For remote queues, the result distinguishes poll-only, push-eligible, and unknown eligibility when the broker cannot establish it.

A push means a guarded terminal write passed the broker's transport checks. A poll means the returned rows were marked delivered. Neither proves that the model read, understood, or completed the request. Get an explicit reply when completion matters.

A peer ID addresses one live registration. Removing that peer also removes its queued mail. This is short-lived coordination, not a durable job queue.

## Tmux push

Start the client inside tmux so its MCP server inherits the pane and socket information. The broker uses bracketed paste to inject text into that pane, strips C0/C1 control characters, and checks the pane before sending. A known bare-shell foreground process defers the push.

The pane guard is a shell denylist, not proof that a particular client is ready. A successful paste also does not guarantee model processing. Client and platform evidence is recorded in the [support matrix](compatibility.md#client-and-delivery-matrix).

The server heartbeats every 15 seconds. A normal message becomes eligible after its deadline and is ordinarily attempted on a subsequent heartbeat, so the delay is not an exact delivery timer.

After five consecutive counted send failures on a row, the broker demotes the recipient's queued pushable backlog to poll-only and signals the doorbell. This preserves readable mail instead of retrying a broken pane forever. A pane-not-ready defer or a host-side spawn/timeout fault does not count as a failed send. Newly arriving mail can try push again.

## Polling

Call `check_messages` at task boundaries or when notified. It consumes the readable queued prefix; a second call does not return the same settled rows. An in-flight delivery lease can temporarily prevent later rows from being returned.

`peek_messages` reports your ID, pending count, and highest pending message ID without consuming. A positive count is not a promise that every row is immediately readable while delivery is in progress.

No MCP notification in this package forces an idle client to start a turn. Without a usable push backend or a client-integrated watcher, mail waits for the next poll.

## Doorbell watcher

The doorbell signals readable poll-only mail. It covers non-tmux recipients, `fyi` messages, default-floored remote forwards, and mail demoted after repeated push failures.

The broker writes a content-free counter to `<db_path>.doorbells/<peer-id>.mark`. The CLI watches it using filesystem events with a polling fallback. It does not read message bodies or consume mail.

A client harness must notice the watcher's completion or output and schedule a turn. Running the command in an unrelated terminal only prints a signal; it does not automatically wake an idle model.

### Session startup handoff

The MCP initialization instructions now ask the session to call `peek_messages` before ordinary work. That response always includes a launch recipe, including when mail is already queued. It is a host-assisted startup instruction, **not an automatic MCP-to-host task API**. A client may ignore server instructions, disable background commands, or fail to wake an idle turn. In those cases the doorbell remains unsupported/unarmed and the client must poll explicitly.

`peek_messages.structuredContent.doorbell` contains `peer_id`, `state: "requires_host_launch"`, and an `argv` array. The array pins the server's executable, absolute CLI path, resolved database path, authenticated peer ID, marker baseline, and owning MCP server PID. Pass those arguments unchanged to a process API. For a shell tool, quote every argument using that shell's rules; do not join the array into an unquoted command. The same recipe is included in text for clients that do not expose structured results. It contains no capability token or message body. The task must run on the same host/filesystem as the MCP server; a remote or sandboxed host that cannot access these paths must report the integration unsupported.

The host integration contract is:

1. On startup/resume, obtain the recipe through this session's `peek_messages`. Retain one background task handle per peer; if that task is still live, reuse it. In Claude Code, launch through Bash with `run_in_background: true`. Other clients need an equivalent task whose completion schedules a session turn; a detached process or a command running in an unrelated terminal is insufficient.
2. Launch the recipe, then call `check_messages`, including for a zero pending count. The recipe snapshots the marker before launch and drain. If the host starts the child late, the explicit `--since` still catches any intervening advance. Wait for `doorbell armed` when the host supports reading task output. Do not report armed from the recipe or a task handle alone.
3. On exit `0` (mail signal), call `peek_messages` for a fresh baseline, launch the next watcher, then call `check_messages`. A signal can race a drain and produce an empty check; it does not prove mail is still queued. Do not blindly reuse an old baseline, which can repeatedly wake for already-consumed mail.
4. On a changed peer ID, cancel the old task and use the new recipe. Cancel the task on session end or MCP disconnect. The watcher additionally stops when its MCP owner PID is gone or the peer's marker is removed; PID liveness is a fallback, not a replacement for host cancellation (PIDs can be reused).

Managed recipes use `--exclusive`: a file created with exclusive-create at `<marker>.watcher` prevents two cooperating managed watchers for the same peer/database. Exit `3` means blocked, **not armed**. Retain the original host-owned task. This does not adopt or wake through an existing unrelated task, and legacy watchers without `--exclusive` are outside the guard; cancel them before adopting the managed recipe. A crash/hard kill may leave a stale lock. Verify the recorded watcher PID and the host task have both stopped before removing that exact `.watcher` file. Never delete the `.mark` file to reset a watcher. Ordinary completion, timeout and handled cancellation remove the lock.

Watcher exit codes: `0` mail signal, `1` invalid arguments or filesystem failure, `2` timeout, `3` duplicate/stale lock, `4` cancellation/owner exit/peer removal. Only mail completion should trigger the normal rearm-and-drain loop. Investigate other exits rather than repeatedly relaunching. The readiness line names `watch+poll` or the polling fallback; both only observe a counter. Registration is the MCP peer identity, pending counts are queued mail, readiness is an armed local watcher, and consumption happens only through `check_messages`. The server does not claim to observe host task ownership or successful model wake-up.

### Adoption and existing sessions

The launch recipe resolves even a relative no-config `CLAUDE_PEERS_DB` override against the MCP working directory, so a host task started elsewhere reads the same marker. Readiness requires a readable regular file containing a valid counter, including when `--since` supplies the baseline. Startup validation failures exit `1` without reporting armed. After arming, a read failure reports degraded immediately; a successful read reports recovery. Failure lasting at least two polling intervals exits `1` and releases the guard. This grace handles brief empty reads during in-place broker writes; filesystem-watch failure alone still falls back to polling if the counter is readable.

This change does not install a host hook or restart a session. After adopting the updated checkout/package, a new MCP server process must load it. The shipped source and package launchers run ordinary Bun processes; neither uses `--hot`/`--watch` or implements a release updater. Publishing a release, fetching Git changes, or replacing files therefore does not hot-reload an already-running MCP process. A host may offer its own reconnect/restart feature, but that behavior is outside this fork and must be verified for that host. Future sessions also need the background-completion facility and must follow the startup handoff. This does not promise to repair an already-idle session.

For deterministic startup without relying on model-followed instructions, the missing host hook must run **after MCP registration**, invoke `peek_messages`, launch/retain/cancel a session-owned background task, and enqueue a turn on completion. A shell-only SessionStart hook does not supply those operations. No such Grok-specific adapter ships in this repository; the subprocess tests verify the launch contract, not a live Grok wake.

### Manual watcher

Use this order:

1. Call `peek_messages` to learn your peer ID.
2. Start the watcher as a background task in your client harness.
3. Once it is armed, call `check_messages` to drain existing mail.
4. When the watcher reports mail, re-arm it **before** calling `check_messages` again.

From the checkout:

```bash
bun cli.ts doorbell <your-peer-id>
```

Without a harness background-task feature, use manual polling. The command blocks until a new marker advance; merely launching it is not a mail read.

Arming before checking closes the gap where mail could arrive between a poll and the next watch baseline. Keep the watcher's config and database path identical to the broker's.

| Option | Meaning |
| --- | --- |
| `--since <id>` | Wake only above a known message ID. |
| `--timeout <sec>` | Stop waiting after the specified interval. |
| `--watch` | Stay running and print each advance instead of exiting after the first. The harness must watch output rather than process completion. |
| `--poll-ms <ms>` | Set the fallback poll interval; default `3000`. |
| `--db-path <path>` | Use the server's resolved store path, independently of the watcher's config or cwd. |
| `--owner-pid <pid>` | Stop when this MCP server exits or the marker is removed. The host still owns cancellation. |
| `--exclusive` | Refuse a second managed watcher for the same peer/database; exit `3` on an existing lock. |

The broker withholds a bell while a delivery attempt prevents the pending prefix from being read, then reevaluates it when that attempt settles. A watcher is a notification aid, not a second delivery channel.

## Push coalescing

`coalesce_pushes: true` opts into a single tmux paste containing up to eight queued pushable messages and 64 KiB. It defaults to false. An oversized head message sends alone so it does not block younger mail.

Each message retains its own ID tag, lease, confirmation, and retry state. Coalescing does not turn `fyi` or floored forwards into pushes. It groups a pending backlog; it does not add a debounce wait to collect future mail.

## Recovery and ordering

Messages move through `queued`, `delivering`, and `delivered` with five-second delivery leases. Failed attempts return to the queue; expired or holderless leases are reclaimed. A broker restart can preserve a live server's registration and queued mail when it uses the same database.

Ordering is maintained within the pushable channel and the readable polling prefix. There is no global FIFO guarantee across push and poll: a poll-only message does not block newer pushable mail indefinitely.

The product does not promise exactly-once processing or permanent history. See [identity and retention](compatibility.md#identity-resume-and-retention) and [operations](operations.md#identity-and-retention) for lifecycle limits.
