// Engine task eval: small, realistic tool-using tasks for the native engine's workspace tools (shell, files,
// patch). Each task seeds a temp workspace and has an automatic checker; no human or model judgment.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CheckResult { pass: boolean; why: string }
export interface EngineTask {
  id: string;
  prompt: string;
  files: Record<string, string>;
  check(dir: string): CheckResult;
  /** A known-good end state, used by the harness's own test to prove each checker accepts a correct fix. */
  solution: Record<string, string>;
}

const node = (dir: string, ...args: string[]): { ok: boolean; out: string } => {
  try { return { ok: true, out: execFileSync(process.execPath, args, { cwd: dir, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (error) { const e = error as { stdout?: string; stderr?: string }; return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
};
const read = (dir: string, file: string) => existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : null;
const unchanged = (dir: string, files: Record<string, string>, names: string[]) => names.find((name) => read(dir, name) !== files[name]);
const pass = (why = "ok"): CheckResult => ({ pass: true, why });
const fail = (why: string): CheckResult => ({ pass: false, why: why.slice(0, 300) });

const MEDIAN_TEST = `import assert from "node:assert/strict";
import { median } from "./stats.js";
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([5, 1, 4, 2]), 3);
assert.equal(median([7]), 7);
assert.equal(median([10, -2, 4, 4]), 4);
console.log("stats ok");
`;
const fixFunction: EngineTask = {
  id: "fix-function",
  prompt: "The test `node stats.test.mjs` fails. Fix the bug in stats.js so the test passes. Do not change the test file. Run the test to confirm.",
  files: {
    "package.json": '{ "type": "module" }\n',
    "stats.js": "export function median(xs) {\n  const mid = Math.floor(xs.length / 2);\n  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;\n}\n",
    "stats.test.mjs": MEDIAN_TEST,
  },
  check(dir) {
    const bad = unchanged(dir, this.files, ["stats.test.mjs"]);
    if (bad) return fail(`${bad} was modified`);
    const run = node(dir, "stats.test.mjs");
    return run.ok && run.out.includes("stats ok") ? pass() : fail(`test still fails: ${run.out}`);
  },
  solution: { "stats.js": "export function median(input) {\n  const xs = [...input].sort((a, b) => a - b);\n  const mid = Math.floor(xs.length / 2);\n  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;\n}\n" },
};

const bugFromLog: EngineTask = {
  id: "bug-from-log",
  prompt: "Our service crashes on start; the error is in error.log. Find the root cause in the code and fix it so `node app.js` prints the listening line. config.json is correct and must not be changed.",
  files: {
    "config.json": '{ "server": { "host": "127.0.0.1", "port": 8080 }, "debug": false }\n',
    "app.js": "const { readFileSync } = require(\"node:fs\");\nfunction loadConfig() {\n  const cfg = JSON.parse(readFileSync(__dirname + \"/config.json\", \"utf8\"));\n  return { host: cfg.srv.host, port: cfg.srv.port };\n}\nconst { host, port } = loadConfig();\nconsole.log(`listening on ${host}:${port}`);\n",
    "error.log": "2026-10-30T21:04:11Z app starting\nTypeError: Cannot read properties of undefined (reading 'host')\n    at loadConfig (app.js:4:28)\n    at Object.<anonymous> (app.js:6:24)\n",
  },
  check(dir) {
    const bad = unchanged(dir, this.files, ["config.json"]);
    if (bad) return fail(`${bad} was modified`);
    const run = node(dir, "app.js");
    return run.ok && run.out.trim() === "listening on 127.0.0.1:8080" ? pass() : fail(`app output: ${run.out}`);
  },
  solution: { "app.js": "const { readFileSync } = require(\"node:fs\");\nfunction loadConfig() {\n  const cfg = JSON.parse(readFileSync(__dirname + \"/config.json\", \"utf8\"));\n  return { host: cfg.server.host, port: cfg.server.port };\n}\nconst { host, port } = loadConfig();\nconsole.log(`listening on ${host}:${port}`);\n" },
};

const renameFiles = {
  "users.js": "function getUserName(user) {\n  return `${user.first} ${user.last}`;\n}\nmodule.exports = { getUserName };\n",
  "greet.js": "const { getUserName } = require(\"./users.js\");\nmodule.exports = (user) => `Hello, ${getUserName(user)}!`;\n",
  "main.js": "const { getUserName } = require(\"./users.js\");\nconst greet = require(\"./greet.js\");\nconst ada = { first: \"Ada\", last: \"Lovelace\" };\nconsole.log(getUserName(ada));\nconsole.log(greet(ada));\n",
};
const renameSymbol: EngineTask = {
  id: "rename-symbol",
  prompt: "Rename the function getUserName to fullName everywhere in this project (users.js, greet.js, main.js), including its export and imports. Behaviour must not change; check with `node main.js`.",
  files: renameFiles,
  check(dir) {
    for (const name of Object.keys(renameFiles)) {
      const text = read(dir, name) ?? "";
      if (text.includes("getUserName")) return fail(`${name} still mentions getUserName`);
      if (!text.includes("fullName")) return fail(`${name} does not use fullName`);
    }
    const run = node(dir, "main.js");
    return run.ok && run.out === "Ada Lovelace\nHello, Ada Lovelace!\n" ? pass() : fail(`main.js output: ${run.out}`);
  },
  solution: Object.fromEntries(Object.entries(renameFiles).map(([name, text]) => [name, text.replaceAll("getUserName", "fullName")])),
};

const HIDDEN_SLUG_CHECK = `import assert from "node:assert/strict";
import { slugify } from "./slugify.js";
assert.equal(slugify("Hello World"), "hello-world");
assert.equal(slugify("  Trim  me  "), "trim-me");
assert.equal(slugify("Rock & Roll!"), "rock-roll");
assert.equal(slugify("a--b__c"), "a-b-c");
assert.equal(slugify("Café 2026"), "cafe-2026");
assert.equal(slugify(""), "");
console.log("slug ok");
`;
const createFile: EngineTask = {
  id: "create-file",
  prompt: "Create slugify.js (ES module) exporting slugify(text): lowercase; strip accents (é→e); every run of characters that are not a-z or 0-9 becomes one '-'; no leading or trailing '-'; empty input gives ''. Write a quick check of your own and run it with node.",
  files: { "package.json": '{ "type": "module" }\n' },
  check(dir) {
    if (!existsSync(join(dir, "slugify.js"))) return fail("slugify.js missing");
    const probe = join(dir, ".hidden-slug-check.mjs");
    writeFileSync(probe, HIDDEN_SLUG_CHECK);
    const run = node(dir, ".hidden-slug-check.mjs");
    return run.ok && run.out.includes("slug ok") ? pass() : fail(`hidden check: ${run.out}`);
  },
  solution: { "slugify.js": "export function slugify(text) {\n  return text.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g, \"\").toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");\n}\n" },
};

const SALES = "date,region,product,units,price\n2026-10-01,north,widget,3,2.50\n2026-10-01,south,gadget,1,10.00\n2026-10-02,north,gadget,2,10.00\n2026-10-02,east,widget,10,2.50\n2026-10-03,south,widget,4,2.50\n2026-10-03,east,gizmo,1,99.99\n";
const csvTransform: EngineTask = {
  id: "csv-transform",
  prompt: "Read sales.csv and write totals.json: an array of { region, revenue } (revenue = sum of units*price, rounded to 2 decimals) for every region, sorted by revenue descending. Then print totals.json to confirm.",
  files: { "sales.csv": SALES },
  check(dir) {
    const text = read(dir, "totals.json");
    if (text === null) return fail("totals.json missing");
    let data: unknown;
    try { data = JSON.parse(text); } catch { return fail("totals.json is not JSON"); }
    const want = [{ region: "east", revenue: 124.99 }, { region: "south", revenue: 20 }, { region: "north", revenue: 27.5 }]
      .sort((a, b) => b.revenue - a.revenue);
    const got = Array.isArray(data) ? data.map((row) => ({ region: (row as { region?: unknown }).region, revenue: Number((row as { revenue?: unknown }).revenue) })) : null;
    return JSON.stringify(got) === JSON.stringify(want) ? pass() : fail(`totals.json = ${text.slice(0, 200)}`);
  },
  solution: { "totals.json": JSON.stringify([{ region: "east", revenue: 124.99 }, { region: "north", revenue: 27.5 }, { region: "south", revenue: 20 }]) },
};

export const ENGINE_TASKS: EngineTask[] = [fixFunction, bugFromLog, renameSymbol, createFile, csvTransform];
