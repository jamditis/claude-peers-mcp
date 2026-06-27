#!/usr/bin/env bun

/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers
 *   bun cli.ts send <id> [--urgency <tier>] <msg> — Send a message to a peer
 *   bun cli.ts ping-siblings   — Ping all sibling brokers and report latency
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

import { type FSWatcher, watch, writeFileSync } from "node:fs";
import type { PeersConfig } from "./shared/config.ts";
import { loadConfig } from "./shared/config.ts";
import { doorbellPath, readDoorbell } from "./shared/notify.ts";

// Load config once; CLI may run without it for basic commands
let config: PeersConfig | null = null;
try {
  config = loadConfig();
} catch {
  // Config is optional — commands that need it will handle the null case
}

const BROKER_PORT = config?.port ?? parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts: RequestInit = body
    ? { method: "POST", headers, body: JSON.stringify(body) }
    : Object.keys(headers).length ? { headers } : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{
        status: string;
        peers: number;
        machine?: string;
        remote_peer_count?: number;
      }>("/health");
      const machinePart = health.machine ? ` — ${health.machine}` : "";
      const remotePart =
        health.remote_peer_count !== undefined
          ? `, ${health.remote_peer_count} remote peer(s)`
          : "";
      console.log(
        `Broker: ${health.status}${machinePart} (${health.peers} local peer(s)${remotePart})`
      );
      console.log(`URL: ${BROKER_URL}`);

      const totalPeers = (health.peers ?? 0) + (health.remote_peer_count ?? 0);
      if (totalPeers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            summary: string;
            last_seen: string;
            machine?: string;
            is_remote?: boolean;
          }>
        >("/list-peers", {
          scope: "machine",
          cwd: "/",
          git_root: null,
        });

        console.log("\nPeers:");
        for (const p of peers) {
          const remoteTag = p.is_remote ? " [remote]" : "";
          const machineTag = p.machine ? ` (${p.machine})` : "";
          console.log(`  ${p.id}${remoteTag}${machineTag}  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          summary: string;
          last_seen: string;
          machine?: string;
          is_remote?: boolean;
        }>
      >("/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const remoteTag = p.is_remote ? " [remote]" : "";
          const machineTag = p.machine ? ` (${p.machine})` : "";
          const parts = [`${p.id}${remoteTag}${machineTag}  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    let rest = process.argv.slice(4);
    // The CLI keeps push-on-send as its default: existing scripts (wake announcements,
    // ops nudges) rely on the message landing in the pane now. The flag opts into the
    // cheaper tiers; agents going through the MCP tool default to "normal" instead.
    let urgency: "interrupt" | "normal" | "fyi" = "interrupt";
    if (rest[0] === "--urgency") {
      const tier = rest[1];
      if (tier !== "interrupt" && tier !== "normal" && tier !== "fyi") {
        console.error("--urgency must be interrupt, normal, or fyi");
        process.exit(1);
      }
      urgency = tier;
      rest = rest.slice(2);
    }
    const msg = rest.join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> [--urgency interrupt|normal|fyi] <message>");
      process.exit(1);
    }
    // The control plane authenticates the sender, so the CLI registers an ephemeral
    // queued-only peer (no tmux pane -> never a delivery target), sends as that id with its
    // token, then unregisters. Dead-pid filtering hides the row the moment this process exits,
    // so a crash before the finally cannot leave a visible ghost.
    let reg: { id: string; token: string } | null = null;
    try {
      reg = await brokerFetch<{ id: string; token: string }>("/register", {
        pid: process.pid,
        cwd: process.cwd(),
        git_root: null,
        tty: null,
        summary: "",
        machine: config?.machine ?? "cli",
        tailscale_ip: config?.tailscale_ip ?? "127.0.0.1",
        tmux_pane: null,
        tmux_socket: null,
      });
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: reg.id,
        to_id: toId,
        text: msg,
        urgency,
      }, reg.token);
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (reg) {
        try { await brokerFetch("/unregister", { id: reg.id }, reg.token); } catch {}
      }
    }
    break;
  }

  case "ping-siblings": {
    if (!config) {
      console.log("No config loaded — cannot determine siblings.");
      break;
    }
    if (config.siblings.length === 0) {
      console.log("No siblings configured.");
      break;
    }
    for (const sibling of config.siblings) {
      try {
        const start = Date.now();
        const res = await fetch(`${sibling.url}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        const latency = Date.now() - start;
        if (!res.ok) {
          console.log(`  ${sibling.machine} (${sibling.url}): error ${res.status}`);
          continue;
        }
        const health = (await res.json()) as {
          status: string;
          peers: number;
          remote_peer_count?: number;
        };
        const remotePart =
          health.remote_peer_count !== undefined
            ? `, ${health.remote_peer_count} remote`
            : "";
        console.log(
          `  ${sibling.machine} (${sibling.url}): ok (${latency}ms, ${health.peers} local peer(s)${remotePart})`
        );
      } catch {
        console.log(`  ${sibling.machine} (${sibling.url}): unreachable`);
      }
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      // Find and kill the broker process listening on the port. lsof is POSIX-only,
      // so branch on platform: netstat -ano on Windows, lsof elsewhere. Without this,
      // `kill-broker` silently reports "not running" on Windows (lsof throws -> catch)
      // even though it is the recovery command server.ts points users to for a stale broker.
      let pids: number[] = [];
      if (process.platform === "win32") {
        // No -p filter: `netstat -p TCP` lists only IPv4 TCP and would miss a broker
        // bound to IPv6 ([::]:port); plain `netstat -ano` includes both. The regex
        // accepts a "TCP" or "TCPv6" proto label and a v4 or bracketed-v6 address.
        const out = new TextDecoder().decode(
          Bun.spawnSync(["netstat", "-ano"]).stdout,
        );
        const seen = new Set<number>();
        for (const line of out.split(/\r?\n/)) {
          // "  TCP    0.0.0.0:7899   0.0.0.0:0   LISTENING   1234"
          // "  TCP    [::]:7899      [::]:0      LISTENING   1234"
          const m = line.match(/^\s*TCP(?:v6)?\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
          if (m && Number(m[1]) === BROKER_PORT) seen.add(Number(m[2]));
        }
        pids = [...seen];
      } else {
        const out = new TextDecoder().decode(
          Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]).stdout,
        );
        pids = out
          .trim()
          .split("\n")
          .map((p) => parseInt(p, 10))
          .filter((n) => Number.isFinite(n) && n > 0);
      }
      if (pids.length === 0) {
        // /health just succeeded, so the broker IS running — we simply could not
        // locate its PID on the port. Never claim "stopped" when nothing was killed.
        console.log(
          `Broker is running but its PID could not be found on port ${BROKER_PORT}; nothing was killed. ` +
            (process.platform === "win32"
              ? `Check: netstat -ano | findstr :${BROKER_PORT}`
              : `Check: lsof -i :${BROKER_PORT}`),
        );
      } else {
        // Signal each PID on its own. process.kill can throw ESRCH (the PID exited
        // between the netstat/lsof probe and now) or EPERM (owned by another user).
        // /health already succeeded, so a kill failure is not "broker not running" —
        // report it here instead of letting it fall through to the outer catch.
        const failures: string[] = [];
        let signaled = 0;
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGTERM");
            signaled++;
          } catch (e) {
            failures.push(`PID ${pid}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (signaled > 0) console.log("Broker stopped.");
        if (failures.length > 0) {
          console.error(
            `Could not signal ${failures.length} broker process(es): ${failures.join("; ")}.` +
              (signaled === 0
                ? " The broker responded to /health but no process could be signaled; " +
                  "it may be owned by another user or exiting on its own."
                : ""),
          );
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  // The doorbell watcher (issue #49): block until peer <id> has mail, then print one line and
  // exit so the calling harness re-invokes the session — which reads via check_messages and
  // re-arms. A delivery_kind='none' session has no pane to push into, so this is its
  // near-real-time wake instead of waiting for a manual check. It is notify-only: it reads the
  // broker's marker file (a content-free counter, never the SQLite store or message bodies) and
  // never marks anything delivered, so check_messages stays the single consume path.
  //
  // Mechanism: the marker holds the recipient's max pending id, which only grows. We watch it
  // with fs.watch (inotify/FSEvents — ~zero idle CPU) and treat it as level-triggered state: a
  // slow poll is a safety net for any coalesced/missed event, and we read-after-arm to catch a
  // write that landed during startup. So a dropped event costs at most one poll interval; it is
  // never a missed message.
  case "doorbell": {
    const rest = process.argv.slice(3);
    let id = "";
    let since: number | null = null;
    let pollMs = 3000;
    let timeoutSec: number | null = null;
    let persistent = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--since") since = parseInt(rest[++i] ?? "", 10);
      else if (a === "--poll-ms") pollMs = parseInt(rest[++i] ?? "", 10);
      else if (a === "--timeout") timeoutSec = parseInt(rest[++i] ?? "", 10);
      else if (a === "--watch") persistent = true;
      else if (!id && a) id = a;
    }
    if (!id) {
      console.error("Usage: bun cli.ts doorbell <peer-id> [--since <id>] [--poll-ms <ms>] [--timeout <sec>] [--watch]");
      process.exit(1);
    }
    if (!config) {
      console.error("doorbell needs a config to locate the broker store (see ~/.claude-peers.json)");
      process.exit(1);
    }
    const dbPath = config.db_path;
    const markPath = doorbellPath(dbPath, id);
    if (markPath === null) {
      console.error(`Invalid peer id: ${id}`);
      process.exit(1);
    }
    if (!Number.isFinite(pollMs) || pollMs < 250) pollMs = 3000;
    // The watched file must exist before fs.watch is armed. Create it without clobbering an
    // existing marker (wx fails if present), so we never reset a live counter.
    try { writeFileSync(markPath, "0", { flag: "wx" }); } catch { /* already exists */ }
    // Baseline: only rings strictly above this fire. Default to the marker's current value so we
    // only wake on mail that arrives after arming — the session has just drained via
    // check_messages, so anything already counted is consumed. --since pins an explicit baseline.
    let baseline = since !== null && Number.isFinite(since) ? since : readDoorbell(dbPath, id, 0);

    await new Promise<void>((resolve) => {
      let watcher: FSWatcher | null = null;
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const poll = setInterval(check, pollMs);
      const timeout =
        timeoutSec && timeoutSec > 0
          ? setTimeout(() => { cleanup(); console.log(`no mail for ${id} within ${timeoutSec}s`); process.exit(2); }, timeoutSec * 1000)
          : null;

      function cleanup() {
        if (debounce) clearTimeout(debounce);
        clearInterval(poll);
        if (timeout) clearTimeout(timeout);
        watcher?.close();
      }
      // Level-triggered: compare the marker's current value to the baseline. fs.watch and the
      // poll both just call this; correctness depends on the value, not on catching every event.
      function check() {
        const cur = readDoorbell(dbPath, id, baseline);
        if (cur <= baseline) return;
        if (persistent) {
          // Tail mode: report each advance and keep watching (advance the baseline).
          console.log(`mail for ${id} (mark=${cur})`);
          baseline = cur;
          return;
        }
        cleanup();
        console.log(`mail for ${id} (mark=${cur}) — run check_messages`);
        resolve();
      }
      function onEvent() {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(check, 50); // collapse fs.watch's fires-twice + write bursts
      }
      try {
        watcher = watch(markPath, { persistent: true }, onEvent);
        watcher.on("error", () => { watcher?.close(); watcher = null; }); // degrade to poll-only
      } catch {
        watcher = null; // fs.watch unavailable — the poll carries it
      }
      check(); // read-after-arm: catch a write that landed during startup
    });
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers
  bun cli.ts send <id> [--urgency interrupt|normal|fyi] <msg> Send a message to a peer
  bun cli.ts doorbell <id> [--since <id>] [--timeout <sec>] [--watch] Wait until <id> has mail, then exit (near-real-time wake for non-tmux sessions)
  bun cli.ts ping-siblings   Ping all sibling brokers and report latency
  bun cli.ts kill-broker     Stop the broker daemon`);
}
