import { describe, expect, it } from "bun:test";
import {
  handleSendMessageTool,
  SEND_MESSAGE_TOOL_INPUT_SCHEMA,
} from "../shared/send-message.ts";
import {
  LIST_PEERS_SCOPES,
  parseListPeersScope,
} from "../shared/types.ts";

describe("send_message arguments", () => {
  it("advertises to_id as the only required target key", () => {
    expect(SEND_MESSAGE_TOOL_INPUT_SCHEMA.description).toContain("to_id is required");
    expect("to" in SEND_MESSAGE_TOOL_INPUT_SCHEMA.properties).toBe(false);
    expect(SEND_MESSAGE_TOOL_INPUT_SCHEMA.required).toEqual(["to_id", "message"]);
  });

  it("routes a to_id payload through the broker request", async () => {
    const observed: Array<{ path: string; body: unknown }> = [];

    const result = await handleSendMessageTool(
      { to_id: "target-session", message: "hello" },
      "alp-sender",
      async (path, body) => {
        observed.push({ path, body });
        return { ok: true, routed: "local", delivery: "queued" };
      },
    );

    expect(observed[0]?.path).toBe("/send-message");
    expect(observed[0]?.body).toEqual({
      from_id: "alp-sender",
      to_id: "target-session",
      text: "hello",
      urgency: "normal",
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "Sent to target-session (queued)" }],
    });
  });

  it("does not call the broker when the target is missing", async () => {
    let brokerCalls = 0;

    const result = await handleSendMessageTool(
      { message: "missing target" },
      "alp-sender",
      async () => {
        brokerCalls++;
        return { ok: true };
      },
    );

    expect(brokerCalls).toBe(0);
    expect(result).toEqual({
      content: [{ type: "text", text: "to_id is required" }],
      isError: true,
    });
  });

  it("does not call the broker when the target is not a string", async () => {
    let brokerCalls = 0;

    const result = await handleSendMessageTool(
      { to_id: 42, message: "invalid target" },
      "alp-sender",
      async () => {
        brokerCalls++;
        return { ok: true };
      },
    );

    expect(brokerCalls).toBe(0);
    expect(result).toEqual({
      content: [{ type: "text", text: "to_id must be a non-empty string" }],
      isError: true,
    });
  });

  it("does not call the broker when the target is empty", async () => {
    let brokerCalls = 0;

    const result = await handleSendMessageTool(
      { to_id: "   ", message: "invalid target" },
      "alp-sender",
      async () => {
        brokerCalls++;
        return { ok: true };
      },
    );

    expect(brokerCalls).toBe(0);
    expect(result).toEqual({
      content: [{ type: "text", text: "to_id must be a non-empty string" }],
      isError: true,
    });
  });
});

describe("list_peers scope arguments", () => {
  it("accepts each supported scope", () => {
    for (const scope of LIST_PEERS_SCOPES) {
      expect(parseListPeersScope({ scope })).toEqual({ scope });
    }
  });

  it("rejects an unsupported scope with a clear error", () => {
    expect(parseListPeersScope({ scope: "network" })).toEqual({
      error: "scope must be one of: machine, directory, repo",
    });
  });
});
