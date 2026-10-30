import { describe, expect, it } from "vitest";

import { aiSignInKey, rankAis } from "./ai-ranking.ts";

type Row = { id: string; driverKind: string; snapshot?: { freeFallback?: boolean } };
const row = (id: string, driverKind: string, snapshot?: Row["snapshot"]): Row => ({ id, driverKind, ...(snapshot ? { snapshot } : {}) });
const ids = (rows: readonly Row[]) => rows.map((entry) => entry.id);

const xai = row("xai", "grok");
const groq = row("groq", "groq");
const compat = row("compat", "openai-compat");
const freeCompat = row("free", "openai-compat", { freeFallback: true });

describe("one ranking of the AIs a new person has", () => {
  it("puts xAI first, then the rest in config order, and free-only fallbacks last", () => {
    expect(ids(rankAis([groq, freeCompat, compat, xai]))).toEqual(["xai", "groq", "compat", "free"]);
    expect(ids(rankAis([freeCompat]))).toEqual(["free"]);
  });

  it("never reorders the list it is given", () => {
    const list = [groq, xai];
    rankAis(list);
    expect(ids(list)).toEqual(["groq", "xai"]);
    expect(rankAis([])).toEqual([]);
  });
});

describe("a sign-in, as a test result's key", () => {
  it("changes when the sign-in changes, and only then", () => {
    const signedIn = { state: "available", authenticated: true, account: { email: "a@example.test" } };
    expect(aiSignInKey(signedIn)).toBe(aiSignInKey({ ...signedIn, version: "2.0.0" }));
    expect(aiSignInKey(signedIn)).not.toBe(aiSignInKey({ ...signedIn, account: { email: "b@example.test" } }));
    expect(aiSignInKey(signedIn)).not.toBe(aiSignInKey({ ...signedIn, authenticated: false }));
    expect(aiSignInKey({ state: "available", authenticated: true, freeFallback: true }))
      .not.toBe(aiSignInKey({ state: "available", authenticated: true }));
  });
});
