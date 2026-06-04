#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers
 *   bun cli.ts send <id> <msg> — Send a message to a peer
 *   bun cli.ts ping-siblings   — Ping all sibling brokers and report latency
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

import { loadConfig } from "./shared/config.ts";
import type { PeersConfig } from "./shared/config.ts";

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
  if (token) headers["Authorization"] = `Bearer ${token}`;
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
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
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
      // Find and kill the broker process on the port
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts ping-siblings   Ping all sibling brokers and report latency
  bun cli.ts kill-broker     Stop the broker daemon`);
}
