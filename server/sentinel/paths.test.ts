import { describe, expect, it } from "vitest";

import { defaultSentinelOut, isInside } from "./paths.ts";

describe("sentinel paths", () => {
  it("keeps Sentinel's files in the platform's state folder, outside the data dir", () => {
    expect(defaultSentinelOut("/Users/rootclaw/.rootclaw", "darwin", "/Users/rootclaw", {})).toBe("/Users/rootclaw/Library/Application Support/rootclaw-sentinel");
    expect(defaultSentinelOut("/home/rootclaw/.rootclaw", "linux", "/home/rootclaw", {})).toBe("/home/rootclaw/.local/state/rootclaw-sentinel");
    expect(defaultSentinelOut("/home/rootclaw/.rootclaw", "linux", "/home/rootclaw", { XDG_STATE_HOME: "/var/state/rootclaw" })).toBe("/var/state/rootclaw/rootclaw-sentinel");
    // a relative XDG_STATE_HOME is invalid by the spec and ignored
    expect(defaultSentinelOut("/home/rootclaw/.rootclaw", "linux", "/home/rootclaw", { XDG_STATE_HOME: "state" })).toBe("/home/rootclaw/.local/state/rootclaw-sentinel");
    expect(defaultSentinelOut("C:\\Users\\rootclaw\\.rootclaw", "win32", "C:\\Users\\rootclaw", { LOCALAPPDATA: "D:\\Local" })).toBe("D:\\Local\\rootclaw-sentinel");
  });

  it("gives any other data dir its own subfolder, the same one every time", () => {
    const other = defaultSentinelOut("/srv/rootclaw-data", "linux", "/home/rootclaw", {});
    expect(other).toMatch(/^\/home\/rootclaw\/\.local\/state\/rootclaw-sentinel\/data-[0-9a-f]{12}$/);
    expect(defaultSentinelOut("/srv/rootclaw-data", "linux", "/home/rootclaw", {})).toBe(other);
    expect(defaultSentinelOut("/srv/rootclaw-data-2", "linux", "/home/rootclaw", {})).not.toBe(other);
  });

  it("knows when a folder is inside another", () => {
    expect(isInside("/d/rootclaw/sentinel", "/d/rootclaw", "linux")).toBe(true);
    expect(isInside("/d/rootclaw", "/d/rootclaw", "linux")).toBe(true);
    expect(isInside("/d/rootclaw-sentinel", "/d/rootclaw", "linux")).toBe(false);
    expect(isInside("/d", "/d/rootclaw", "linux")).toBe(false);
    expect(isInside("C:\\d\\rootclaw\\x", "C:\\d\\rootclaw", "win32")).toBe(true);
  });
});
