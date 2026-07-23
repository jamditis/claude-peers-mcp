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

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { makeSpawnTmuxQuery, resolveSessionName, resolveTmuxTarget, SESSION_NAME_TIMEOUT_MS } from "./delivery.ts";
import {
  BrokerHttpError,
  createRecoveringBrokerFetch,
} from "./shared/broker-fetch.ts";
import { loadConfig } from "./shared/config.ts";
import { formatPeerList } from "./shared/format-peers.ts";
import {
  handleSendMessageTool,
  SEND_MESSAGE_TOOL_INPUT_SCHEMA,
} from "./shared/send-message.ts";
import { buildAutoSummary } from "./shared/summarize.ts";
import type {
  Peer,
  PeerId,
  PeekMessagesResponse,
  PollMessagesResponse,
  RegisterRequest,
  RegisterResponse,
} from "./shared/types.ts";
import {
  LIST_PEERS_SCOPES,
  parseListPeersScope,
  PROTOCOL_VERSION as REQUIRED_BROKER_PROTOCOL,
} from "./shared/types.ts";

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
let myRegistration: RegisterRequest | null = null;

async function registerWithBroker(): Promise<{ previousId: PeerId | null }> {
  if (!myRegistration) {
    throw new Error("Cannot register before session context is ready");
  }

  const previousId = myId;
  // /register is token-exempt. Clear the old capability before asking a fresh
  // broker to mint the replacement used by every later control-plane call.
  myAuthToken = null;
  const registration = await brokerFetch<RegisterResponse>(
    "/register",
    myRegistration,
    { recover: false },
  );
  myId = registration.id;
  myAuthToken = registration.token;
  return { previousId };
}

async function recoverBroker(): Promise<{ previousId: PeerId | null }> {
  await ensureBroker();

  // The normal restart keeps the same SQLite database, including this peer's
  // capability and queued mail. Prove that registration with an authenticated
  // heartbeat before creating a replacement id: it also refreshes last_seen so
  // a peer whose broker was down past the TTL is immediately discoverable and
  // addressable. Same-pid /register supersedes the old row and would otherwise
  // delete its queued mail.
  const previousId = myId;
  if (myId && myAuthToken) {
    try {
      await brokerFetch<{ ok: boolean }>(
        "/heartbeat",
        { id: myId, probe_only: true },
        { recover: false },
      );
      log(`Recovered broker connection for peer ${myId}`);
      return { previousId };
    } catch (error) {
      if (!(error instanceof BrokerHttpError) || error.status !== 401) {
        throw error;
      }
    }
  }

  // A 401 proves this live replacement broker does not hold the old
  // capability. Registration is safe here because there is no authenticated
  // persisted row to preserve.
  const recovery = await registerWithBroker();
  log(`Recovered broker registration as peer ${myId}`);
  return recovery;
}

const brokerFetch = createRecoveringBrokerFetch({
  brokerUrl: BROKER_URL,
  getAuthToken: () => myAuthToken,
  getPeerId: () => myId,
  recover: recoverBroker,
});

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.3.0" },
  {
    capabilities: {
      tools: {},
    },
    instructions: `Other Claude Code sessions on this machine and across the network are peers: discover them with list_peers, message them with send_message. Your summary starts as an auto-generated git snapshot ("[auto] branch; recent files"); call set_summary (1-2 sentences) once your task is clearer than that, and update it at task boundaries.

Peer messages are model-to-model — be telegraphic. No greetings or pleasantries; fragments are fine. Never reply just to acknowledge: the sender already has delivery confirmation. For content over ~50 words, write a file and send the path instead.

Choose send_message urgency honestly: "fyi" = no reply expected, read at the recipient's convenience; "normal" (default) = queued, may batch with other mail; "interrupt" = types into the recipient's session now — only when you are blocked on them. A broker can only type into a pane on its own host, so an interrupt to a peer on another machine does not push from here: by default it queues on the remote host for that session's check_messages, though a host that opts into remote auto-push will push it from its own heartbeat. Either way the send result tells you what happened, so don't assume a remote interrupt landed now.

Pushed messages arrive inline as "[peer <id> #<n>] ..." lines: handle them promptly, reply via send_message only if you have something the sender needs, then resume your task. Queued messages: call check_messages when you finish a task. A session not in a tmux pane has no pane to push into and receives via check_messages.`,
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
          enum: [...LIST_PEERS_SCOPES],
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
      "Send a message to another Claude Code instance by peer ID or session name. Urgency controls delivery: interrupt pushes into their session now; normal (default) queues until they poll or a short deadline passes; fyi is poll-only with no reply expected. A broker can only push into a pane on its own host, so interrupt to a peer on another machine does not push from here: by default it queues on the remote host for that session's next check_messages (a host that opts into remote auto-push pushes it from its own heartbeat instead). The result line says what happened: pushed, a plain local queue, or a remote queue (poll-only, or push-eligible on the remote host).",
    inputSchema: SEND_MESSAGE_TOOL_INPUT_SCHEMA,
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
  {
    name: "peek_messages",
    description:
      "Report your own peer ID and how much mail is waiting, without consuming it (check_messages stays the only way to read and clear messages). Returns your id, the count of pending messages, and the highest pending message id. Use it to learn your id so you can arm the background doorbell watcher (`bun cli.ts doorbell <your-id>`), which wakes a non-tmux session within seconds of new mail instead of waiting for a manual check.",
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
      const parsedScope = parseListPeersScope(args);
      if ("error" in parsedScope) {
        return {
          content: [{ type: "text" as const, text: parsedScope.error }],
          isError: true,
        };
      }
      const { scope } = parsedScope;
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

        return {
          content: [
            {
              type: "text" as const,
              text: formatPeerList(peers, scope, Date.now()),
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
      return handleSendMessageTool(args, myId, brokerFetch);
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
        if (myRegistration) {
          myRegistration = { ...myRegistration, summary };
        }
        // No echo of the summary text: the caller just wrote it, so repeating it back
        // only adds tokens to their context.
        return {
          content: [{ type: "text" as const, text: "Summary updated." }],
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
          (m) => `From ${m.from_id} (${m.sent_at})${m.urgency === "fyi" ? " [fyi - no reply expected]" : ""}:\n${m.text}`
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

    case "peek_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PeekMessagesResponse>("/peek", { id: myId });
        const mail =
          result.count === 0
            ? "no pending messages"
            : `${result.count} pending message(s) (highest id ${result.max_id})`;
        // peek never consumes: report state and point at the consume + watcher paths.
        // Absolute path to the CLI: a session's cwd is its own project, not the claude-peers
        // install, so a bare `bun cli.ts` would not resolve. cli.ts sits next to this server.
        const doorbellCmd = `bun ${join(import.meta.dir, "cli.ts")} doorbell ${result.id}`;
        const hint =
          result.count > 0
            ? " Call check_messages to read them."
            : ` Arm the doorbell to be woken on new mail: run \`${doorbellCmd}\` in the background, then call check_messages. When it fires, re-arm it and call check_messages again — always arm before checking so nothing is missed.`;
        return {
          content: [
            { type: "text" as const, text: `You are peer ${result.id}; ${mail}.${hint}` },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error peeking messages: ${e instanceof Error ? e.message : String(e)}`,
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

  // 3. Register with broker. The summary starts as a git snapshot so peers can read
  // branch + recent files immediately — no inference turn spent on set_summary just
  // to become discoverable. set_summary overwrites it once the actual task is known.
  const tmuxTarget = resolveTmuxTarget(process.env);
  // Friendly session name (tmux #S, or a CLAUDE_PEERS_SESSION_NAME override) so peers can
  // find this session by the handle a human uses. Null for an unnamed (non-tmux) session.
  const sessionName = await resolveSessionName(process.env, makeSpawnTmuxQuery(SESSION_NAME_TIMEOUT_MS));
  log(`Session name: ${sessionName ?? "(none)"}`);
  myRegistration = {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: config.auto_summary ? await buildAutoSummary(myCwd) : "",
    machine: config.machine,
    tailscale_ip: config.tailscale_ip,
    name: sessionName,
    tmux_pane: tmuxTarget?.pane ?? null,
    tmux_socket: tmuxTarget?.socket ?? null,
  };
  await registerWithBroker();
  log(`Registered as peer ${myId}`);

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let cleanupStarted = false;

  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (myId) {
      try {
        // Cleanup must never launch a new daemon just to unregister from it.
        await brokerFetch("/unregister", { id: myId }, { recover: false });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  // If the MCP host closes stdio without sending a signal, this server has no useful
  // work left to do. Unregister and exit so it cannot keep heartbeating as a ghost peer.
  process.stdin.once("end", () => { void cleanup(); });
  process.stdin.once("close", () => { void cleanup(); });

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start heartbeat
  heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
