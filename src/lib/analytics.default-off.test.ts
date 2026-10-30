import { expect, it, vi } from "vitest";

it("is off by default: no PostHog key, no client, no request", async () => {
  vi.stubEnv("VITE_POSTHOG_TOKEN", "");
  vi.resetModules();
  const analytics = await import("./analytics");
  expect(analytics.analyticsEnabled()).toBe(false);
  vi.unstubAllEnvs();
});
