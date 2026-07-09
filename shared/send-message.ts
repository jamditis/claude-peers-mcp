import { describeSendOutcome } from "./format-send.ts";
import type { SendResult, Urgency } from "./types.ts";

export const SEND_MESSAGE_TOOL_INPUT_SCHEMA = {
  type: "object" as const,
  description: "to_id is required and must be a non-empty string.",
  properties: {
    to_id: {
      type: "string" as const,
      description:
        "The target Claude Code instance: its peer ID, or the session name shown in list_peers (the handle in parentheses). A name that matches no visible peer, or matches more than one, is rejected with guidance to address by peer ID.",
    },
    message: {
      type: "string" as const,
      description: "The message to send",
    },
    urgency: {
      type: "string" as const,
      enum: ["interrupt", "normal", "fyi"],
      description:
        'Default "normal". Use "interrupt" only when blocked on the recipient (or they may exit soon) — it costs them a full inference turn. Use "fyi" for status notes that need no reply.',
    },
  },
  required: ["to_id", "message"],
};

type ParsedSendMessageToolArguments =
  | { toId: string; message: string; urgency?: Urgency }
  | { error: "to_id is required" | "to_id must be a non-empty string" };

function parseSendMessageToolArguments(args: unknown): ParsedSendMessageToolArguments {
  const values = args && typeof args === "object"
    ? args as Record<string, unknown>
    : {};
  const toId = values.to_id;
  if (toId === undefined) return { error: "to_id is required" };
  if (typeof toId !== "string" || toId.trim().length === 0) {
    return { error: "to_id must be a non-empty string" };
  }
  return {
    toId,
    message: values.message as string,
    urgency: values.urgency as Urgency | undefined,
  };
}

type SendMessageToolBrokerFetch = (
  path: "/send-message",
  body: { from_id: string; to_id: string; text: string; urgency: Urgency },
) => Promise<SendResult>;

type SendMessageToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

export async function handleSendMessageTool(
  args: unknown,
  fromId: string | null,
  fetchBroker: SendMessageToolBrokerFetch,
): Promise<SendMessageToolResult> {
  const parsed = parseSendMessageToolArguments(args);
  if ("error" in parsed) {
    return {
      content: [{ type: "text", text: parsed.error }],
      isError: true,
    };
  }
  if (!fromId) {
    return {
      content: [{ type: "text", text: "Not registered with broker yet" }],
      isError: true,
    };
  }
  try {
    const result = await fetchBroker("/send-message", {
      from_id: fromId,
      to_id: parsed.toId,
      text: parsed.message,
      urgency: parsed.urgency ?? "normal",
    });
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Failed to send: ${result.error}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: describeSendOutcome(parsed.toId, result) }],
    };
  } catch (e) {
    return {
      content: [
        {
          type: "text",
          text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
      isError: true,
    };
  }
}
