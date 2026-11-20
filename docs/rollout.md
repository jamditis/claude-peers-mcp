# Roll out a same-protocol broker change

Use this procedure for a source update that leaves the broker protocol and database schema unchanged. Update one receiving broker at a time. Keep the existing MCP clients, configuration, database and doorbell directory in place. Use the [upgrade procedure](operations.md#upgrading) for a protocol or schema change.

## Identify the running broker

Find the process that listens on the configured broker port. Record its PID, start time, service manager and the absolute path to the `broker.ts` it runs. Check that the supervisor targets the same checkout and uses the existing database. An installed service can be idle while a different process owns the port.

Record the checkout's branch, revision and worktree status. Preserve local files and resolve conflicting edits before updating. Read `/health` and run `bun cli.ts doctor` with the broker's configuration to record its initial state.

## Update and restart

In the checkout used by the broker, fast-forward the tracked branch and install its locked dependencies.

```sh
git pull --ff-only
bun install --frozen-lockfile
```

Verify that the updated checkout contains the reviewed merge commit. Record `git rev-parse HEAD` and the update time. Restart only the broker through the supervisor that owns the listener. The repository's systemd template uses `sudo systemctl restart claude-peers-broker.service`. For the Windows scheduled task, use Task Scheduler or `Stop-ScheduledTask` and `Start-ScheduledTask` with the registered task name. For a custom supervisor, use its equivalent. For an unsupervised broker, stop the verified listener and restart it with the same command and configuration.

## Verify the running revision

1. Confirm that the listener has a new PID and a start time after the checkout update. Confirm that its executable and `broker.ts` path match the intended supervisor and checkout.
2. In that checkout, run `git merge-base --is-ancestor <reviewed-merge-sha> HEAD` and `git diff --quiet HEAD --`. Both commands must succeed. Together with the process readback, they show which source the broker loaded. The protocol number from `/health` can stay the same across these releases.
3. Read `/health` and run `bun cli.ts doctor` using the same configuration. Check a local send and poll with a disposable peer. Check both directions with a sibling if federation is enabled. Move to the next broker after these checks pass.

## Preserve queued mail

A broker restart keeps queued mail for live registrations when the replacement uses the same database. Broker startup returns interrupted delivery leases to the queue. A terminated MCP client, an expired registration or a different database can make the old inbox unavailable. Keep existing clients connected, keep the restart brief, and verify a live peer retains its ID after its next heartbeat.
