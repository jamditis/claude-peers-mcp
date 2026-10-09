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

The broker withholds a bell while a delivery attempt prevents the pending prefix from being read, then reevaluates it when that attempt settles. A watcher is a notification aid, not a second delivery channel.

## Push coalescing

`coalesce_pushes: true` opts into a single tmux paste containing up to eight queued pushable messages and 64 KiB. It defaults to false. An oversized head message sends alone so it does not block younger mail.

Each message retains its own ID tag, lease, confirmation, and retry state. Coalescing does not turn `fyi` or floored forwards into pushes. It groups a pending backlog; it does not add a debounce wait to collect future mail.

## Recovery and ordering

Messages move through `queued`, `delivering`, and `delivered` with five-second delivery leases. Failed attempts return to the queue; expired or holderless leases are reclaimed. A broker restart can preserve a live server's registration and queued mail when it uses the same database.

Ordering is maintained within the pushable channel and the readable polling prefix. There is no global FIFO guarantee across push and poll: a poll-only message does not block newer pushable mail indefinitely.

The product does not promise exactly-once processing or permanent history. See [identity and retention](compatibility.md#identity-resume-and-retention) and [operations](operations.md#identity-and-retention) for lifecycle limits.
