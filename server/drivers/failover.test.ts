import { describe, expect, it } from "vitest";
import { HttpStatusError } from "./retry.ts";
import { failoverHold, failoverKind } from "./failover.ts";

const clean = { aborted: false, produced: false };

describe("failoverKind: which failures move a turn to the next AI in the chain", () => {
  it("moves on quota, auth, persistent server errors, unknown models and an overflow that compaction could not fix", () => {
    expect(failoverKind(new HttpStatusError("429 insufficient_quota: You exceeded your current quota", 429), clean)).toBe("quota");
    expect(failoverKind(new HttpStatusError("401 Unauthorized", 401), clean)).toBe("auth");
    expect(failoverKind(new HttpStatusError("503 Service Unavailable", 503), clean)).toBe("server");
    expect(failoverKind(new HttpStatusError("429 Too Many Requests", 429), clean)).toBe("server");
    expect(failoverKind(new HttpStatusError("404 model not found", 404), clean)).toBe("model");
    expect(failoverKind(new Error("fetch failed"), clean)).toBe("server");
    expect(failoverKind(new Error("x"), { ...clean, tooLarge: true })).toBe("context");
  });

  it("never moves on a request the person caused, an abort, or once output reached the person", () => {
    expect(failoverKind(new HttpStatusError("400 Bad Request: invalid tool schema", 400), clean)).toBeNull();
    expect(failoverKind(new HttpStatusError("422 Unprocessable", 422), clean)).toBeNull();
    expect(failoverKind(new HttpStatusError("503 Service Unavailable", 503), { aborted: true, produced: false })).toBeNull();
    expect(failoverKind(new HttpStatusError("503 Service Unavailable", 503), { aborted: false, produced: true })).toBeNull();
    expect(failoverKind(new Error("provider returned an empty response"), clean)).toBeNull();
  });

  it("holds each failed entry for a cooldown fitting its failure, so the chain returns to it later", () => {
    const now = 1_000_000;
    expect(failoverHold("quota", now)).toEqual({ limit: "engine" });
    expect(failoverHold("server", now)).toEqual({ limit: "model", limitResetsAt: now + 10 * 60_000 });
    expect(failoverHold("context", now)).toEqual({ limit: "model", limitResetsAt: now + 10 * 60_000 });
    expect(failoverHold("model", now)).toEqual({ limit: "model", limitResetsAt: now + 6 * 60 * 60_000 });
    expect(failoverHold("auth", now)).toEqual({ stopReason: "auth_required" });
  });
});
