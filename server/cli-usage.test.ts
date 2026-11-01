import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { USAGE } from "./cli-usage.ts";
import { unstableInstallWarning } from "./service-unit.ts";

// The rootclaw npm package is not published; CLI output must point at a built clone.
const UNPUBLISHED = /npx rootclaw|npm (install|i) -g rootclaw/;

describe("CLI install guidance", () => {
  it("never suggests npx or a global npm install", () => {
    expect(USAGE).not.toMatch(UNPUBLISHED);
    expect(USAGE).toContain("node $HOME/RootClaw/dist-server/rootclaw.js");
    expect(unstableInstallWarning("/home/u/.npm/_npx/abc/node_modules/rootclaw/cli.js")).not.toMatch(UNPUBLISHED);
    expect(readFileSync(new URL("./cli.ts", import.meta.url), "utf8")).not.toMatch(UNPUBLISHED);
  });
});
