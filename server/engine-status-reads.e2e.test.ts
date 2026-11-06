import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-rootclaw.ts";

it("reuses native model status across instance reads and refreshes it on demand", async () => {
  let modelReads = 0;
  let model = "first-model";
  const provider = createServer((req, res) => {
    if (req.url !== "/v1/models") { res.writeHead(404).end(); return; }
    modelReads++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: model }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("loopback provider address missing");
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(200);
    return result;
  };
  try {
    await api("PATCH", "/api/config", { openaiCompat: {
      key: "loopback-only-fixture-key", url: `http://127.0.0.1:${address.port}/v1`, model,
    } });
    await expect.poll(() => modelReads, { timeout: 15_000 }).toBeGreaterThan(0);
    const first = await api("GET", "/api/instances");
    const afterFirst = modelReads;
    expect(first.instances.find((entry: any) => entry.instanceId === "openaiCompat").models.options.map((entry: any) => entry.id)).toContain("first-model");
    await api("GET", "/api/instances");
    expect(modelReads).toBe(afterFirst);

    model = "second-model";
    const refreshed = await api("POST", "/api/instances/openaiCompat/refresh-models", {});
    expect(modelReads).toBe(afterFirst + 1);
    expect(refreshed.instances.find((entry: any) => entry.instanceId === "openaiCompat").models.options.map((entry: any) => entry.id)).toContain("second-model");
    expect((await api("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "openaiCompat").models.options.map((entry: any) => entry.id)).toContain("second-model");
    expect(modelReads).toBe(afterFirst + 1);
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
