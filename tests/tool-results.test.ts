import { describe, expect, it } from "bun:test";
import { handleTool, type ToolContext } from "../shared/tool-results.ts";
import { MCP_TOOLS } from "../shared/mcp-contract.ts";

const cases = [
  { name: "list_peers", args: { scope: "machine" }, response: [], path: "/list-peers" },
  { name: "send_message", args: { to_id: "recipient", message: "fixture" }, response: { ok: true, delivery: "queued", routed: "local" }, path: "/send-message" },
  { name: "set_summary", args: { summary: "fixture" }, response: { ok: true }, path: "/set-summary" },
  { name: "check_messages", args: {}, response: { messages: [] }, path: "/poll-messages" },
  { name: "peek_messages", args: {}, response: { id: "sender", count: 0, max_id: null }, path: "/peek" },
];
function context(response: unknown, failure?: unknown): ToolContext {
  return { myId: "sender", myCwd: "/fixture", myGitRoot: null, myRepoKey: null,
    cliPath: "/fixture/cli.ts", onSummary() {},
    async brokerFetch<T>() { if (failure) throw failure; return response as T; },
  };
}
function envelope(result: Awaited<ReturnType<typeof handleTool>>, error = false) {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe("text");
  expect(typeof result.content[0]?.text).toBe("string");
  expect(result.content[0]?.text.length).toBeGreaterThan(0);
  if (error) expect(result.isError).toBe(true);
  else expect(Object.hasOwn(result, "isError")).toBe(false);
}
describe("public result envelopes", () => {
  it("covers every advertised tool", () => {
    expect(cases.map(c => c.name)).toEqual(MCP_TOOLS.map(t => t.name));
  });
  for (const fixture of cases) {
    it(`${fixture.name}: success and broker failure`, async () => {
      const ctx = context(fixture.response);
      const fetch = ctx.brokerFetch;
      ctx.brokerFetch = async (path, body) => { expect(path).toBe(fixture.path); return fetch(path, body); };
      envelope(await handleTool(fixture.name, fixture.args, ctx));
      for (const failure of [new Error("fixture unavailable"), "fixture unavailable"]) {
        const result = await handleTool(fixture.name, fixture.args, context(null, failure));
        envelope(result, true);
        expect(result.content[0]?.text).toContain("fixture unavailable");
      }
    });
    if (fixture.name !== "list_peers") it(`${fixture.name}: unregistered`, async () => {
      const result = await handleTool(fixture.name, fixture.args, { ...context(null), myId: null,
        async brokerFetch() { throw new Error("must not dispatch"); } });
      envelope(result, true);
      expect(result.content[0]?.text).toMatch(/registered/i);
    });
  }
  it("classifies invalid scope and target before dispatch", async () => {
    for (const [name, args, meaning] of [
      ["list_peers", { scope: "invalid" }, /scope/],
      ["send_message", {}, /to_id/],
      ["send_message", { to_id: 2 }, /to_id/],
    ] as const) {
      const result = await handleTool(name, args, context(null, new Error("must not dispatch")));
      envelope(result, true); expect(result.content[0]?.text).toMatch(meaning);
    }
  });
  it("classifies broker send rejection", async () => {
    const result = await handleTool("send_message", cases[1]!.args, context({ ok: false, error: "ambiguous recipient; use peer ID" }));
    envelope(result, true); expect(result.content[0]?.text).toContain("use peer ID");
  });
  it("distinguishes unknown, false, and true remote poll-only disposition", async () => {
    const texts: string[] = [];
    for (const extra of [{}, { poll_only: false }, { poll_only: true }]) {
      const result = await handleTool("send_message", cases[1]!.args, context({ ok: true, routed: "remote", delivery: "queued", ...extra }));
      envelope(result); texts.push(result.content[0]!.text);
    }
    expect(texts[0]).toMatch(/if/); expect(texts[1]).toMatch(/once.*due/); expect(texts[2]).toMatch(/poll-only/);
    expect(new Set(texts).size).toBe(3);
  });
  it("reports accepted transport without a processing acknowledgement", async () => {
    const result = await handleTool("send_message", cases[1]!.args, context({ ok: true, routed: "remote", delivery: "accepted", poll_only: true }));
    envelope(result); expect(result.content[0]?.text).toMatch(/pushed/);
  });
  it("renders populated polling and peek envelopes", async () => {
    const poll = await handleTool("check_messages", {}, context({ messages: [{ from_id: "fixture-peer", sent_at: "fixture-time", text: "fixture-body", urgency: "fyi" }] }));
    envelope(poll);
    for (const field of ["fixture-peer", "fixture-time", "fixture-body", "no reply expected"]) expect(poll.content[0]?.text).toContain(field);
    const peek = await handleTool("peek_messages", {}, context({ id: "fixture-peer", count: 2, max_id: 42 }));
    envelope(peek);
    for (const field of ["fixture-peer", "2", "42", "check_messages"]) expect(peek.content[0]?.text).toContain(field);
  });
});

it("pins populated peer fields and optional remote/name/summary fallbacks", async () => {
  const peer = { id: "fixture-peer", machine: "fixture-host", cwd: "/fixture/work", git_root: "/fixture/repo", last_seen: new Date().toISOString(), summary: "fixture-summary", name: "fixture-name" };
  for (const remote of [undefined, false, true]) {
    const result = await handleTool("list_peers", { scope: "repo" }, context([{ ...peer, is_remote: remote }]));
    envelope(result);
    for (const value of Object.values(peer).filter(v => v !== peer.last_seen)) expect(result.content[0]?.text).toContain(value);
    expect(result.content[0]?.text.includes("[remote]")).toBe(remote === true);
  }
  const result = await handleTool("list_peers", { scope: "directory" }, context([{ ...peer, name: null, summary: null, git_root: null, last_seen: "invalid" }]));
  envelope(result); expect(result.content[0]?.text).not.toMatch(/null|undefined|NaN/);
});

it("keeps compatibility documentation linked to all executable result cases", async () => {
  const doc = await Bun.file(new URL("../docs/compatibility.md", import.meta.url)).text();
  const section = doc.split("## Executable result and broker envelopes")[1]?.split("## Delivery terms")[0];
  expect(section).toBeDefined();
  for (const { name } of cases) expect(section).toContain(`| \`${name}\` |`);
  for (const field of ["isError", "poll_only", "max_id", "urgency", "is_remote", "protocol transition", "package major"]) expect(section).toContain(field);
});
