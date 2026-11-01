import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BOX_DENY_ENV } from "./bot-box/boot.ts";
import { boxEnvironment } from "./bot-box/env.ts";
import { PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "./credential-env.ts";

/** Every env name syncCredentialEnv writes a saved secret to. */
function syncedSecretNames(): string[] {
  const source = readFileSync(join(import.meta.dirname, "config.ts"), "utf8");
  const body = source.slice(source.indexOf("export function syncCredentialEnv"));
  const secrets = body.slice(body.indexOf("const secrets"), body.indexOf("];"));
  return [...secrets.matchAll(/"([A-Z0-9_]+)"\]/g)].map((match) => match[1]!);
}

describe("credential env", () => {
  it("keeps every saved secret out of a bot's box", () => {
    const names = syncedSecretNames();
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name) => !(WORKSPACE_CREDENTIAL_ENV as readonly string[]).includes(name))).toEqual([]);
    const env = Object.fromEntries(names.map((name) => [name, "fixture-secret"]));
    expect(Object.keys(boxEnvironment(env, BOX_DENY_ENV))).toEqual([]);
  });

  it("treats every API driver's fallback key as a provider credential", () => {
    const source = readFileSync(join(import.meta.dirname, "drivers", "api-providers.ts"), "utf8");
    const keyEnvs = [...source.matchAll(/keyEnv: "([A-Z0-9_]+)"/g)].map((match) => match[1]!);
    expect(keyEnvs).toContain("OLLAMA_API_KEY");
    const missing = keyEnvs.filter((name) => !(PROVIDER_CREDENTIAL_ENV as readonly string[]).includes(name));
    expect(missing).toEqual([]);
  });
});
