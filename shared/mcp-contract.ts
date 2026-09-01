import { SEND_MESSAGE_TOOL_INPUT_SCHEMA } from "./send-message.ts";
import { LIST_PEERS_SCOPES } from "./types.ts";

export const MCP_SERVER_INFO = {
  name: "claude-peers",
  version: "0.3.0",
} as const;

export const MCP_TOOLS = [
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
] as const;
