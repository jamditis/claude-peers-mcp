#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Reports its own tmux pane at registration so the broker can deliver messages
 * straight into the session; non-tmux sessions read theirs via check_messages.
 *
 * Usage (plain MCP — no special flags needed for delivery):
 *   { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }   // .mcp.json
 */

import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
} from "./shared/types.ts";
import { PROTOCOL_VERSION as REQUIRED_BROKER_PROTOCOL } from "./shared/types.ts";
import { loadConfig } from "./shared/config.ts";
import { resolveTmuxTarget } from "./delivery.ts";

const config = loadConfig();

// --- Configuration ---

const BROKER_PORT = config.port;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const HEARTBEAT_INTERVAL_MS = 15_000;
// fileURLToPath, not URL.pathname: on Windows .pathname yields "/C:/Users/you/..."
// (leading slash + percent-encoded spaces), which Bun.spawn cannot resolve. fileURLToPath
// decodes and uses native separators on every platform.
const BROKER_SCRIPT = fileURLToPath(new URL("./broker.ts", import.meta.url));

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Present the session token once we hold one. /register (pre-token) and /health carry none;
  // the broker exempts /register and validates the rest against the call's principal.
  if (myAuthToken) headers.Authorization = `Bearer ${myAuthToken}`;
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function brokerProtocolVersion(): Promise<number | null> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const h = await res.json() as { protocol_version?: number };
    return typeof h.protocol_version === "number" ? h.protocol_version : null;
  } catch { return null; }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    const ver = await brokerProtocolVersion();
    if (ver !== null && ver >= REQUIRED_BROKER_PROTOCOL) {
      log("Broker already running");
      return;
    }
    log(`Stale broker (protocol ${ver ?? "?"} < ${REQUIRED_BROKER_PROTOCOL}); retiring it`);
    let retireRefused = false;
    try {
      const res = await fetch(`${BROKER_URL}/retire`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(2000) });
      // A protocol-1 broker has no /retire route and answers 404. Any non-ok status means the
      // broker will not self-exit, so waiting out the drain loop below is pointless — fail fast
      // with an accurate instruction instead of stalling 5s on a broker that cannot retire. A
      // thrown fetch (broker exited mid-response) still falls through to the wait-and-see loop.
      if (!res.ok) retireRefused = true;
    } catch { /* it may exit before responding; confirm via the wait loop below */ }
    if (retireRefused) {
      throw new Error("The running claude-peers broker predates this version and cannot self-retire; run `bun cli.ts kill-broker` and retry.");
    }
    let freed = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (!(await isBrokerAlive())) { freed = true; break; }
    }
    if (!freed) throw new Error("A stale claude-peers broker is running; run `bun cli.ts kill-broker` and retry.");
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Opt this auto-launched broker into idle self-exit so it reaps itself once every
    // peer is gone (no daemon supervisor here, unlike the systemd unit). Respect an
    // existing override. The broker treats <=0 as "never self-exit".
    env: { ...process.env, CLAUDE_PEERS_IDLE_EXIT_MS: process.env.CLAUDE_PEERS_IDLE_EXIT_MS ?? "600000" },
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
// Per-session capability token, minted by the broker at /register. brokerFetch presents it
// (Authorization: Bearer) on every mutating control-plane call so the broker can bind the
// call to this session. Null before registration — /register itself needs no token.
let myAuthToken: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.2.0" },
  {
    capabilities: {
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine and across the network can see you and send you messages. Peers on other machines are marked with their hostname. Messages to remote peers are routed automatically.

How messages reach you: if you are running in a tmux pane, the broker types an incoming peer message straight into your session. It arrives inline as a line beginning with "[peer <from_id> #<n>]" followed by the text and a reply hint. If you are NOT in a tmux pane, messages queue instead — call check_messages to read them.

IMPORTANT: When a "[peer ...]" message appears, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply with send_message to the from_id shown in the message, then resume your work. Treat it like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Read messages that were queued rather than pushed into your session

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances on this machine and across the network. Returns their ID, machine, working directory, git repo, and summary. Remote peers are marked.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer and across the network. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. If the peer is in a tmux session it is delivered into their session; otherwise it is queued for their next check_messages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Check for messages from other Claude Code instances that were queued rather than pushed into your session. Returns and clears the queued messages.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
          ];
          if (p.machine) parts.push(`Machine: ${p.machine} (${p.tailscale_ip})`);
          if (p.is_remote) parts.push(`[REMOTE]`);
          parts.push(`CWD: ${p.cwd}`);
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string; delivery?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        const how = result.delivery === "accepted"
          ? " (pushed to their session)"
          : " (queued; they'll see it on their next check)";
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}${how}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Register with broker
  const tmuxTarget = resolveTmuxTarget(process.env);
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: "",
    machine: config.machine,
    tailscale_ip: config.tailscale_ip,
    tmux_pane: tmuxTarget?.pane ?? null,
    tmux_socket: tmuxTarget?.socket ?? null,
  });
  myId = reg.id;
  myAuthToken = reg.token; // capability for every subsequent control-plane call this session
  log(`Registered as peer ${myId}`);

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  const cleanup = async () => {
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
