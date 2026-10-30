import { describe, expect, it } from "vitest";

import { ChatToolCalls, INVALID_TOOL_NAME, MalformedToolCallError } from "./openai-chat-protocol.ts";

const completeCall = {
  id: "call_echo",
  type: "function",
  function: { name: "echo", arguments: "{}" },
};

describe("streamed chat tool calls", () => {
  it("treats explicit null continuation fields as absent", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, ...completeCall, function: { ...completeCall.function, arguments: "" } }], true);
    calls.add([{ index: 0, id: null, type: null, function: { name: null, arguments: null } }], true);
    calls.add([{ index: 0, id: null, function: { name: null, arguments: "{}" } }], true);

    expect(calls.finish("tool_calls", false)).toEqual([completeCall]);
  });

  it("repairs a call left with neither ID nor name after null-only deltas", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, id: null, type: null, function: { name: null, arguments: null } }], true);

    const [call] = calls.finish("tool_calls", false);
    expect(call.id).toMatch(/^call_rc/);
    expect(call.function.name).toBe(INVALID_TOOL_NAME);
    expect(calls.repairs.map((repair) => repair.kind)).toEqual(["id_missing", "invalid_name"]);
  });

  it.each([
    { index: 0, type: "computer" },
    { index: 0, function: null },
    { index: 0, function: [] },
    { index: 0, function: { name: 1 } },
    { index: 0, function: { arguments: 1 } },
  ])("rejects unsupported or malformed continuation fields", (delta) => {
    const calls = new ChatToolCalls();
    expect(() => calls.add([delta], true)).toThrow();
  });

  it.each([
    { id: "call_large_name", name: "n".repeat(65), arguments: "{}" },
    { id: "call_large_args", name: "echo", arguments: "x".repeat(256_001) },
  ])("preserves tool-call size limits", ({ id, name, arguments: args }) => {
    const calls = new ChatToolCalls();
    expect(() => calls.add([{ index: 0, id, function: { name, arguments: args } }], true)).toThrow(/size limit/);
  });
});

describe("tool calls per reply", () => {
  it("accepts 32 calls in one reply and refuses a 33rd", () => {
    const calls = new ChatToolCalls();
    calls.add(Array.from({ length: 32 }, (_, index) => ({ index, ...completeCall, id: `call_${index}` })), true);
    expect(calls.finish("tool_calls", false)).toHaveLength(32);
    expect(() => new ChatToolCalls().add([{ index: 32, ...completeCall }], true)).toThrow(/invalid tool-call index/);
  });
});

describe("complete chat tool calls", () => {
  it.each([
    { ...completeCall, id: null },
    { ...completeCall, type: null },
    { ...completeCall, function: null },
    { ...completeCall, function: { ...completeCall.function, name: null } },
    { ...completeCall, function: { ...completeCall.function, arguments: null } },
  ])("rejects null required fields in non-streaming responses", (call) => {
    const calls = new ChatToolCalls();
    expect(() => calls.add([call], false)).toThrow();
  });
});

describe("streamed tool calls without an index (Gemini's OpenAI-compatible endpoint)", () => {
  const whole = (id: string, name: string, args = "{}") => ({ id, type: "function", function: { name, arguments: args } });

  it("keeps two whole calls sent in one chunk", () => {
    const calls = new ChatToolCalls();
    calls.add([whole("function-call-1", "open_url", '{"url":"https://example.com"}'), whole("function-call-2", "open_url", '{"url":"https://example.org"}')], true);
    expect(calls.finish("tool_calls", false).map((call) => [call.id, call.function.arguments]))
      .toEqual([["function-call-1", '{"url":"https://example.com"}'], ["function-call-2", '{"url":"https://example.org"}']]);
  });

  it("keeps whole calls sent in separate chunks in order, and joins a later part with the same id", () => {
    const calls = new ChatToolCalls();
    calls.add([whole("a", "first", '{"x"')], true);
    calls.add([whole("b", "second")], true);
    calls.add([{ id: "a", function: { arguments: ":1}" } }], true);
    expect(calls.finish("stop", false).map((call) => [call.function.name, call.function.arguments])).toEqual([["first", '{"x":1}'], ["second", "{}"]]);
  });

  it("never puts an id-keyed call into a slot an indexed call holds", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, ...whole("x", "zero") }, { index: 2, ...whole("y", "two") }], true);
    calls.add([whole("z", "next")], true);
    expect(calls.finish("tool_calls", false).map((call) => call.id)).toEqual(["x", "y", "z"]);
  });

  it("still rejects a part with neither an index nor an id, and more calls than one reply may carry", () => {
    expect(() => new ChatToolCalls().add([{ function: { name: "f", arguments: "{}" } }], true)).toThrow(/invalid tool-call index/);
    const calls = new ChatToolCalls();
    calls.add(Array.from({ length: 32 }, (_, n) => whole(`call_${n}`, "f")), true);
    expect(() => calls.add([whole("call_32", "f")], true)).toThrow(/invalid tool-call index/);
  });
});

describe("tool-call repairs", () => {
  it("synthesizes an ID for a call that has none", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, function: { name: "echo", arguments: "{}" } }], true);
    const [call] = calls.finish("tool_calls", false);
    expect(call.id).toMatch(/^call_rc[a-z0-9]+$/);
    expect(calls.repairs).toEqual([{ kind: "id_missing", id: call.id }]);
  });

  it("gives a duplicated ID a fresh one and keeps the first", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, ...completeCall }, { index: 1, ...completeCall }], true);
    const [first, second] = calls.finish("tool_calls", false);
    expect(first.id).toBe("call_echo");
    expect(second.id).not.toBe("call_echo");
    expect(calls.repairs).toEqual([{ kind: "id_duplicate", id: second.id }]);
  });

  it("replaces an invalid name with the stand-in and records the original", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, ...completeCall, function: { name: "functions.echo now", arguments: "{}" } }], true);
    const [call] = calls.finish("stop", false);
    expect(call.function.name).toBe(INVALID_TOOL_NAME);
    expect(calls.repairs).toEqual([{ kind: "invalid_name", id: "call_echo", name: "functions.echo now" }]);
  });

  it.each([
    ["truncated", () => { const c = new ChatToolCalls(); c.add([{ index: 0, ...completeCall }], true); return () => c.finish("length", false); }],
    ["malformed frame", () => { const c = new ChatToolCalls(); c.add([{ index: 0, ...completeCall }], true); return () => c.finish("tool_calls", true); }],
    ["tool finish without a call", () => () => new ChatToolCalls().finish("tool_calls", false)],
  ])("still refuses a %s reply as malformed, for one bounded re-request", (_label, make) => {
    expect(make()).toThrow(MalformedToolCallError);
  });
});
