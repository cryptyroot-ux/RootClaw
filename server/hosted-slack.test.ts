import { describe, expect, it } from "vitest";
import { hostedSlackManagement } from "./hosted-slack.ts";

const hosted = {
  ROOTCLAW_ADMIN_URL: "https://admin.example.test",
  ROOTCLAW_PUBLIC_URL: "https://acme.example.test",
  ROOTCLAW_ADMIN_WORKSPACE: "acme",
  ROOTCLAW_ADMIN_MEMBERSHIP: "portal",
};

describe("hosted Slack management link", () => {
  it("uses the configured Admin origin and includes only workspace and agent identifiers", () => {
    expect(hostedSlackManagement("bot_123", true, hosted)).toEqual({
      available: true,
      managementUrl: "https://admin.example.test/slack?workspace=acme&bot=bot_123",
    });
    const result = hostedSlackManagement("bot&workspace=another", true, hosted);
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("missing management URL");
    expect([...new URL(result.managementUrl).searchParams]).toEqual([
      ["workspace", "acme"], ["bot", "bot&workspace=another"],
    ]);
  });

  it("requires a ready runtime with complete portal-managed hosted configuration", () => {
    expect(hostedSlackManagement("bot_123", false, hosted)).toEqual({ available: false });
    for (const env of [
      {}, { ...hosted, ROOTCLAW_ADMIN_MEMBERSHIP: undefined },
      { ...hosted, ROOTCLAW_ADMIN_MEMBERSHIP: "local" },
      { ...hosted, ROOTCLAW_ADMIN_URL: "http://admin.example.test" },
      { ...hosted, ROOTCLAW_ADMIN_URL: "https://admin.example.test/another" },
      { ...hosted, ROOTCLAW_ADMIN_URL: "https://user:secret@admin.example.test" },
      { ...hosted, ROOTCLAW_PUBLIC_URL: undefined },
      { ...hosted, ROOTCLAW_ADMIN_WORKSPACE: "../another" },
    ]) expect(hostedSlackManagement("bot_123", true, env)).toEqual({ available: false });
  });
});
