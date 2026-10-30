import { describe, expect, it } from "vitest";
import { agentsToolBridgeRefusal, engineBridgeRefusal } from "./agents-bridge-switch.ts";

describe("agents tool bridge", () => {
  it("bridges the native chat runtime only", () => {
    expect(engineBridgeRefusal({}, { driverKind: "openai-compat" })).toBeNull();
    expect(engineBridgeRefusal({}, { driverKind: "groq" })).toBeNull();
    expect(engineBridgeRefusal({}, { driverKind: "someOtherEngine" })).toBe("this engine keeps its own tool permissions");
    expect(engineBridgeRefusal({}, null)).toBe("no engine");
  });

  it("stays off until the switch is on, and off for a bot with a tool selection", () => {
    const engine = { driverKind: "openai-compat" };
    expect(agentsToolBridgeRefusal({}, {}, engine, {})).toBe("the switch is off");
    const on = { features: { agentsToolBridge: true } };
    expect(agentsToolBridgeRefusal(on, {}, engine, {})).toBeNull();
    expect(agentsToolBridgeRefusal(on, { toolScope: { allow: ["x"] } }, engine, {})).toBe("the bot has a tool selection");
  });
});
