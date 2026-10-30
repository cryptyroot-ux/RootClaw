import { describe, expect, it } from "vitest";

import { BROWSER_BYTES, EngineMemory, readHostMemory } from "./engine-memory.ts";

const GB = 1024 ** 3;

describe("host memory budget for browsers and MCP servers", () => {
  it("reads /proc/meminfo", () => {
    expect(readHostMemory(() => "MemTotal: 4194304 kB\nMemAvailable: 1048576 kB\nSwapFree: 0 kB\n")).toEqual({ totalBytes: 4 * GB, availableBytes: GB, swapFreeBytes: 0 });
    expect(readHostMemory(() => { throw new Error("no /proc"); })).toBeNull();
  });

  it("scales idle keep-alive by headroom, 1 when off", () => {
    expect(new EngineMemory({ enabled: false }).headroom()).toBe(1);
    expect(new EngineMemory({ enabled: true, read: () => ({ totalBytes: 8 * GB, availableBytes: 8 * GB, swapFreeBytes: 0 }) }).headroom()).toBe(1);
    expect(new EngineMemory({ enabled: true, read: () => ({ totalBytes: 8 * GB, availableBytes: 0, swapFreeBytes: 0 }) }).headroom()).toBe(0.1);
  });

  it("calls a browser start tight only when the host can't spare its budget", () => {
    const memory = new EngineMemory({ enabled: true, read: () => ({ totalBytes: 4 * GB, availableBytes: BROWSER_BYTES, swapFreeBytes: 0 }) });
    memory.useBrowsers({ starts: () => true, stopped: () => {} });
    expect(memory.browserTight("t")).toBe(true);
    const roomy = new EngineMemory({ enabled: true, read: () => ({ totalBytes: 4 * GB, availableBytes: 3 * GB, swapFreeBytes: 0 }) });
    roomy.useBrowsers({ starts: () => true, stopped: () => {} });
    expect(roomy.browserTight("t")).toBe(false);
    expect(new EngineMemory({ enabled: true }).stallCause("t", "stalled")).toBe("stalled");
  });
});
