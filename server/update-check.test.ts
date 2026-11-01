import { join, posix, sep, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { cloneRoot, createUpdateChecker, installKind, isNewerVersion, LATEST_RELEASE_URL, NOT_A_CLONE, UPDATE_COMMANDS } from "./update-check.ts";

const release = (tag: string) =>
  ({ ok: true, status: 200, json: async () => ({ tag_name: tag, html_url: `https://github.com/cryptyroot-ux/RootClaw/releases/tag/${tag}` }) }) as Response;

describe("server update check", () => {
  it("tells how this server was installed", () => {
    const none = () => false;
    const root = ["", "srv", "RootClaw", "server"].join(sep);
    expect(installKind({ desktopManaged: true, managed: false, serverRoot: root, exists: () => true })).toBe("desktop");
    expect(installKind({ desktopManaged: false, managed: true, serverRoot: root, exists: () => true })).toBe("managed");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === "/.dockerenv" })).toBe("docker");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === "/run/.containerenv" })).toBe("podman");
    expect(installKind({
      desktopManaged: false, managed: false, exists: none,
      serverRoot: ["", "usr", "lib", "node_modules", "rootclaw", "dist-server"].join(sep),
    })).toBe("npm");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === join(root, "..", ".git") })).toBe("git");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: none })).toBe("unknown");
  });

  it("updates a clone with git pull and a rebuild, and never offers the unpublished npm package", async () => {
    const root = ["", "srv", "RootClaw"].join(sep);
    expect(cloneRoot(join(root, "dist-server"), (path) => path === join(root, ".git"))).toBe(root);
    expect(cloneRoot(join(root, "dist-server"), () => false)).toBeNull();
    expect(cloneRoot("/srv/RootClaw/dist-server", (path) => path === "/srv/RootClaw/.git", posix)).toBe("/srv/RootClaw");
    expect(cloneRoot("C:\\RootClaw\\dist-server", (path) => path === "C:\\RootClaw\\.git", win32)).toBe("C:\\RootClaw");
    expect(UPDATE_COMMANDS.git).toEqual({ command: "git pull && pnpm install --frozen-lockfile && pnpm build && pnpm build:server", restart: true });
    for (const install of ["npm", "git", "docker", "podman", "unknown"] as const) {
      expect(UPDATE_COMMANDS[install]?.command ?? "").not.toMatch(/npm (install|i) -g/);
      // no RootClaw image is published (docs/self-hosting.md), so a pull has nothing to fetch
      expect(UPDATE_COMMANDS[install]?.command ?? "").not.toMatch(/docker compose pull/);
    }
    const check = createUpdateChecker({ current: "0.1.92", install: "npm", fetch: vi.fn(async () => release("v0.1.93")) });
    const result = await check();
    expect(result).toMatchObject({ available: true, latest: "0.1.93", note: NOT_A_CLONE });
    expect(result.command).toBeUndefined();
    expect(NOT_A_CLONE).toMatch(/not a git clone/);
    expect(NOT_A_CLONE).toContain("git pull && pnpm install --frozen-lockfile && pnpm build && pnpm build:server");
  });

  it("compares release versions numerically and never reports a malformed one", () => {
    expect(isNewerVersion("v0.1.93", "0.1.92")).toBe(true);
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
    expect(isNewerVersion("v0.2.0", "0.1.99")).toBe(true);
    expect(isNewerVersion("v0.1.92", "0.1.92")).toBe(false);
    expect(isNewerVersion("v0.1.91", "0.1.92")).toBe(false);
    expect(isNewerVersion("nightly", "0.1.92")).toBe(false);
    expect(isNewerVersion("v0.1.93", "unknown")).toBe(false);
    expect(isNewerVersion("v0.1.93", "0.1.93-rc.1")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.2", "0.1.93-rc.1")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.10", "0.1.93-rc.9")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.1", "0.1.93")).toBe(false);
    expect(isNewerVersion("v0.1.93-rc.1", "0.1.93-rc.1")).toBe(false);
    expect(isNewerVersion("v0.1.93-rc.1.1", "0.1.93-rc.1")).toBe(true);
  });

  it("reports a newer release with the update command for this install", async () => {
    const fetch = vi.fn(async () => release("v0.1.93"));
    const check = createUpdateChecker({ current: "0.1.92", install: "docker", fetch });
    expect(await check()).toEqual({
      current: "0.1.92",
      install: "docker",
      latest: "0.1.93",
      available: true,
      releaseUrl: "https://github.com/cryptyroot-ux/RootClaw/releases/tag/v0.1.93",
      command: "git pull && docker compose up -d --build",
      restart: false,
    });
    expect(fetch).toHaveBeenCalledWith(LATEST_RELEASE_URL, expect.anything());
  });

  it("says up to date, and asks GitHub at most once an hour", async () => {
    let now = 0;
    const fetch = vi.fn(async () => release("v0.1.92"));
    const check = createUpdateChecker({ current: "0.1.92", install: "npm", fetch, now: () => now });
    expect(await check()).toMatchObject({ available: false, latest: "0.1.92", note: NOT_A_CLONE });
    now = 59 * 60_000;
    await check();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 61 * 60_000;
    await check();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not look anything up for a desktop or hosted server", async () => {
    const fetch = vi.fn();
    for (const install of ["desktop", "managed"] as const) {
      expect(await createUpdateChecker({ current: "0.1.92", install, fetch })()).toEqual({ current: "0.1.92", install, available: false });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails clearly when GitHub cannot be reached, and tries again next time", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response);
    const check = createUpdateChecker({ current: "0.1.92", install: "git", fetch });
    await expect(check()).rejects.toThrow("GitHub answered 403");
    fetch.mockImplementation(async () => release("v0.1.93"));
    expect(await check()).toMatchObject({ available: true, command: "git pull && pnpm install --frozen-lockfile && pnpm build && pnpm build:server", restart: true });
  });
});
