import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APP_LIMITS } from "../shared/app.ts";
import { JSX_PAGE_LIBRARIES, JSX_PAGE_MODULES } from "../shared/app-frame/jsx-page.ts";
import { BOT_HTML_CDNS } from "../shared/app-frame/csp.ts";
import { loadBundledSkills, loadUserSkills, mergeSkills, parseSkillManifest, renderSkillInstructions, selectBundledSkills, type BundledSkill } from "./skill-library.ts";

const instructionsFor = (text: string, capabilities: string[], skills: BundledSkill[], options?: { includeRoot?: boolean }) =>
  renderSkillInstructions(selectBundledSkills(text, capabilities, skills), options);

const phone: BundledSkill = {
  directory: "/skills/phone-harness",
  instructions: "---\nname: phone-harness\ndescription: test\n---\nUse phone tools.",
  manifest: {
    id: "phone-harness",
    name: "Phone Harness",
    version: "0.1.0",
    description: "Control a phone",
    defaultEnabled: true,
    triggerTerms: ["android", "phone"],
    requiredCapabilities: ["phoneMcp"],
  },
};

describe("bundled skill library", () => {
  it("selects a skill only when both its trigger and capability are present", () => {
    const rendered = instructionsFor("Open Uber on my Android", ["phoneMcp"], [phone]);
    expect(rendered).toContain("Use phone tools");
    expect(rendered).not.toContain('root="/skills/phone-harness"');
    expect(instructionsFor("Open Uber on my Android", ["phoneMcp"], [phone], { includeRoot: true }))
      .toContain('root="/skills/phone-harness"');
    expect(instructionsFor("Open Uber on my Android", [], [phone])).toBe("");
    expect(instructionsFor("Write a poem", ["phoneMcp"], [phone])).toBe("");
  });

  it("requires the manifest id to match its isolated folder", () => {
    expect(() => parseSkillManifest({
      ...phone.manifest,
      id: "other-skill",
    }, "/skills/phone-harness")).toThrow(/invalid id/);
  });

  it("loads a user skill without letting a broken sibling disable it", () => {
    const root = mkdtempSync(join(tmpdir(), "rootclaw-skills-"));
    const valid = join(root, "file-expense");
    mkdirSync(valid);
    writeFileSync(join(valid, "manifest.json"), JSON.stringify({
      id: "file-expense", name: "File expense", version: "1.0.0", description: "File expenses",
      defaultEnabled: true, triggerTerms: ["expense"], requiredCapabilities: [],
    }));
    writeFileSync(join(valid, "SKILL.md"), "---\nname: file-expense\ndescription: File expenses\n---\nDo it safely.\n");
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "manifest.json"), "not json");
    writeFileSync(join(broken, "SKILL.md"), "broken");

    expect(loadUserSkills(root).map((skill) => skill.manifest.id)).toEqual(["file-expense"]);
  });

  it("does not let a user skill shadow a bundled skill id", () => {
    expect(mergeSkills([phone], [{ ...phone, instructions: "user replacement" }])).toEqual([phone]);
  });

  it("treats a non-directory user skill root as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "rootclaw-skills-root-"));
    const file = join(root, "not-a-directory");
    writeFileSync(file, "nope");
    expect(loadUserSkills(file)).toEqual([]);
  });
});

describe("bundled verification skill", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const instructions = skills.find((skill) => skill.manifest.id === "create-verification-skill")?.instructions ?? "";

  it("ships one reviewed authoring adapter", () => {
    const ids = skills.map((skill) => skill.manifest.id);
    expect(ids).toContain("create-verification-skill");
    expect(ids).not.toContain("maintain-verification-skill");
    expect(instructions).toContain("skill_manage");
    expect(instructions).not.toContain("~/.rootclaw");
    expect(instructions).not.toContain("propose_routine");
  });

  it("requires skill authoring and an explicit creation request", () => {
    for (const text of [
      "/create-verification-skill for my notes app",
      "can you make a verification skill so you can prove changes work",
    ]) {
      expect(selectBundledSkills(text, [], skills)).toEqual([]);
      expect(selectBundledSkills(text, ["skillAuthoring"], skills).map((skill) => skill.manifest.id))
        .toEqual(["create-verification-skill"]);
    }
  });

  it("does not mount for generic verification or maintenance phrasing", () => {
    for (const text of [
      "please verify the numbers in this invoice",
      "maintain the verification skill for atlas",
      "the verification skill is stale",
      "make a control cli",
      "create a feature map for my app",
    ]) {
      expect(selectBundledSkills(text, ["skillAuthoring"], skills)).toEqual([]);
    }
  });
});

describe("bundled data-dashboards skill", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const guide = skills.find((skill) => skill.manifest.id === "data-dashboards")?.instructions ?? "";
  const template = readFileSync(join(process.cwd(), "skills", "data-dashboards", "dashboard.html"), "utf8");
  const ids = (text: string) => selectBundledSkills(text, [], skills).map((skill) => skill.manifest.id);

  it("mounts for dashboards and charts with no capability, and stays out of other turns", () => {
    for (const text of ["Build me a sales dashboard", "Chart revenue by month", "can you visualise this?", "Show our KPIs on a page", "make a graph of signups", "graph it by week"]) {
      expect(ids(text), text).toContain("data-dashboards");
    }
    for (const text of ["Write a paragraph about photography", "fix the typo in my biography", "summarize this email", "book a call for Friday"]) {
      expect(ids(text), text).not.toContain("data-dashboards");
    }
  });

  it("mounts for a page to look at, and its page guide names the shell's own building blocks and versions", () => {
    for (const text of ["Make me a pricing page", "build a landing page for the bake sale", "Can you mock-up a signup form as a page?", "a quick prototype of the settings screen"]) {
      expect(ids(text), text).toContain("data-dashboards");
    }
    for (const module of JSX_PAGE_MODULES.filter((name) => !name.includes("/"))) expect(guide, module).toContain(`\`${module}\``);
    const minor = (version: string) => version.split(".").slice(0, 2).join(".");
    expect(guide).toContain(`\`react\` (${minor(JSX_PAGE_LIBRARIES.react)})`);
    expect(guide).toContain(`\`echarts\` (${minor(JSX_PAGE_LIBRARIES.echarts)})`);
    expect(guide).toContain(`Tailwind classes (${minor(JSX_PAGE_LIBRARIES["@tailwindcss/browser"])})`);
  });

  it("keeps the guide short, in plain words, and pointing at its template", () => {
    expect(guide.split("\n").length).toBeLessThanOrEqual(150);
    expect(guide).not.toMatch(/\b(engines?|servers?)\b/i);
    expect(guide).toContain("dashboard.html");
  });

  it("ships a template that loads exact versions from a CDN a chat page allows, with room left for embedded data", () => {
    const urls = [...template.matchAll(/https:\/\/[^\s"'`)]+/g)].map((match) => match[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(BOT_HTML_CDNS.some((cdn) => url === cdn || url.startsWith(`${cdn}/`)), url).toBe(true);
    for (const url of urls.filter((each) => each.includes("/npm/"))) expect(url, url).toMatch(/\/npm\/(@[\w-]+\/)?[\w.-]+@\d+\.\d+\.\d+\//);
    expect(template).toContain('id="embedded-data"');
    expect(Buffer.byteLength(template)).toBeLessThan(APP_LIMITS.htmlBytes / 4);
  });
});

describe("vendored Superpowers skills", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const representativePrompts: Record<string, string> = {
    brainstorming: "Help me design an approach for a new feature before building it",
    "diagnosing-superpowers": "Diagnose why a skill is not triggering",
    "dispatching-parallel-agents": "Fan out these independent subtasks to parallel agents",
    "executing-plans": "Execute the implementation plan",
    "finishing-a-development-branch": "Finish this branch and open a PR",
    "receiving-code-review": "Address this code review feedback",
    "requesting-code-review": "Request a code review for my PR",
    "subagent-driven-development": "Implement this with subagent driven development",
    "systematic-debugging": "Debug this failing test and find the root cause",
    "test-driven-development": "Use red green refactor and write a test first",
    "using-git-worktrees": "Create an isolated git worktree for this branch",
    "using-superpowers": "Which skill should I use for this task?",
    "verification-before-completion": "Before the PR, verify all tests pass before claiming this is done",
    "writing-plans": "Write a multi-step implementation plan before coding",
    "writing-skills": "Author a new SKILL.md for this workflow",
  };

  it("loads all 15 built-ins for every bot by default and auto-selects them by natural-language relevance", () => {
    expect(Object.keys(representativePrompts).sort()).toEqual([
      "brainstorming", "diagnosing-superpowers", "dispatching-parallel-agents", "executing-plans",
      "finishing-a-development-branch", "receiving-code-review", "requesting-code-review",
      "subagent-driven-development", "systematic-debugging", "test-driven-development",
      "using-git-worktrees", "using-superpowers", "verification-before-completion", "writing-plans", "writing-skills",
    ]);
    const byId = new Map(skills.map((skill) => [skill.manifest.id, skill]));
    for (const [id, prompt] of Object.entries(representativePrompts)) {
      const skill = byId.get(id);
      expect(skill, id).toBeDefined();
      expect(skill!.manifest.defaultEnabled, id).toBe(true);
      expect(skill!.manifest.requiredCapabilities, id).toEqual([]);
      expect(selectBundledSkills(prompt, [], skills).map((selected) => selected.manifest.id), prompt).toContain(id);
    }
    expect(skills.map((skill) => skill.manifest.id).filter((id) => id in representativePrompts).sort())
      .toEqual(Object.keys(representativePrompts).sort());
    expect(selectBundledSkills("write a paragraph about photography", [], skills)
      .filter((skill) => skill.manifest.id in representativePrompts).map((skill) => skill.manifest.id)).toEqual([]);
  });
});
