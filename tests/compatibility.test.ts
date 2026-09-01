import { describe, expect, it } from "bun:test";
import packageJson from "../package.json";
import { MCP_SERVER_INFO, MCP_TOOLS } from "../shared/mcp-contract.ts";

describe("MCP compatibility contract", () => {
  it("keeps the server version aligned with the package", () => {
    expect(MCP_SERVER_INFO.name).toBe("claude-peers");
    expect(packageJson.version).toBe(MCP_SERVER_INFO.version);
  });

  it("pins tool names and input schema shapes", () => {
    expect(MCP_TOOLS.map(({ name, inputSchema }) => ({
      name,
      type: inputSchema.type,
      required: "required" in inputSchema ? inputSchema.required : [],
      properties: Object.fromEntries(
        Object.entries(inputSchema.properties).map(([key, value]) => [
          key,
          {
            type: value.type,
            ...("enum" in value ? { enum: value.enum } : {}),
          },
        ]),
      ),
    }))).toEqual([
      {
        name: "list_peers",
        type: "object",
        required: ["scope"],
        properties: {
          scope: { type: "string", enum: ["machine", "directory", "repo"] },
        },
      },
      {
        name: "send_message",
        type: "object",
        required: ["to_id", "message"],
        properties: {
          to_id: { type: "string" },
          message: { type: "string" },
          urgency: { type: "string", enum: ["interrupt", "normal", "fyi"] },
        },
      },
      {
        name: "set_summary",
        type: "object",
        required: ["summary"],
        properties: {
          summary: { type: "string" },
        },
      },
      {
        name: "check_messages",
        type: "object",
        required: [],
        properties: {},
      },
      {
        name: "peek_messages",
        type: "object",
        required: [],
        properties: {},
      },
    ]);
  });
});
