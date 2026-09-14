import { formatPeerList } from "./format-peers.ts";
import { handleSendMessageTool } from "./send-message.ts";
import { parseListPeersScope } from "./types.ts";
import type { Peer, PollMessagesResponse, PeekMessagesResponse } from "./types.ts";

// No startup, network, or registration side effects: the live server supplies these seams.
export interface ToolContext {
  myId: string | null;
  myCwd: string;
  myGitRoot: string | null;
  myRepoKey: string | null;
  cliPath: string;
  brokerFetch: <T>(path: string, body: unknown) => Promise<T>;
  onSummary: (summary: string) => void;
}

export async function handleTool(name: string, args: unknown, context: ToolContext) {
  const { myId, myCwd, myGitRoot, myRepoKey, cliPath, brokerFetch, onSummary } = context;
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
          repo_key: myRepoKey,
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
        onSummary(summary);
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
        const doorbellCmd = `bun ${cliPath} doorbell ${result.id}`;
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
}
