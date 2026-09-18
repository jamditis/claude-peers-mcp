import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import packageJson from "../package.json";
import { formatPeerMessage } from "../delivery.ts";
import { MCP_SERVER_INFO, MCP_SERVER_INSTRUCTIONS, MCP_TOOLS } from "../shared/mcp-contract.ts";
import { PROTOCOL_VERSION } from "../shared/types.ts";

describe("MCP compatibility contract", () => {
  it("keeps the server version aligned with the package", () => {
    expect(MCP_SERVER_INFO.name).toBe("claude-peers");
    expect(packageJson.version).toBe(MCP_SERVER_INFO.version);
  });

  it("keeps current protocol references aligned with the executable constant", () => {
    const references = [
      ["../README.md", `currently \`${PROTOCOL_VERSION}\``],
      ["../CLAUDE.md", `PROTOCOL_VERSION = ${PROTOCOL_VERSION}`],
      ["../docs/compatibility.md", `current broker protocol is ${PROTOCOL_VERSION}`],
    ] as const;
    for (const [path, expected] of references) {
      expect(readFileSync(new URL(path, import.meta.url), "utf8").toLowerCase()).toContain(expected.toLowerCase());
    }
  });

  it("distinguishes peer replies from the built-in team tool", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain("claude-peers MCP `send_message` tool");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("not Claude Code's built-in `SendMessage` team tool");
    expect(formatPeerMessage({ id: 1, from_id: "peer-a", text: "ping" }))
      .toContain("reply with claude-peers MCP tool: send_message");
  });

  it("classifies Claude Code channels as unsupported/planned because no adapter ships", () => {
    const compatibility = readFileSync(new URL("../docs/compatibility.md", import.meta.url), "utf8");
    expect(compatibility).toMatch(/Claude Code channels \| Unsupported\/planned/i);
    expect(compatibility.toLowerCase()).toContain("this package has no channel adapter");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme.toLowerCase()).toContain("this package has no channel adapter");
    expect(readme.toLowerCase()).toContain("unsupported/planned");
    expect(readme.toLowerCase()).not.toContain("optional research-preview adapter");
  });

  it("documents CLAUDE_PEERS_PORT as a CLI fallback only after config loading throws", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("`CLAUDE_PEERS_PORT`");
    expect(readme).toContain("cli.ts` consults it only when config loading throws and config is null");
    expect(readme).toContain("The normal zero-config default remains port `7899`");
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
