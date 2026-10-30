import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunStore } from "../run-store.ts";
import { createRunRoutes } from "./runs.ts";
import { PASS } from "./table.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const d = mkdtempSync(join(tmpdir(), "runs-routes-")); dirs.push(d);
  const runs = createRunStore({ dataDir: d });
  runs.begin({ runId: "r1", threadId: "seen", botId: "b", model: "m" });
  runs.observe({ type: "turn.completed", turnId: "r1", ok: false, stopReason: "error" });
  runs.begin({ runId: "r2", threadId: "hidden", botId: "b", model: "m" });
  const resumed: string[] = [];
  const route = createRunRoutes({ runs, threadVisible: (_auth, threadId) => threadId !== "hidden", resume: async (run) => { resumed.push(run.threadId); } });
  const call = async (method: string, href: string) => {
    let sent: { status: number; body: unknown } | undefined;
    const url = new URL(href, "http://x");
    const out = await route({ req: {} as never, res: {} as never, url, path: url.pathname, method, auth: {} as never,
      json: ((_res: unknown, status: number, body: unknown) => { sent = { status, body }; }) as never, readBody: (async () => ({})) as never });
    return out === PASS ? "pass" : sent;
  };
  return { call, resumed };
}

describe("run routes", () => {
  it("lists and reads only runs on threads the session can see", async () => {
    const { call } = setup();
    expect(await call("GET", "/api/runs")).toMatchObject({ status: 200, body: { runs: [{ id: "r1" }] } });
    expect(await call("GET", "/api/runs/r1")).toMatchObject({ status: 200, body: { run: { id: "r1", status: "failed" } } });
    expect(await call("GET", "/api/runs/r2")).toMatchObject({ status: 404 });
    expect(await call("GET", "/api/other")).toBe("pass");
  });

  it("retries a failed run once", async () => {
    const { call, resumed } = setup();
    expect(await call("POST", "/api/runs/r1/retry")).toEqual({ status: 200, body: { started: true } });
    expect(resumed).toEqual(["seen"]);
    expect(await call("POST", "/api/runs/r1/retry")).toEqual({ status: 409, body: { error: "already retried" } });
  });
});
