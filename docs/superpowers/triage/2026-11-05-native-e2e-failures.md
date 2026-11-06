# Native E2E failure triage

- **Source run:** `.superpowers/sdd/2026-11-05-r4-plan-compaction/pnpm-test.log`
- **Baseline commit:** `dadaa1690263cdbd86f0d0642d319a9a427ccfee`
- **Scope:** failure inventory and reproduced causes only; no application/test code changes are recorded here.

## Original Vitest result

```text
Test Files  184 failed | 1797 passed | 47 skipped (2028)
```
```text
Tests  584 failed | 23833 passed | 354 skipped | 3 todo (24774)
```
```text
Errors  1 error
```
```text
Start at  05:07:37
```
```text
Duration  8177.02s (transform 72.01s, setup 393.55s, import 443.42s, tests 6947.04s, environment 57.70s)
```

The verbose summary contains **584 failed-test markers across 174 test-bearing files**. The footer reports **584 failed tests and 184 failed files**. The detailed `Failed Suites` section has 606 `FAIL` headings because it also reports suite setup/cleanup errors; ten paths have no failed-test markers. These are distinct report units, not an alternate failed-test total.

The run stopped during Vitest; broker, Electron, and packaged-server stages did not run. One unhandled loopback socket rejection was reported from `server/cloud-sync.e2e.test.ts`.

## Confirmed reproductions on this worktree

| Command | Observed first failure | Root-cause status |
|---|---|---|
| `pnpm exec vitest run server/group-local-vm.e2e.test.ts -t "resumes an existing per-bot VM even at the instance cap"` | POST message returns `provider instance "" is unavailable` | The fixture writes only a removed `claudeAgent` instance and no native default selection; confirmed in this test. |
| `pnpm exec vitest run server/bulk-delete-tasks.e2e.test.ts` | `beforeAll` cannot chmod the absent `server/testing/fake-claude-cli.ts`; `afterAll` then also fails on the unset gate | Removed fake executable is the primary cause; cleanup failure is secondary. |
| `pnpm exec vitest run server/escalations.e2e.test.ts -t "delivers a pending peer-comm approval card to the Chief's escalations thread"` | `PATCH /api/instances/claude` returns 400 for the obsolete CLI setting | Test configures a retired instance API; confirmed. |
| `pnpm exec vitest run server/bot-setup.e2e.test.ts` | Expects `hello from fake claude`, receives the current native fake's `Fixture reply: ...` | Stale fixture-output expectation; exact desired assertion still needs to be checked against the test intent. |
| `pnpm exec vitest run server/drivers/workspace-tools.test.ts -t "tracks background commands per conversation and stops their whole process groups"` | Grandchild still appears alive after the 5-second poll (`Matcher did not succeed in time`) | Separate process-lifecycle failure; reproduced, cause not yet traced. |
| `pnpm exec vitest run server/cloud-sync.e2e.test.ts -t "a bot's turn wakes the desktop"` | Message returns 409 for missing provider; pending sync fetch rejects with `UND_ERR_SOCKET` during cleanup | Provider rejection is reproduced; socket rejection is likely downstream but not yet proven independent. |

## Static indicators in failing files

These are overlapping source-reference counts across the 184 failing paths, **not** counts of failing tests or confirmed causes:

- 59 files reference `server/testing/fake-claude-cli.ts`.
- 50 files contain `claudeAgent` or `codexAgent` driver literals.
- 47 files explicitly select a legacy instance ID (`claude`, `codex`, `pi`, or `muse`).
- 14 files reference `/api/instances/claude` or `/api/instances/codex`.
- Several `FAKE_CLAUDE_*` knobs are intentionally aliased by `fake-openai-chat.ts`; a legacy variable name by itself is not evidence that a fixture needs editing.

## Failed test inventory

Every failed test title from the verbose summary is listed below. The first detailed error and the single-file reproduction command are per-file; individual failures in one file may have different causes.

### `electron/updater.test.mjs` — 1 failed test(s)
- First detailed error (log line 3137): `AssertionError: darwin: expected false to be true // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run electron/updater.test.mjs`
  - `a downloaded update installs by itself at a quiet moment on macOS and Windows, and Linux installs stay the person's 18ms`

### `scripts/testing/cloud-sleep-wake.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 13688): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run scripts/testing/cloud-sleep-wake.e2e.test.ts`
  - `after Wake it now the page stays awake, the home's pending sleep ends, and the bot's reply shows 961ms`

### `scripts/testing/key-readback.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 13707): `AssertionError: expected [ 'openai', 'anthropic', 'xai', …(22) ] to deeply equal [ 'openai', 'anthropic', 'xai', …(21) ]`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run scripts/testing/key-readback.e2e.test.ts`
  - `saves every kind of credential, reads it back and shows it masked to its last four, then removes it 13ms`

### `server/active-routines-context.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3156): `AssertionError: expected [] to have a length of 1 but got +0`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/active-routines-context.e2e.test.ts`
  - `shows a work conversation's interval monitor and stop rule in main chat, then reads back its pause 4294ms`

### `server/agents-bridge.e2e.test.ts` — 3 failed test(s)
- First detailed error (log line 3175): `TypeError: Cannot read properties of undefined (reading 'ROOTCLAW_AGENTS_TOOL_BRIDGE')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/agents-bridge.e2e.test.ts`
  - `keeps a turn on the whole catalog until the switch is on, then mounts the bridge and says so, in a chat and in a room 3826ms`
  - `leaves every gate and limit where it was: a tool selection, a Chief-only tool and the per-turn thread limit hold for a bridged call as for a direct one 3818ms`
  - `knows a bridged call by the tool it ran, in the activity row, the work summary and the restart policy's evidence, and leaves an unbridged turn's rows alone 3724ms`

### `server/app-events-cloud.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3222): `AssertionError: expected 'failed' to be 'completed' // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/app-events-cloud.e2e.test.ts`
  - `registers the Cloud, holds the paid limit from the Admin's grant, and runs an owner automation from an app event 32192ms`

### `server/app-events.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3241): `AssertionError: expected +0 to be 1 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/app-events.e2e.test.ts`
  - `sets up an app-event automation from chat, runs on a Composio event, and shows pause, skips, reconnect and undo 20090ms`

### `server/automation-reports.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 3265): `AssertionError: expected 'running' to be 'completed' // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/automation-reports.e2e.test.ts`
  - `holds a report while the person's own turn runs in the main chat, never delays that turn, and writes it once right after 32627ms`
  - `copies a question a run waits on into the main chat, and the answer given there carries the run on 22443ms`
  - `answers the run itself when the person gives a 👍 to the copy of the question it waits on 23564ms`
  - `says in the main chat, once per run of failures, that an automation could not finish 32345ms`

### `server/automations-lifecycle.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3353): `AssertionError: expected 'failed' to be 'completed' // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/automations-lifecycle.e2e.test.ts`
  - `turns schedules and webhooks back on, removes a deleted bot's automations, and clears orphans at start 32491ms`

### `server/boot-readiness.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 3372): `AssertionError: expected { instanceId: '', model: '' } to match object { instanceId: 'claude', …(1) }`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/boot-readiness.e2e.test.ts`
  - `makes a first run's starter bot on the engine a new bot gets 2168ms`
  - `answers on a later start while an engine CLI is still being probed, and runs turns once it has answered 14362ms`
  - `runs a turn on a later start once its own engine has answered, while another engine's CLI is still being probed 2181ms`
  - `starts the words a later start restored before a message sent while the engines are read 14689ms`

### `server/bot-continuity.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3450): `TypeError: Cannot read properties of undefined (reading 'models')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/bot-continuity.e2e.test.ts`
  - `keeps ordinary work out of setup and carries explicit bot defaults and file locations into rooms 2289ms`

### `server/bot-setup.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3462): `AssertionError: expected '{"bot":{"id":"0ed34786-eb23-49a4-8ef1…' to contain 'hello from fake claude'`
- Preliminary cluster: **Legacy fake reply expectation** — confirmed in bot-setup against the current native fake reply.
- Reproduction: `pnpm exec vitest run server/bot-setup.e2e.test.ts`
  - `dispatches setup and canonical standing instructions through the real isolated app 6007ms`

### `server/browser-shutdown.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 3478): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/browser-shutdown.e2e.test.ts`
  - `closes the browser a bot used when the server stops 2369ms`
  - `leaves the person's Chrome running for a profile set to My Chrome 2223ms`
  - `keeps a built-in profile on its own browser even when a Chrome address is configured 2278ms`
  - `closes a profile's built-in browser, saving its logins, when the profile switches to My Chrome 2238ms`

### `server/chat-apps-mcp.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3558): `TypeError: Cannot read properties of undefined (reading 'ROOTCLAW_COMMS_TOKEN')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/chat-apps-mcp.e2e.test.ts`
  - `learns a server's apps, observes its tool call into an app row, and runs its frame's calls under the bot's rules 3664ms`

### `server/chat-apps.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3570): `AssertionError: expected false to be true // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/chat-apps.e2e.test.ts`
  - `shows, replaces and serves a bot's page, and carries its context and its message to the engine 17581ms`

### `server/chat-pages.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3592): `TypeError: Cannot read properties of undefined (reading '0')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/chat-pages.e2e.test.ts`
  - `shows a jsx page, takes what the person pointed at to the bot as records, replaces the page, and publishes it as static HTML 1407ms`

### `server/chat-widgets.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3606): `AssertionError: expected false to be true // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/chat-widgets.e2e.test.ts`
  - `shows, replaces and answers a widget on a bot's own conversation, once per press 17603ms`

### `server/checkpoints.test.ts` — 1 failed test(s)
- First detailed error (log line 3628): `AssertionError: expected '9d16310af5145c3c5ac28df878828a7f50098…' to be null`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/checkpoints.test.ts`
  - `keeps the last complete backup when a new snapshot cannot read a file 94ms`

### `server/chief-level-delegation.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3647): `AssertionError: expected undefined to be 'auto' // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/chief-level-delegation.e2e.test.ts`
  - `starts a thread a Chief opens with a teammate at the Chief's level, and a Chief on Ask raises nobody 5459ms`

### `server/chief-level-every-hop.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3666): `AssertionError: expected undefined to be 'auto' // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/chief-level-every-hop.e2e.test.ts`
  - `carries a Chief's level down every hop it hands out, in threads and in a room, and never an ordinary bot's 6744ms`

### `server/chief-rooms.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 3685): `ZodError: [`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/chief-rooms.e2e.test.ts`
  - `creates and manages an own-section room through the mounted Chief MCP proxy 3340ms`

### `server/cli-stop.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 3733): `AssertionError: expected 400 to be 200 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cli-stop.e2e.test.ts`
  - `keeps the task busy until its stubborn helper stops (root ignores TERM: false) 5738ms`
  - `keeps the task busy until its stubborn helper stops (root ignores TERM: true) 2749ms`

### `server/cloud-computer-auto-sleep.e2e.test.ts` — 9 failed test(s)
- First detailed error (log line 3752): `AssertionError: POST /api/bots/a6582d9d-eb45-4469-bacf-04425ab7b4f3/messages: {"error":"provider instance \"uses\" is unavailable — pick another model in settings"}: expected 409 to be less than 400`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-computer-auto-sleep.e2e.test.ts`
  - `a bot's computer sleeps one idle window after its turn ends, and the next turn wakes it 67ms`
  - `a turn shorter than the window on a computer already on: the window starts when the turn ends 2613ms`
  - `a person watching its live screen keeps it on; it sleeps once they stop 34773ms`
  - `a person holding its desktop keeps it on, however briefly; handing it back starts the window 40632ms`
  - `a team's shared computer sleeps only once every bot on the team is idle 2577ms`
  - `after a restart, every computer this installation left on gets the same idle window 51ms`
  - `a routine due within 30 minutes keeps its bot's computer on; paused, two hours away, or with the computer off, it does not 2ms`
  - `a teammate's routine keeps the team's shared computer on; one for a teammate whose computer is off does not 1ms`
  - `never touches a VPS: its activity starts no idle stop of any kind 2ms`

### `server/cloud-computer-lazy.e2e.test.ts` — 8 failed test(s)
- First detailed error (log line 3857): `AssertionError: POST /api/bots/3dc72930-8a64-4c65-ac6f-ad3ca1300a23/messages: {"error":"provider instance \"claude\" is unavailable — pick another model in settings"}: expected 409 to be less than 400`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-computer-lazy.e2e.test.ts`
  - `a plain chat on Cloud computer makes no relay call at all 30ms`
  - `a room message to a member on Cloud computer makes no relay call either 20084ms`
  - `the first computer call creates the cloud computer exactly once and says so in the chat 23ms`
  - `a signed-out engine fails with the existing sign-in row and no relay call 20ms`
  - `a tool selection without the computer is refused before any relay call, and select_computer does not offer it 26ms`
  - `select_computer counts the cloud computer this turn mounted as chosen before it starts: no restart, no pin 23ms`
  - `a room member whose cloud computer can't start says why in the room, once, under its own name 20049ms`
  - `a cloud routine whose computer can't start records that cause on its run 71ms`

### `server/cloud-computer-slow-start.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 3987): `AssertionError: POST /api/bots/d8c10d37-1989-4c7e-8cfa-afff73991735/messages: {"error":"provider instance \"claude\" is unavailable — pick another model in settings"}: expected 409 to be less than 400`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-computer-slow-start.e2e.test.ts`
  - `a call that outwaits its share is told the computer is still starting; a later call works, one create 64ms`
  - `a call that cannot reach the relay is told to try again, and a later call in the same turn claims the computer 41ms`
  - `while another conversation has the computer, a call says so, not that it is starting 26ms`
  - `a start that stalls ends at the start budget with one row that says it didn't start, and the turn ends 22ms`

### `server/cloud-credit.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 4043): `TypeError: Cannot read properties of undefined (reading 'snapshot')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-credit.e2e.test.ts`
  - `is a read-only engine on the relay's models, Sonnet first, and the first bot runs on Sonnet while the person has no AI of their own 36ms`
  - `a bot left on an engine this Cloud can't run, as a desktop copy leaves it, answers on the credit from its first message 12ms`
  - `once the person's own Claude can run, it takes over every bot, a copied one back on its own model, and the credit is not an engine for bots any more 15032ms`
  - `signed out again, a bot's next message runs on the credit; used up, that chat says so once in plain words, and nothing more is sent 8ms`

### `server/cloud-lending-chrome.e2e.test.ts` — 3 failed test(s)
- First detailed error (log line 4118): `AssertionError: {"error":"provider instance \"claude\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-lending-chrome.e2e.test.ts`
  - `a Cloud bot's My Chrome browser reaches the person's Chrome through the lent computer 37ms`
  - `a conversation someone else wrote in cannot reach the person's Chrome 15071ms`
  - `a computer that stops lending Chrome takes the route with it 1ms`

### `server/cloud-lending-memory.e2e.test.ts` — 28 failed test(s)
- First detailed error (log line 4172): `AssertionError: {"error":"provider instance \"held\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-lending-memory.e2e.test.ts`
  - `a turn in a conversation a guest left behind cannot write a bot's memory with its tools; the owner's own can 2426ms`
  - `a turn in a conversation a guest left behind writing MEMORY.md directly takes the bot out of lending until the owner reviews exactly what changed 2350ms`
  - `the owner's own room turn writing the bot's memory directly keeps the Mac in reach, as their own conversation does 15099ms`
  - `a turn in a room someone else opened writing the bot's memory directly takes the bot out of lending too 17314ms`
  - `the owner's own turns writing memory directly keep the Mac in reach, also after a turn in a conversation a guest left behind that changed nothing 2400ms`
  - `recall and the recent-work brief never bring a conversation a guest left behind into the owner's turn 2416ms`
  - `what the owner's own turn wrote before a turn in a conversation a guest left behind starts stays theirs 2473ms`
  - `a process on the Cloud cannot write in the owner's running conversation, and a teammate's question never lands in it 66ms`
  - `a link planted in a bot's memory is a change, and what it points at never reaches a turn 2378ms`
  - `the owner's own Memory edits are theirs, even while a turn in a conversation a guest left behind runs 2351ms`
  - `a turn that may use the Mac finds only the owner's own conversations with the session tools 2430ms`
  - `only the owner changes how a bot asks for approval in a conversation a guest left behind, not a process on the Cloud 2620ms`
  - `a conversation a guest left behind is never the owner's, whoever writes in it: its name reaches neither their other turns nor the bot's memory 2335ms`
  - `the owner's turn in a conversation a guest left behind cannot use the Mac 2310ms`
  - `only the owner changes what a bot is told about itself, not a process on the Cloud 62ms`
  - `instruction files planted in a bot's working folders are a change too 2418ms`
  - `a record that cannot be saved does not stop a turn in a conversation a guest left behind, and its change is still caught 2451ms`
  - `a deleted bot's record goes with it, and nothing recreates its workspace 2300ms`
  - `what the owner wrote stays the owner's when a device of theirs is paired again or revoked 64ms`
  - `a provider reload judges a running turn in a conversation a guest left behind as it tears it down 2395ms`
  - `a routine a guest left behind reports into a conversation of its own, and its reports are never the owner's words 2416ms`
  - `an outside event's runs all report into one conversation of their own, never into the owner's chats 20107ms`
  - `a conversation a guest left behind works in its own folder: what is written there flags nothing, even in the bot's project 2339ms`
  - `a conversation a guest left behind runs in Ask whatever the bot's own level; the owner's own keeps it 2440ms`
  - `the results conversation of a routine a guest left behind never reaches the owner's turns; the owner's own routine's does 2432ms`
  - `an owner's routine reports into the conversation the owner last wrote in, never one a guest left behind 49ms`
  - `no command the owner saved answers for a conversation a guest left behind: it still asks the owner 2511ms`
  - `a conversation a guest left behind keeps its private folder when the owner gives the bot a working folder; the owner's own moves there 2520ms`

### `server/cloud-onepassword.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 4769): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-onepassword.e2e.test.ts`
  - `a bot asks for the 1Password token through request_credential's own slot, and the card's save through Logins counts 45ms`

### `server/cloud-routine-level.e2e.test.ts` — 7 failed test(s)
- First detailed error (log line 4790): `AssertionError: expected false to be true // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-routine-level.e2e.test.ts`
  - `on a Cloud only its owner ever used, a routine with nobody's writer or none, and a nobody's conversation, run at the bot's own level 17482ms`
  - `keeps a routine a webhook's run made confined even there, and says why 15055ms`
  - `a Full access bot's routine from the owner's chat runs at Full access after the bot authored a skill there, on Claude and Codex 27ms`
  - `keeps the conversation's level when an old report means the chat can't be proven the owner's alone, without proving the routine for lending 15028ms`
  - `gives the owner back a routine their bot made in their chat that an earlier version left nobody's; a guest's still runs confined and says why 17ms`
  - `in a conversation a guest left behind, a Chief's new specialist waits for the owner's card, and the owner's answer continues the Chief once 2381ms`
  - `in a conversation a guest left behind, the watchdog stopping the Chief's turn closes its setup card, and approving it afterwards adds nothing 4664ms`

### `server/cloud-send-kinds.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 4940): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-send-kinds.e2e.test.ts`
  - `a move carries the automations, files, memory, fields and skills, and its check finds all of it there 94ms`
  - `a move run again changes nothing on My Cloud, and its check still finds everything there 228ms`

### `server/cloud-send-move.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 4994): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-send-move.e2e.test.ts`
  - `lines My Cloud already held of this computer's become its owner's when the move names them, at once for what its bots recall 48ms`
  - `a move carries everything, apps and keys first, and its check finds every row, path, attachment and credential there 28ms`
  - `a moved conversation may use the lent Mac and feeds its bot's memory on My Cloud 72ms`
  - `lines the owner wrote on this computer arrive as the same owner as the lines they write on My Cloud 3ms`

### `server/cloud-send-routine-merge.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 5059): `AssertionError: expected +0 to be 1 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-send-routine-merge.e2e.test.ts`
  - `a routine changed on both sides is one routine with the definition changed last and both sides' runs; the check passes, and runs made here later never undo My Cloud's 60235ms`

### `server/cloud-send-store.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 5083): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-send-store.e2e.test.ts`
  - `a full attachment store refuses the attachment in plain words, the chat still goes, and no partial file is left 84ms`

### `server/cloud-send.e2e.test.ts` — 3 failed test(s)
- First detailed error (log line 5103): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-send.e2e.test.ts`
  - `a new bot's conversation of three pages and more arrives whole with the move 46ms`
  - `a later pass of two pages and more goes on from the earlier one 39ms`
  - `a context summary that ends a pass reaches My Cloud, and what follows it in the next pass shows after it 14ms`

### `server/cloud-sharing.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 5163): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-sharing.e2e.test.ts`
  - `keeps what the owner made alone at the bot's level once a second person has used the Cloud, confines what that person's conversation made, and stays shared 4556ms`

### `server/cloud-sync.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 5183): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-sync.e2e.test.ts`
  - `a bot's turn wakes the desktop, and its new work comes down to Documents/RootClaw/<bot>/<conversation> 66ms`

### `server/cloud-sync.test.ts` — 1 failed test(s)
- First detailed error (log line 5202): `AssertionError: expected 200 to be 503 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-sync.test.ts`
  - `answers 503 for a folder part or a file it cannot read, rather than leaving it out of the listing 24ms`

### `server/cloud-team-admin.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 5221): `AssertionError: expected undefined to be true // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-team-admin.e2e.test.ts`
  - `the Admin reads a Team Cloud's shared connections and AI by a signed request, with no key, header value or MCP address in the answer 20190ms`

### `server/cloud-team-browser.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 5243): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-team-browser.e2e.test.ts`
  - `drives each member's private chat, the group chat and the team's chat on browsers of their own, and opens a view on the conversation's 22ms`

### `server/cloud-team-connections.e2e.test.ts` — 8 failed test(s)
- First detailed error (log line 5263): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-team-connections.e2e.test.ts`
  - `keeps every connection the team's until an admin says otherwise 24ms`
  - `gives Ada's own Gmail and mail to her private chat, for her own request, and runs as her 6ms`
  - `never uses her own Gmail or mail where others read, even for her own line in a group chat, nor in anyone else's turn 60041ms`
  - `gives work her own message hands to another bot her own Gmail, and never work Cleo's message hands on 17ms`
  - `runs work her group-chat line hands on in the receiving bot's chat with her, and the room gets only where the result is 60019ms`
  - `tells the bot one plain line with the link when a person's app isn't connected, never a card 9ms`
  - `signs Cleo in to a notes server of her own, and only her chat gets her token 63ms`
  - `disconnects her own, and switching back to the team gives every turn the team's again 10ms`

### `server/cloud-team-engine-homes.e2e.test.ts` — 7 failed test(s)
- First detailed error (log line 5431): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-team-engine-homes.e2e.test.ts`
  - `each person's private chat runs in their own engine home, signed in with the team's sign-in, and the team's in the team's 40ms`
  - `a shell in the Owner's chat, or an Admin's, lists and reads none of Bob's transcripts 14ms`
  - `Bob's conversation resumes from his own home 6ms`
  - `a sign-in refreshed in Bob's chat becomes the team's and every other chat's 8ms`
  - `a Team Cloud that kept transcripts in its HOME moves each one to its conversation's home on its next start 1ms`
  - `a member who leaves takes their engine home with them 1ms`
  - `My Cloud is unchanged: its engine runs in the server's HOME and keeps its transcripts there 48ms`

### `server/cloud-team-gateway-mcp.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 5561): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-team-gateway-mcp.e2e.test.ts`
  - `lets a member's turn list and call the gateway's tool, with both values sent only to the gateway 27ms`
  - `keeps a one-key server Only for me: the admin's own chat gets it with their key, a member's chat doesn't 96ms`

### `server/cloud-team-one-answer.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 5601): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-team-one-answer.e2e.test.ts`
  - `answers the same question from two of Bob's teammates once, and Olive's, which Bob's answer may not reach, on its own 29ms`

### `server/cloud-team-open-reach.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 5620): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-team-open-reach.e2e.test.ts`
  - `lets Scout, in Bob's private chat, ask Bolt in another department and brings Bolt's answer back 23ms`
  - `keeps Bob's Chief supervising only Bob's bots, while it can reach Bolt too 7ms`
  - `never carries Bob's private chat into a room, by a hand-off or a post 6ms`
  - `takes an @ that a teammate and a bot share as the teammate's: the bot hears its name is a person's, and is not named to Scout 22ms`

### `server/cloud-team-owners.e2e.test.ts` — 5 failed test(s)
- First detailed error (log line 5696): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-team-owners.e2e.test.ts`
  - `puts a question in a shared chat in its owner's Needs you and notifications, nobody else's 522ms`
  - `follows a bot's own Reports to over its department's, and routes an approval the same way 8ms`
  - `lets the member who owns a bot hand it over, and nobody else but an Admin 13ms`
  - `gives each person a Chief of Staff of their own whose team is the bots that report to them, while it can reach every bot 46ms`
  - `keeps a member's private chat theirs: its asks reach only them, never the bot's owner, an Admin, or the owner's inbox 14ms`

### `server/cloud-team-people.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 5788): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-team-people.e2e.test.ts`
  - `lists the team's people for the @ menu and mounts message_person on a team's turns 25ms`

### `server/cloud-team-preference.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 5803): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-team-preference.e2e.test.ts`
  - `saves a preference once in Bob's About me, from his own chat and from work his message handed on, for every bot to read 23ms`

### `server/cloud-team-profile.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 5822): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-team-profile.e2e.test.ts`
  - `names Bob, not the owner, in his private chat's system prompt, with his About you only 2423ms`
  - `puts each speaker's own name on a group chat's lines, for the people and for the bot 60056ms`

### `server/cloud-team-setup-request.e2e.test.ts` — 3 failed test(s)
- First detailed error (log line 5866): `AssertionError: expected 409 to be 200 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/cloud-team-setup-request.e2e.test.ts`
  - `in the team's shared main chat, only the person who pressed Set me up sets the bot up, and only they can stop it 46ms`
  - `refuses another person's press while a member's request waits, and the owner can clear it 33ms`
  - `drops a member's request when she leaves the team 15ms`

### `server/cloud-team.e2e.test.ts` — 7 failed test(s)
- First detailed error (log line 5923): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/cloud-team.e2e.test.ts`
  - `a member's private chat with a team bot reads her notes and the team's, never another member's; she alone sees it 78ms`
  - `a room's turn reads the room's layer and the team's, never a member's notes, and both members see its answer 60109ms`
  - `a room's bot reply is unread for each person until they read it, and one person reading clears it for nobody else 4ms`
  - `recall never crosses: a room's fact never surfaces in a private chat and a private chat's never in the room 89ms`
  - `a member's upload is hers alone; a team file is everyone's; About you is per person 17ms`
  - `a person's own connected apps cannot be brought into the team, and the team's connection serves any member's turn 87ms`
  - `a member's private chat keeps its own folder when the team's bot is given a working folder; the Owner's own thread moves there 25ms`

### `server/computer-engine-removal.e2e.test.ts` — 3 failed test(s)
- First detailed error (log line 6040): `TypeError: Cannot read properties of undefined (reading 'models')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/computer-engine-removal.e2e.test.ts`
  - `moves bots off it once, keeps each conversation where it worked, and never hands a turn to Boat's own agent 4661ms`
  - `moves a bot later, as soon as an engine is there to move it to 4590ms`
  - `keeps serving when the move fails at start, and moves the bots on a later try 19458ms`

### `server/connected-app-tools.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 6087): `TypeError: bridge.args is not iterable`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/connected-app-tools.e2e.test.ts`
  - `a bot given Gmail by its app switch reaches gmail.search_emails by name on Claude and on an ACP engine alike 3379ms`

### `server/context-compaction.e2e.test.ts` — 6 failed test(s)
- First detailed error (log line 6100): `TypeError: Cannot read properties of undefined (reading 'content')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/context-compaction.e2e.test.ts`
  - `automatically folds old exchanges while keeping the two latest and the incoming request 6078ms`
  - `Stop cancels a stalled summary without writing a late record or starting an agent 4643ms`
  - `respects the selected account's native compaction setting (undefined) 5934ms`
  - `respects the selected account's native compaction setting ('100000') 2291ms`
  - `respects the selected account's native compaction setting ('off') 2441ms`
  - `respects the selected account's native compaction setting ('auto') 2284ms`

### `server/create-bot-model.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 6178): `TypeError: Cannot read properties of undefined (reading 'models')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/create-bot-model.e2e.test.ts`
  - `Chief creation uses the workspace default or a validated explicit model without inheriting permissions 2469ms`

### `server/data/data.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 13739): `TypeError: Cannot read properties of undefined (reading 'content')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/data/data.e2e.test.ts`
  - `loads, queries, shows, pages, renders and exports through the real server 5982ms`

### `server/decider-included.e2e.test.ts` — 5 failed test(s)
- First detailed error (log line 6190): `TypeError: Cannot read properties of undefined (reading 'id')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/decider-included.e2e.test.ts`
  - `works with no key: Settings sees it included and on, and a new room starts on Auto 74ms`
  - `asks the relay who answers, at exactly <ROOTCLAW_CLOUD_DECIDER_URL>/v1/systemone with the included token 1ms`
  - `an own key wins and goes only to Jev; clearing it falls back to the included decisions 29ms`
  - `an explicit off wins: no call, the room's lead answers, new rooms keep a lead 38ms`
  - `never sends a credential to the other side, nor the relay a request it refuses, and never saves, logs or hands on the included token 2ms`

### `server/decider-rooms.e2e.test.ts` — 11 failed test(s)
- First detailed error (log line 6275): `TypeError: Cannot read properties of undefined (reading 'id')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/decider-rooms.e2e.test.ts`
  - `reports only booleans in the config, and new rooms default to Auto 72ms`
  - `a confident pick answers alone, and the send does not wait for the decision 1ms`
  - `__everyone__ sends it to every member, each reply marked 1ms`
  - `an unsure answer falls back to the room's lead (its first member), unmarked 1ms`
  - `a failing decision model falls back too 1ms`
  - `an @mention bypasses the decision model 1ms`
  - `a lead-mode room never asks 1ms`
  - `engines never see the key; the decision log holds no text and no key 4ms`
  - `a confident pick answers alone, stamped with the provider; the log has the model and no text 1ms`
  - `a failing OpenRouter (out of credits) falls back to the lead, unmarked 0ms`
  - `engines never see the OpenRouter decision key 1ms`

### `server/default-bot.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 6414): `TypeError: Cannot read properties of undefined (reading 'ROOTCLAW_CHIEF_OF_STAFF')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/default-bot.e2e.test.ts`
  - `makes RootClaw a new install's first bot, never deleted, hidden by its switch, with a Chief's tools after the Chief moves on 3415ms`
  - `lets RootClaw read the unread notifications and mark finished work read, and gives no other bot the tools 3529ms`

### `server/desktop-computer.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 6438): `AssertionError: POST /api/bots/d548682c-74f0-44ec-8a5f-9fa76c97a0d0/messages: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be less than 400`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/desktop-computer.e2e.test.ts`
  - `a server the app did not launch mounts no computer on Auto, though the app's record is on disk 2221ms`
  - `a server the app did not launch refuses this computer even when the person picks it, in plain words 2226ms`

### `server/desktop-updates.e2e.test.ts` — 6 failed test(s)
- First detailed error (log line 6464): `AssertionError: POST /api/bots/32a1749e-80d1-4d1f-b208-3784217402e6/messages: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be less than 400`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/desktop-updates.e2e.test.ts`
  - `gives an Auto chat no computer and a plain note, updates the desktop by itself keeping sign-ins, then uses it 2535ms`
  - `holds a turn whose place is the Local VM until its desktop is updated, then gives it that desktop 2307ms`
  - `runs an unattended routine on the updated desktop instead of this computer 22423ms`
  - `keeps the old desktop, and keeps the bot off this computer, when its sign-ins cannot be copied 2298ms`
  - `never lands an Auto chat on this computer while its desktop on 'the default VPS' runs an older version 3681ms`
  - `never lands an Auto chat on this computer while its desktop on 'its own VPS' runs an older version 2573ms`

### `server/devs-reports.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 6554): `Error: timed out waiting`
- Preliminary cluster: **Timeout/wait** — independent or downstream cause not yet established.
- Reproduction: `pnpm exec vitest run server/devs-reports.e2e.test.ts`
  - `sends one report with the bot's report_bug summary and the facts, redacted, and the person sees where it went 60150ms`
  - `still sends the report, with the server's facts, when the bot never calls report_bug, and only once 60124ms`

### `server/digest-control.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 6582): `AssertionError: expected 'failed' to be 'settled' // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/digest-control.e2e.test.ts`
  - `records independent turns and room speakers through the shared control fixture 3598ms`

### `server/direct-coordination.e2e.test.ts` — 25 failed test(s)
- First detailed error (log line 6598): `AssertionError: expected 'failed' to be 'settled' // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/direct-coordination.e2e.test.ts`
  - `starts independent work immediately and frees the Chief while waiting (source fails: true) 5035ms`
  - `coordinates a lead and its specialist from ordinary chat, returns to Clive, and leaves unrelated tasks untouched 7287ms`
  - `keeps a guarded Chief request exact through coordination and failed resume 18243ms`
  - `opens a fresh thread on a teammate with coordinate_bots thread "new" and gets the result back 5273ms`
  - `lets the opener find and close the completed task 8107ms`
  - `does not treat self-opened work or an abandoned human branch as new human authority 4506ms`
  - `returns a nested coordinated result after Claude retries a transient provider exit 9093ms`
  - `returns nested results after Claude rejects the source's prior resume cursor 8142ms`
  - `uses recipient bot defaults for its new task, never the sender's or its selected old thread's settings 2455ms`
  - `continues one recipient thread for every follow-up from the same conversation 10492ms`
  - `on a headless server, hands a follow-up sent while the teammate still works to its running turn, and one result comes back 4871ms`
  - `on the desktop app, hands a follow-up sent while the teammate still works to its running turn, and one result comes back 4862ms`
  - `runs an identical call made twice in one turn once, without an extra recipient thread 7400ms`
  - `runs an identical brief again only with rework=true once its first run finished 8092ms`
  - `runs an identical brief again only with rework=true once its first run failed 21468ms`
  - `dispatches to a spare recipient thread without waiting for unrelated work 12597ms`
  - `runs a message sent while a teammate works, keeps the assignment, and names it in that turn 4651ms`
  - `withholds direct results when the sender's peers list cuts the teammate off mid-turn 5691ms`
  - `retains returned direct reports for follow-up turns but rechecks reach before replay 7217ms`
  - `sends each teammate result once in the turn that reviews it 7006ms`
  - `gives a teammate each request once, never also as a bare assistant line 7744ms`
  - `continues a teammate's step cap in place and stops it once it makes no progress 3772ms`
  - `tells the Chief a teammate's provider refused the turn, in the provider's words 18464ms`
  - `keeps a teammate working through a provider settings save that does not touch its engine 3717ms`
  - `tells the Chief a teammate's turn stopped because its engine's settings changed 33823ms`

### `server/drivers/workspace-tools.test.ts` — 1 failed test(s)
- First detailed error (log line 13752): `AssertionError: expected false to be true // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/drivers/workspace-tools.test.ts`
  - `tracks background commands per conversation and stops their whole process groups 5068ms`

### `server/engine-status-reads.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 7101): `AssertionError: expected +0 to be 1 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/engine-status-reads.e2e.test.ts`
  - `probes the engine's CLI once on a later start while the model lists arrive and the engine list is read 14360ms`
  - `probes again after a sign-out, a model refresh, a saved key and a Claude update, and reuses the last read otherwise 2182ms`

### `server/escalations.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 7136): `AssertionError: PATCH /api/instances/claude: {"error":"Supply a valid name, boolean tools setting or a reply wait of 1 to 60 minutes."}: expected 400 to be 200 // Object.is equality`
- Preliminary cluster: **Retired instance API/schema expectation** — confirmed in the escalations reproduction; do not generalize without checking each test.
- Reproduction: `pnpm exec vitest run server/escalations.e2e.test.ts`
  - `delivers a pending peer-comm approval card to the Chief's escalations thread 2412ms`
  - `delivers a teammate turn that ends needing input to the Chief's escalations thread 2480ms`
  - `carries the provenance fence header on a bot-raised escalation 2508ms`
  - `routes a Chief's own gate to the person, never a dead end 2324ms`

### `server/external-runtime-busy.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 7220): `AssertionError: expected 'Fixture reply: [/LIVE TEAMMATES]' to contain 'Only this queued request: already busy'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/external-runtime-busy.e2e.test.ts`
  - `queues an idle external caller's ask behind a peer that is already busy, without losing or repeating approval 4065ms`
  - `queues an idle external caller's ask behind a peer that is became busy during approval, without losing or repeating approval 4017ms`

### `server/external-runtime-timeout.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 7252): `AssertionError: expected 'Fixture reply: [/LIVE TEAMMATES]' to contain 'Only this long question.'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/external-runtime-timeout.e2e.test.ts`
  - `answers an external caller's long ask at once and lets it poll the slow peer's answer without waking its engine 3403ms`

### `server/external-runtime.e2e.test.ts` — 5 failed test(s)
- First detailed error (log line 7268): `TypeError: Cannot read properties of undefined (reading 'id')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/external-runtime.e2e.test.ts`
  - `gets a standing agents capability for its pinned thread from external-runtimes.json 32ms`
  - `revokes slow ask and delegate requests without starting the peer 21ms`
  - `pins a configured thread across sidebar selection and refuses deleted bindings 7ms`
  - `hands work on as outside content, never as the person's request 7ms`
  - `uses the documented MCP bridge to delegate and poll in the same long-running process 5ms`

### `server/first-hour.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 7328): `AssertionError: POST /api/bots/722a0af9-48d3-4d94-852d-4fbdaad45d4e/messages: {"error":"provider instance \"\" is unavailable — pick another model in settings"}`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/first-hour.e2e.test.ts`
  - `after the first answer, offers Gmail and Google Calendar with the reason, and tells the Chief not to ask itself 32ms`
  - `the moment Gmail is in, delivers a first look whose replies are drafts, and nothing is sent or deleted 4ms`
  - `keeps the brief on from the start, at 8:00 in the person's zone: a sleeping Cloud wakes for it 6ms`
  - `reports each milestone's time and what the Chief really did to the Admin, as times and counts only 7ms`

### `server/folder-pages.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 7412): `TypeError: Cannot read properties of undefined (reading '0')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/folder-pages.e2e.test.ts`
  - `shows a dashboard folder inline, serves its Parquet to the frame by token only, keeps other bots out, and gives the card its link on publish 1210ms`

### `server/full-access-workflows.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 7426): `AssertionError: expected +0 to be 1 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/full-access-workflows.e2e.test.ts`
  - `applies requested Full Access workflows through MCP without duplicate approvals, and the same changes apply in an Ask task with Undo 29847ms`

### `server/group-goal-run-one-on-one.e2e.test.ts` — 7 failed test(s)
- First detailed error (log line 7450): `TypeError: Cannot read properties of undefined (reading 'id')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/group-goal-run-one-on-one.e2e.test.ts`
  - `works in its own chat until the bot reports the goal done, and the marker never shows 22ms`
  - `Stop ends the goal on its card and no turn starts after the interrupted one 9ms`
  - `waits for the chat's current turn without spending a goal turn, then runs on the same card 9ms`
  - `stops at the same turn cap as a room goal 4ms`
  - `never treats a failed turn as done: it is retried once, then the goal fails 6ms`
  - `a routine runs a goal in the bot's own chat when it names no room 6ms`
  - `refuses a mode it does not know 13ms`

### `server/group-goal-run.e2e.test.ts` — 11 failed test(s)
- First detailed error (log line 7538): `TypeError: Cannot read properties of undefined (reading 'id')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/group-goal-run.e2e.test.ts`
  - `returns to the lead until the goal is completed and appends a clean receipt 43ms`
  - `waits for a busy coordinator without spending a goal turn, then completes on the same card 12ms`
  - `waits for a busy delegated worker, preserves its direct turn, then resumes the goal 14ms`
  - `stops a waiting goal without interrupting unrelated direct work, and chat waits for busy bots the same way 12ms`
  - `stops a detached scheduled goal from the active room and cancels its routine run 24ms`
  - `stops a detached scheduled goal from the coordinator's ordinary Stop 5ms`
  - `stops the coordinator's direct turn without cancelling a routine goal waiting on its worker 10ms`
  - `runs a routine as a goal in a new background room task 3ms`
  - `pauses a non-converging team at the hard turn limit 4ms`
  - `never treats a failed provider turn as a completed goal 5ms`
  - `automatically dispatches channel messages queued during a running turn 2ms`

### `server/group-goal-wait-cap.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 7670): `TypeError: Cannot read properties of undefined (reading 'id')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/group-goal-wait-cap.e2e.test.ts`
  - `reassigns through the lead when a worker stays busy past the cap, and still completes 36ms`
  - `ends blocked, not failed, when the lead itself stays busy past the cap 11ms`
  - `retries a lead whose provider dies exactly once before the run fails 7ms`
  - `chat: a responder that stays busy past the cap is skipped with the bounded truth, and the next responder still runs 33ms`

### `server/group-local-vm.e2e.test.ts` — 43 failed test(s)
- First detailed error (log line 7718): `AssertionError: POST /api/bots/bfe848f2-ecd9-40a1-ab37-09732d847f65/messages: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected false to be true // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/group-local-vm.e2e.test.ts`
  - `resumes an existing per-bot VM even at the instance cap 83ms`
  - `cleans the remaining rooms after one cleanup operation fails 15117ms`
  - `removes an interrupted fixture room before another room takes the shared desktop 15087ms`
  - `provisions concurrent cold pool seats (existing per-bot desktops: false) 2314ms`
  - `provisions concurrent cold pool seats (existing per-bot desktops: true) 2613ms`
  - `recovers only previously provisioned Auto VMs after idle removal and server restart, within the instance cap 4727ms`
  - `executes and attaches only for the current VM owner, respecting takeover and expiry 15207ms`
  - `claims an Auto VM on its first shell command without needing a screenshot 45ms`
  - `does not stall an admitted turn waiting for another turn's shared computer 209ms`
  - `chat selection starts or provisions a configured cloud computer (wake) only after selecting it 81ms`
  - `chat selection starts or provisions a configured cloud computer (removed) only after selecting it 81ms`
  - `chat selection starts or provisions a configured cloud computer (missing-auto) only after selecting it 116ms`
  - `lets a chat tool select Auto, replaces tools after completion, and continues the same user message once 78ms`
  - `does not continue a computer selection after stop 43ms`
  - `does not continue a computer selection after failure 33ms`
  - `does not continue a computer selection after off 41ms`
  - `does not continue a computer selection after manual-selection 36ms`
  - `does not continue a computer selection after new-request 37ms`
  - `runs successive direct tasks on their pinned Local VM despite a Cloud profile default 62ms`
  - `recovers a direct shared VM after a missing completion 44ms`
  - `recovers a direct per-bot VM after a missing completion 63ms`
  - `keeps a replacement shared VM turn after a late completion (new task: false) 43ms`
  - `keeps a replacement shared VM turn after a late completion (new task: true) 40ms`
  - `keeps a replacement per-bot VM turn after a late completion (new task: false) 57ms`
  - `keeps a replacement per-bot VM turn after a late completion (new task: true) 54ms`
  - `says why This computer cannot mount in a channel instead of dispatching without the promised tools 15103ms`
  - `runs a channel speaker's own Cloud destination on its own engine with its Boat, waking it first 15141ms`
  - `releases a failed readiness claim so the bot and room can run again 15109ms`
  - `does not dispatch after Stop during readiness and releases the old lease 15097ms`
  - `does not dispatch after a stall during delayed room setup and the room can run again 15087ms`
  - `says which limit stopped a rerun room turn that stalled during delayed room setup 15081ms`
  - `says which limit stopped a room turn that stalled during VM readiness, though setup ends before the turn has an outcome 15076ms`
  - `revokes the previous member and rejects cross-bot control after a shared desktop handoff 15103ms`
  - `denies computer access when an otherwise active speaker's lease expires 15112ms`
  - `never trips the lazy first-screen-call claim on an eagerly claimed turn 15104ms`
  - `parks an eager Auto VM wait and resumes with its computer after the holder stops 4811ms`
  - `runs a screen-less Auto turn to completion while another thread holds the Local VM (issue #1361 AC1) 195ms`
  - `claims a lazily attached Auto VM on the first screen call and proceeds on release (issue #1361 AC2) 73ms`
  - `ends the turn with a terminal error after a rejected lazy claim (issues #1361 F1, #1369) 63ms`
  - `lets an uncontended first screen call through with an honest answer (issue #1361 AC3) 43ms`
  - `releases everything a rejected lazy claim took, so the next turn gets the VM (issue #1361 F2) 74ms`
  - `releases timeout bookkeeping after the interrupt grace period 15110ms`
  - `releases stall bookkeeping after the interrupt grace period 15091ms`

### `server/handoff-in-my-folder.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 8735): `AssertionError: expected +0 to be 1 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/handoff-in-my-folder.e2e.test.ts`
  - `starts a teammate's thread in the delegating bot's project folder by default, and refuses an explicit in_my_folder when there is none 42913ms`

### `server/headless-cli.e2e.test.ts` — 3 failed test(s)
- First detailed error (log line 8757): `TypeError: Cannot read properties of undefined (reading 'models')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/headless-cli.e2e.test.ts`
  - `rehearses a launch with a Chief and two teammates and exports what they made 1010ms`
  - `exports the team as a file that applies back unchanged, then renames and prunes from a second file 513ms`
  - `stops a job whose teammate hangs when its time runs out, the teammate included 1ms`

### `server/hosted-desktop.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 8800): `TypeError: Cannot read properties of undefined (reading 'indexOf')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/hosted-desktop.e2e.test.ts`
  - `keeps the bot's own engine on the cloud computer, and a failed place never breaks the bot 4494ms`

### `server/incidents.e2e.test.ts` — 10 failed test(s)
- First detailed error (log line 8813): `AssertionError: PATCH /api/instances/claude: {"error":"Supply a valid name, boolean tools setting or a reply wait of 1 to 60 minutes."}: expected 400 to be 200 // Object.is equality`
- Preliminary cluster: **Retired instance API/schema expectation** — confirmed in the escalations reproduction; do not generalize without checking each test.
- Reproduction: `pnpm exec vitest run server/incidents.e2e.test.ts`
  - `reports a crashed run to the Chief, who retries it from the incidents thread 2396ms`
  - `files a failed run's incident only once its thread has settled, so the Chief's retry is accepted straight away 2296ms`
  - `queues reports that find the Chief's incidents thread busy, answers them together, and runs each without a computer it cannot have 2343ms`
  - `reviews the work it handed on from a report without the Chief's computer, even after the person wrote there 2336ms`
  - `keeps the team computer for a report turn, and answers without it once it is missing 2484ms`
  - `adds no push for answering reports that waited, about failures the person already heard of 2451ms`
  - `keeps a report that waited quiet through the work it hands on, when the person already heard of the failure 2493ms`
  - `never parks a report behind work the Chief handed on, even for a Chief that parks its follow-ups 2330ms`
  - `tells the person of a failure whose report waited and was then refused 2344ms`
  - `reports a routine that keeps failing the same way once, and again when the failure changes 2299ms`

### `server/late-question-source.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9023): `AssertionError: expected undefined to deeply equal Any<String>`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/late-question-source.e2e.test.ts`
  - `does not retarget a deleted room asker's late answer to the current speaker 7926ms`

### `server/late-question-today.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9045): `AssertionError: expected undefined to deeply equal Any<String>`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/late-question-today.e2e.test.ts`
  - `keeps a question nobody answered on Today after its turn ends, and a late answer wakes the bot and clears it 8490ms`

### `server/lent-folders.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9067): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/lent-folders.e2e.test.ts`
  - `a lent folder keeps working while the Mac is away: read from the copy, changes saved and applied when it's back, both kept on a conflict 271ms`

### `server/limit-reset.e2e.test.ts` — 10 failed test(s)
- First detailed error (log line 9087): `TypeError: Cannot read properties of undefined (reading 'environment')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/limit-reset.e2e.test.ts`
  - `with no other AI to carry on, the stopped turn's Continue sets up a run that continues the conversation once the limit resets 2454ms`
  - `continues on the backup engine with one line, and goes back to its own engine after the reset 2385ms`
  - `never moves to another sign-in of the same engine; the stopped turn offers Continue instead 2242ms`
  - `a model out of extra-usage credits moves its turns to the backup for a while, but never holds the engine's other models 2438ms`
  - `a turn that works on the engine afterwards ends a refusal's hold long before its reset 2537ms`
  - `with nothing set up for it, carries the person's request on with another AI they have, says so once, and goes back after the reset 2399ms`
  - `after a restart, a new conversation still starts on the AI that carries on, and the limited Claude is not asked again 2404ms`
  - `a signed-out Claude with Automatic recovery on: its turns go to the chosen backup, and the way to sign in is said once 2257ms`
  - `a signed-out Claude with nothing to carry on: every refused turn fails, but the way to sign in is said once (as its turns end) 2394ms`
  - `a signed-out Claude with nothing to carry on: every refused turn fails, but the way to sign in is said once (as Automatic recovery stops its turns before they start, with no other AI to take them) 2388ms`

### `server/local-computer-proxy.test.ts` — 1 failed test(s)
- First detailed error (log line 9205): `Error: Test timed out in 20000ms.`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/local-computer-proxy.test.ts`
  - `electron: keeps discovery lease-free, refuses contention and outages, and drains the final gated frame 48677ms`

### `server/long-running-chief.e2e.test.ts` — 8 failed test(s)
- First detailed error (log line 9218): `AssertionError: expected +0 to be 1 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/long-running-chief.e2e.test.ts`
  - `carries a consult-and-implement job over several teammate turns, through a step cap, to one final answer 92691ms`
  - `tells the Chief what happened to each approval: allowed, denied, or never answered and not run 22553ms`
  - `wakes the Chief after a restart cuts its teammates mid-job, and it reports (SIGTERM) 22590ms`
  - `wakes the Chief after a restart cuts its teammates mid-job, and it reports (SIGKILL) 22604ms`
  - `keeps a job running through a provider settings save that changes nothing 22566ms`
  - `tells the Chief a teammate's turn stalled, in the watchdog's words 22558ms`
  - `lets a card hold only its own job: other jobs run beside it, or say once whose card they wait behind 22591ms`
  - `tells a teammate the person's job is its task, and a routine's handoff is not the person's request 22637ms`

### `server/loop-guard.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9389): `Error: no matching frame within 90000ms; saw: hello, bot, message, bot, bot, message, bot, message.patch, bot, bot, bot, bot, runtime, runtime, ping, message, ping, ping, ping, ping, ping`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/loop-guard.e2e.test.ts`
  - `leaves a stuck turn alone when off; on, tells it at 5 in a row and stops it only with a stop count set 92561ms`

### `server/mcp-gate-config.test.ts` — 1 failed test(s)
- First detailed error (log line 9401): `AssertionError: expected [ 'ELECTRON_RUN_AS_NODE', …(3) ] to deeply equal [ 'ELECTRON_RUN_AS_NODE', …(1) ]`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/mcp-gate-config.test.ts`
  - `keeps a shared environment's settings in one private record 7ms`

### `server/mcp-own-servers.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9424): `TypeError: Cannot read properties of undefined (reading 'ROOTCLAW_COMMS_TOKEN')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/mcp-own-servers.e2e.test.ts`
  - `a bot's server from a conversation folder is kept in its own folder, and a server that doesn't start rides along on no bot's turns 4016ms`

### `server/mcp-remote-proxy.test.ts` — 1 failed test(s)
- First detailed error (log line 9436): `AssertionError: expected [ 'NO_PROXY', 'no_proxy', …(1) ] to deeply equal [ Array(1) ]`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/mcp-remote-proxy.test.ts`
  - `reads its settings from a private record when mounts share one environment 10ms`

### `server/mcp-selection.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9458): `AssertionError: expected undefined not to be undefined // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/mcp-selection.e2e.test.ts`
  - `imports atomically and mounts the selected MCP servers in fresh direct and room sessions 5035ms`

### `server/memory-room-capture.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 9472): `AssertionError: expected '' to contain 'Person: Lead, the garden launch moved…'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/memory-room-capture.e2e.test.ts`
  - `captures a member bot's room turn into its memory, sourced to the room, once Learn from group chats is on 4360ms`
  - `captures a Codex member bot's room turn through Codex's own background call 2263ms`

### `server/memory-room-prompt.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9502): `AssertionError: expected 'You are Lead, a personal bot in RootC…' to contain 'Change MEMORY.md only with memory_upd…'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/memory-room-prompt.e2e.test.ts`
  - `gives a room turn the memory_update guidance, not the file-tools one 3418ms`

### `server/message-search.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9543): `AssertionError: expected { status: 'settled', …(8) } to match object { status: 'settled', …(1) }`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/message-search.e2e.test.ts`
  - `keeps independent fixture chats and health requests usable during queued history scans 12242ms`

### `server/model-variant-return.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9615): `TypeError: Cannot read properties of undefined (reading 'capabilities')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/model-variant-return.e2e.test.ts`
  - `blocks direct and group turns when an offline engine returns without support for its saved variant 4759ms`

### `server/onboarding-model-default.e2e.test.ts` — 7 failed test(s)
- First detailed error (log line 9627): `TypeError: Cannot read properties of undefined (reading 'config')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/onboarding-model-default.e2e.test.ts`
  - `connecting a provider selects a blank starter and future bot defaults without replacing chosen models 2866ms`
  - `first send discovers a provider installed after startup without requiring the model picker 2541ms`
  - `does not select a signed-out provider for a blank starter 2435ms`
  - `does not select a disabled provider for a blank starter 2705ms`
  - `rechecks guarded permissions after held first-run provider discovery 2409ms`
  - `rechecks guarded branch after held first-run provider discovery 3711ms`
  - `a genuine first install stays unset until its provider account becomes ready 2551ms`

### `server/one-home-keep.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9727): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/one-home-keep.e2e.test.ts`
  - `turned on after the move, this computer's bots come home with what they did on My Cloud, run here and stop there, and the other computer doesn't change; turned off, it moves again 72ms`

### `server/one-home-retry.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9747): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/one-home-retry.e2e.test.ts`
  - `a check that can't pass lifts the freeze and tries again in an hour, with nothing switched on; a day of it offers Try again, which finishes the move 60ms`

### `server/one-home-session.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9767): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/one-home-session.e2e.test.ts`
  - `a move killed twice and another computer's move that fails once stay within the Admin's codes: one session each time the app runs, signed out once done 56ms`

### `server/one-home-two-desks.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9787): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/one-home-two-desks.e2e.test.ts`
  - `My Cloud ends after two computers moved to it: everything comes home to the one used most recently, and the other runs nothing 47ms`

### `server/one-home.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 9807): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/one-home.e2e.test.ts`
  - `a new buyer: every phase, the app killed at each one, ends with home on My Cloud, everything checked there, and nothing run twice 73ms`
  - `when My Cloud ends, everything comes home: this computer at once, then My Cloud's own later chats and what was on there 9ms`

### `server/openai-boat.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 9841): `AssertionError: expected [ …(4) ] to have a length of 2 but got 4`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/openai-boat.e2e.test.ts`
  - `keeps the selected API model for direct, group and scheduled Boat turns and preserves human control 7739ms`

### `server/openai-compat-vm.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 9860): `AssertionError: expected [] to include 'computer_screenshot'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/openai-compat-vm.e2e.test.ts`
  - `mounts the Local VM tools on a strict Works on: Local VM turn 1213ms`
  - `mounts the Local VM tools on the select_computer continuation 1599ms`
  - `fails the turn when the Local VM lists no tools, instead of running without them 604ms`
  - `mounts the Local VM for a claudeAgent control on the same surface 20061ms`

### `server/openai-tools.e2e.test.ts` — 3 failed test(s)
- First detailed error (log line 9920): `AssertionError: expected 'You are API tool allow, a personal bo…' not to contain 'File locations for this bot'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/openai-tools.e2e.test.ts`
  - `openaiCompat runs structured MCP calls through real harness approval and continuation, preserving text and cancellation 3704ms`
  - `groq runs structured MCP calls through real harness approval and continuation, preserving text and cancellation 3779ms`
  - `meta runs structured MCP calls through real harness approval and continuation, preserving text and cancellation 4150ms`

### `server/own-file-reads.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 10091): `AssertionError: POST /api/bots/13ece15c-3556-445f-83ed-a4488baa3410/messages: {"error":"provider instance \"claude\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/own-file-reads.e2e.test.ts`
  - `answers a bot's plain reads of its own files at Ask with no card, and still asks for anything else 2345ms`

### `server/own-home.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 10111): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/own-home.e2e.test.ts`
  - `Make Garage server my home: bots, chats, memory and routines arrive, this computer stops for good, and no routine runs twice 51ms`
  - `this computer then works for Garage server by itself, and never for the server it shares with others 2ms`

### `server/peer-allowlist.e2e.test.ts` — 8 failed test(s)
- First detailed error (log line 10153): `TypeError: Cannot read properties of undefined (reading 'id')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/peer-allowlist.e2e.test.ts`
  - `requires existing departments and never revives a Chief's authority after rename and recreation 79ms`
  - `requires existing departments and never revives a Chief's authority after delete and recreation 26ms`
  - `consults another department with no grant, and a Chief's grant is authority it loses on demotion 35ms`
  - `gives an ordinary bot a roster, then narrows it and the comms endpoints 24ms`
  - `renders only the allow-listed peers into the roster the bot is given 28ms`
  - `re-checks the allow-list after the approval card, not just before it 49ms`
  - `refuses to loosen a bot from a bare loopback call while any bot is working 24ms`
  - `lets the loopback API narrow a bot's peers but never widen them unacknowledged 10ms`

### `server/peer-approval.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 10237): `AssertionError: expected false to be true // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/peer-approval.e2e.test.ts`
  - `preserves peer approval outcomes through real HTTP responses and sends no work without an allow 19707ms`

### `server/person-first.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 10259): `AssertionError: expected false to be true // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/person-first.e2e.test.ts`
  - `stops a turn that keeps the person's message unread in a long tool call, and answers it next 22722ms`

### `server/phone-claim.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 10281): `AssertionError: POST /api/bots/ffd82e09-4c97-4599-9794-5cf4258bf7b0/messages: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected false to be true // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/phone-claim.e2e.test.ts`
  - `rejects a retained proxy after its turn settles, before and after a new owner claims 205ms`
  - `mounts the phone for trigger words on both turn paths without claiming it 52ms`
  - `holds no claim when the trigger word only appears in room history 20027ms`
  - `claims at the first tool call, blocks the concurrent caller, and releases at turn end 30ms`

### `server/phones-member-routine.e2e.test.ts` — 3 failed test(s)
- First detailed error (log line 10357): `AssertionError: expected true to be false // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/phones-member-routine.e2e.test.ts`
  - `a routine a client session wrote never reaches the owner's phone, whoever runs it 22340ms`
  - `the desk editing the owner's routine takes the phone away from it until the owner rewrites it 21013ms`
  - `where sign-in lets several people in, the desktop offers no phone, even to the owner's own turn 20039ms`

### `server/phones.e2e.test.ts` — 8 failed test(s)
- First detailed error (log line 10429): `TypeError: Cannot read properties of undefined (reading 'ROOTCLAW_HARNESS_URL')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/phones.e2e.test.ts`
  - `a registered phone's tools reach the bot and a job round-trips 1085ms`
  - `any bot left on the default hears where the person is talking from: the paired phone's send, or the computer 734ms`
  - `a confined run has no device integration 1043ms`
  - `only the owner's own sessions hold a phone or lend their turn to one 20052ms`
  - `a conversation a routine reported into keeps the phone 20076ms`
  - `a thread a webhook's run opens has no phone; one the owner's turn opens does 20033ms`
  - `a conversation an outside event's run reported into loses the phone 20026ms`
  - `a send reaches the phone with no card of RootClaw's own in the chat: the person taps Send on the phone 20058ms`

### `server/place-view.e2e.test.ts` — 6 failed test(s)
- First detailed error (log line 10615): `AssertionError: POST /api/bots/bb189ee1-9fc8-49fe-945f-b9884477534d/messages: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be less than 400`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/place-view.e2e.test.ts`
  - `J5: no hours left says when they come back, offers the plan, and starts nothing 2451ms`
  - `J6: at once names the bot that holds the plan's cloud computer 2390ms`
  - `J7: a relay that can't start one says so plainly, with Try again and no Boat words 2448ms`
  - `the Admin's subscription_inactive reads as Plan ended, by its code, with See your plan 2340ms`
  - `an automatic pin that fails is cleared, and the row says the conversation is back on Auto 4485ms`
  - `a cloud routine that can't start its computer points at where the routine runs 32408ms`

### `server/places-elsewhere.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 10700): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/places-elsewhere.e2e.test.ts`
  - `a bot asking for a teammate on the person's other place hears where it lives and how to bring them together; never on a server shared with others 357ms`

### `server/postiz.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 10719): `AssertionError: expected { tools: [ 'integrationlist', …(3) ] } to match object { Object (url) }`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/postiz.e2e.test.ts`
  - `signs in with Postiz Cloud, gives the bot the postiz tools behind a hidden token, and Disconnect takes them away 1330ms`
  - `connects a person's own Postiz with an API key, refuses a wrong key or address plainly, and never shows the key 1046ms`

### `server/proactive-routines.e2e.test.ts` — 5 failed test(s)
- First detailed error (log line 10773): `Error: ENOENT: no such file or directory, open '/tmp/rootclaw-verify-data-HUTTjZ/fake-claude-dump.json'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/proactive-routines.e2e.test.ts`
  - `new mail and a meeting become one read-and-draft run; the reminder needs no AI; the brief and prep are posted 72ms`
  - `the same mail again is nothing new: no second turn 1ms`
  - `Dismiss takes the row away with no AI turn, and the next sort hears about it 3ms`
  - `a routine of the person's own runs as before: its own level, its own line in the chat 1462ms`
  - `refuses sends, other apps and drafts to anyone but the thread's sender, outright and with no card; one reply draft gets through once 90ms`

### `server/profile-card-lifecycle.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 10845): `AssertionError: expected false to be true // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/profile-card-lifecycle.e2e.test.ts`
  - `applies the bot's own alert and voice changes at once, refuses a stale Undo, and supersedes credential requests in an isolated conversation 18143ms`

### `server/published-pages.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 10867): `TypeError: Cannot read properties of undefined (reading 'tools')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/published-pages.e2e.test.ts`
  - `publishes a bot's page to a link shown inline, keeps the link and the card on a republish, and unpublishes it from the card 1199ms`

### `server/question-cards.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 10880): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/question-cards.e2e.test.ts`
  - `asks Cleo a decision with set answers as a card in Ledger's chat and a copy in her inbox, and a tap there answers Ledger, who carries on 23ms`
  - `takes Cleo's own words in Ledger's chat as the answer to the card Ledger waits on 8ms`
  - `turns Ledger's NEEDS INPUT question into the same card with a reply field, in its chat and in Cleo's inbox, and her reply there answers Ledger 6ms`
  - `closes the open question as stopped when Cleo stops Ledger's work, in its chat and in her inbox 6ms`

### `server/question-routing.e2e.test.ts` — 6 failed test(s)
- First detailed error (log line 10960): `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/question-routing.e2e.test.ts`
  - `hands Dachs's question to Fuchs, and with no answer from Fuchs Dachs goes on with its default and says so: no card, notification or inbox line for Marco 23ms`
  - `takes Fuchs's own answer, sent to Dachs with coordinate_bots, as the answer: no new work, and Dachs's card says Fuchs picked it 23ms`
  - `asks Marco only for the sign-in he alone can do, once, while Otter's part finishes and Fuchs carries on; his line in Dachs's chat carries Dachs on 8ms`
  - `settles Dachs's question with Marco's answer passed on by Fuchs: no new task, the card and its inbox copy follow, and Needs you clears 7ms`
  - `keeps a waiting question across a restart without posting it again: one card, one inbox line, no second notification; the answer after it reaches Dachs 7ms`
  - `drops a question whose asking turn is gone from Needs you and the inbox once the work goes on without it 7ms`

### `server/quota-switch.e2e.test.ts` — 3 failed test(s)
- First detailed error (log line 11082): `AssertionError: expected false to be true // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/quota-switch.e2e.test.ts`
  - `carries the request on with another AI by itself: the exact message once more there, one notice, the failed root left settled 32282ms`
  - `never moves to another sign-in of the same AI: it says once that the bot waits, and sends nothing again 2536ms`
  - `moves nothing when ROOTCLAW_QUOTA_SWITCH=0 switches it off 33320ms`

### `server/reactions.e2e.test.ts` — 3 failed test(s)
- First detailed error (log line 11153): `AssertionError: expected '' to contain 'The current message is the person\'s …'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/reactions.e2e.test.ts`
  - `answers a bot's yes-or-no question with a 👍, and the bot goes on by itself 3961ms`
  - `allows an open approval with a 👍 on its card and denies one with a 👎 3239ms`
  - `in a room, gives the 👍 to the member that asked, by name 4059ms`

### `server/recent-work.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 11201): `AssertionError: expected 'You are Lead, a bot in the room "Stan…' to contain 'Your recent work'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/recent-work.e2e.test.ts`
  - `carries a bot's recent 1:1 work into a room turn, tells the room, logs the turn, and carries the room back 4646ms`

### `server/replay-tool-history.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 11242): `AssertionError: expected 'failed' to be 'settled' // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/replay-tool-history.e2e.test.ts`
  - `names earlier tool calls in a rebuilt session only when switched on 3454ms`

### `server/reply-behaviour.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 11260): `AssertionError: expected 'You are Memo, a personal bot in RootC…' to contain ' When the person asks you to remember…'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/reply-behaviour.e2e.test.ts`
  - `remembers at once, learns only what the person said, forgets everywhere, and words a routine plainly 3725ms`

### `server/room-chat-wait.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 11300): `TypeError: Cannot read properties of undefined (reading 'id')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/room-chat-wait.e2e.test.ts`
  - `parks on a responder busy in a 1:1, then lets them reply once that turn settles, in order 28ms`
  - `waits for a teammate summoned by a chained @mention who is busy elsewhere 11ms`

### `server/room-context.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 11324): `AssertionError: expected 15 to be 990000 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/room-context.e2e.test.ts`
  - `shows a bot's room context, compacts on request, and compacts before a turn above the threshold 8464ms`
  - `drops a member's reading once another member's turn replaces its warm process 8418ms`

### `server/room-coordination.e2e.test.ts` — 14 failed test(s)
- First detailed error (log line 11369): `TypeError: Cannot read properties of undefined (reading 'result')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/room-coordination.e2e.test.ts`
  - `lists and coordinates with a supervising Chief and same-section peer in the same room (Chief section "") 6630ms`
  - `lists and coordinates with a supervising Chief and same-section peer in the same room (Chief section "Leadership") 6102ms`
  - `coordinates in a room that mixes departments, with a Chief that manages none of them 6017ms`
  - `refuses supervisor room coordination with a disallowed peer 3471ms`
  - `refuses a disallowed peer without starting the recipient 3452ms`
  - `enforces the 4001-character request boundary on the real server 3866ms`
  - `receipts a retried duplicate of a failed hand-off as failed, not queued behind a resume that never comes 15001ms`
  - `honors deny on the sender's peer-approval card 3672ms`
  - `presents all peer approvals together and dispatches only if every recipient is allowed (deny) 3724ms`
  - `consults multiple existing members and returns once, with no discussion prerequisite or new room settings 5872ms`
  - `refuses a name nobody has in a bot_ids slot with a message the caller can act on 3870ms`
  - `refuses a hidden teammate's id with a message the caller can act on 3829ms`
  - `resolves a unique teammate name in a bot_ids slot, and refuses an ambiguous one 6008ms`
  - `hands work a Chief addresses into its room to the bots it just made, which are not in the room, directly 3631ms`

### `server/room-holds.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 11562): `TypeError: Cannot read properties of undefined (reading 'id')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/room-holds.e2e.test.ts`
  - `ends that member's turn, skips it on every route, saves the hold, and brings it back with what it missed 32ms`
  - `holds and releases one member from its own control 16ms`
  - `keeps working notes out of the reply: a teammate named in one is not summoned 11ms`
  - `re-asks once for a short result when a turn ends without one 35ms`

### `server/room-missing-folder.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 11610): `TypeError: Cannot read properties of undefined (reading 'models')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/room-missing-folder.e2e.test.ts`
  - `a room whose folder was deleted names that folder when work handed there fails, not the bot's settings 2525ms`

### `server/room-question-tasks.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 11622): `ZodError: [`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/room-question-tasks.e2e.test.ts`
  - `keeps live room questions fenced but allows task changes after their turn settles and restarts 3264ms`

### `server/room-queue.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 11645): `TypeError: Cannot read properties of undefined (reading '0')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/room-queue.e2e.test.ts`
  - `tells the requester and the room that three same-room jobs run in turn 4057ms`
  - `with parallel room jobs on, runs each member's job in its own thread at once and posts the results back into the room 4847ms`

### `server/room-recovery.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 11669): `AssertionError: expected { id: 'cut-work', …(20) } to match object { restarts: 1, executions: 1, …(1) }`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/room-recovery.e2e.test.ts`
  - `keeps a routine waiting through a restart, reruns its cut teammate once, and completes it 5659ms`

### `server/room-roots.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 11693): `AssertionError: expected undefined to be 'bypassPermissions' // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/room-roots.e2e.test.ts`
  - `R2 a member's coordinate_bots reuses its turn's root, and a Chief's Full reaches the teammate's row and turn 7309ms`
  - `R3 parks a member's root on its credential card, keeps the room taking messages, and resumes the member with the provided line 5310ms`
  - `R6 reruns a member's cut turn once after a restart, in place, with the restart note and the member's resuming chip 38006ms`
  - `R6 does not rerun a member's cut turn that already pushed: the root ends with what it did, said once in the room 33634ms`

### `server/routine-continuity.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 11777): `AssertionError: expected '"Context from RootClaw updated since …' to contain 'hello from fake claude'`
- Preliminary cluster: **Legacy fake reply expectation** — confirmed in bot-setup against the current native fake reply.
- Reproduction: `pnpm exec vitest run server/routine-continuity.e2e.test.ts`
  - `passes the previous report to the real fake-engine turn only when continuity is enabled 4514ms`

### `server/routine-cron.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 11793): `AssertionError: expected +0 to be 1 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/routine-cron.e2e.test.ts`
  - `takes cron through the real routine tools, applying the bot's own routine at once, preserving its zone and rejecting invalid API input 22764ms`

### `server/routine-delegation.e2e.test.ts` — 8 failed test(s)
- First detailed error (log line 11824): `AssertionError: PATCH /api/instances/claude: {"error":"Supply a valid name, boolean tools setting or a reply wait of 1 to 60 minutes."}: expected 400 to be less than 300`
- Preliminary cluster: **Retired instance API/schema expectation** — confirmed in the escalations reproduction; do not generalize without checking each test.
- Reproduction: `pnpm exec vitest run server/routine-delegation.e2e.test.ts`
  - `waits for a busy peer, then resumes the same routine as a routine turn and records the final report 2497ms`
  - `completes the routine when the person denies its hand-off, instead of leaving it waiting 2307ms`
  - `resumes the waiting routine once a slot frees at capacity 3, on 'completion' 2442ms`
  - `resumes the waiting routine once a slot frees at capacity 1, on 'raise' 2301ms`
  - `coordinates a new user request on a completed routine's thread without changing its recorded result 2342ms`
  - `does not dispatch an approved handoff after the routine was cancelled 3782ms`
  - `keeps a failed routine's queued hand-off on the runtime through a provider reload without reviving the run 2954ms`
  - `does not revive a cancelled routine when its running peer replies during later user work 2461ms`

### `server/routine-recovery.e2e.test.ts` — 8 failed test(s)
- First detailed error (log line 11837): `AssertionError: PATCH /api/instances/claude: {"error":"Supply a valid name, boolean tools setting or a reply wait of 1 to 60 minutes."}: expected 400 to be less than 300`
- Preliminary cluster: **Retired instance API/schema expectation** — confirmed in the escalations reproduction; do not generalize without checking each test.
- Reproduction: `pnpm exec vitest run server/routine-recovery.e2e.test.ts`
  - `never starts a routine again that the turn watchdog stopped as stalled: it fails at once, and its owner hears once 2490ms`
  - `starts a routine that crashed again once, and it completes in the same conversation 2552ms`
  - `fails a routine that crashes again on its retry, says so, and never retries it a second time 2395ms`
  - `picks a run that a restart cut off up again once on the next start, and never runs it twice 2416ms`
  - `keeps an ACP engine's run that a graceful shutdown cut off, and starts it once more on the next start 2385ms`
  - `waits for the conversation it joins to be free instead of failing, then runs there 2402ms`
  - `never retries a signed-out engine, and tells the owner exactly once what to do 2405ms`
  - `waits for a usage limit that says when it resets, instead of failing 2394ms`

### `server/routine-results.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 11948): `AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a string`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/routine-results.e2e.test.ts`
  - `reports every run into the bot's main thread while fresh executions, approvals, deletion and unread stay reachable 3949ms`
  - `reports a routine made in a chat into that chat once the person writes there, not the bot's first thread or a new results thread 5866ms`

### `server/routine-unanswered-wait.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 11982): `AssertionError: PATCH /api/instances/claude: {"error":"Supply a valid name, boolean tools setting or a reply wait of 1 to 60 minutes."}: expected 400 to be less than 300`
- Preliminary cluster: **Retired instance API/schema expectation** — confirmed in the escalations reproduction; do not generalize without checking each test.
- Reproduction: `pnpm exec vitest run server/routine-unanswered-wait.e2e.test.ts`
  - `starts the next scheduled run of a routine whose sign-in nobody answered, and stops the old wait 2305ms`

### `server/routine-unattended-approval.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 11995): `AssertionError: PATCH /api/instances/claude: {"error":"Supply a valid name, boolean tools setting or a reply wait of 1 to 60 minutes."}: expected 400 to be less than 300`
- Preliminary cluster: **Retired instance API/schema expectation** — confirmed in the escalations reproduction; do not generalize without checking each test.
- Reproduction: `pnpm exec vitest run server/routine-unattended-approval.e2e.test.ts`
  - `waits for the person, tells them at once, and stops saying nobody answered the approval when it went unanswered 2526ms`

### `server/runtime-coordination.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 12008): `AssertionError: expected '' to contain '[RootClaw assignment'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/runtime-coordination.e2e.test.ts`
  - `S1 assigns a teammate under the envelope and resumes the Chief once with the report 4303ms`
  - `S2 parks a teammate on NEEDS INPUT, passes her question to the Chief once, carries the person's answer into her next turn, and resumes the Chief with the result 5967ms`
  - `S2b resumes the Chief once with a parked question, keeps one question chip across a restart and names the parked thread as waiting on the person 38580ms`
  - `S3 runs a cut teammate turn again once after a restart and resumes the Chief with the report 10321ms`

### `server/runtime-paths.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 12083): `AssertionError: expected '' to contain '[RootClaw assignment'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/runtime-paths.e2e.test.ts`
  - `R1 a routine run coordinates a teammate, waits, and completes through a routine resume turn 5651ms`
  - `R3 a consultation reaches a teammate without waiting and resumes the asker with the answer 23512ms`
  - `R4 a one-way notice opens a notify child in a new thread and never resumes the sender 23459ms`
  - `R5 an external runtime delegates, long-polls assignment_status for the settled child, and is never woken 3865ms`

### `server/safety-floor.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 12173): `AssertionError: POST /api/bots/4ca95b63-5dea-44e4-8309-a0be23484acb/messages: {"error":"provider instance \"claude\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/safety-floor.e2e.test.ts`
  - `denies a never-list command a grant would have allowed, at a saved command and at Full access, and leaves a person's card alone 2504ms`

### `server/saved-login.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 12194): `TypeError: Cannot read properties of undefined (reading '0')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/saved-login.e2e.test.ts`
  - `saves a login from the sign-in card with the Microsoft sign-in page it shows, and fill_login signs in there in one call without the bot ever seeing the password 13381ms`
  - `fills a login saved for example.com on its subdomains, refuses eval on that page right after, offers no github.io login to another github.io name, and clears a refused login 20434ms`

### `server/secret-requests.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 12224): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/secret-requests.e2e.test.ts`
  - `keeps a file secret and a ref secret out of every record, and the bot uses each once 73ms`

### `server/setup-connect-card.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 12245): `AssertionError: POST /api/bots/1fec049a-f919-42c4-b384-7f745f6fd16d/messages: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be less than 400`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/setup-connect-card.e2e.test.ts`
  - `shows a Connect card for Gmail in the chat when the bot's connected apps are on 55ms`
  - `names the switch, and mounts nothing to call, when the bot's connected apps are off 65ms`

### `server/setup-import.e2e.test.ts` — 3 failed test(s)
- First detailed error (log line 12273): `AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a string`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/setup-import.e2e.test.ts`
  - `finds a skill and an MCP server, keeps one copy of the skill for the first bot and every later one, and adds the server switched off 1321ms`
  - `with Also use my Claude Code skills on, a Claude turn sees each Claude Code skill once, from its own folder 885ms`
  - `reaches a bot's room turns too, which run in its own folder: through the index 541ms`

### `server/sign-in-code.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 12342): `AssertionError: expected +0 to be 1 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/sign-in-code.e2e.test.ts`
  - `a bot asked to sign in reads the emailed code from the person's own mailbox and types it into that site, told never to send it anywhere else 37494ms`

### `server/sign-in-request.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 12359): `AssertionError: expected +0 to be 1 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/sign-in-request.e2e.test.ts`
  - `asks the person to sign in from a real turn, and runs the bot's next turn when they press Done 22446ms`
  - `a reply in the chat answers the sign-in request: the card settles, nothing waits under Needs you, and Done no longer resumes the old turn 22385ms`

### `server/skill-review.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 12403): `AssertionError: expected { status: 'failed', …(8) } to match object { status: 'settled' }`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/skill-review.e2e.test.ts`
  - `reviews a conversation in the background once its tool steps reach the threshold 3485ms`
  - `reviews a Codex bot's conversation through Codex's own background call 2283ms`

### `server/surface-pins.e2e.test.ts` — 6 failed test(s)
- First detailed error (log line 12438): `AssertionError: POST /api/bots/dd832330-edff-49c4-a093-aeffb6309917/messages: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be less than 400`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/surface-pins.e2e.test.ts`
  - `still refuses to change a busy thread's surface 2453ms`
  - `mounts the VM for a turn into a thread auto-pinned to this computer 6804ms`
  - `mounts the built-in browser beside the computer in a thread a teammate opened, and not in a person's thread 4549ms`
  - `records future auto pins and moves them when Works on changes 2240ms`
  - `clears a select_computer pin to a cloud computer that fails, and keeps a person's pin 3162ms`
  - `never takes a relayed line's conversation for where the person writes, when select_computer continues its turn 2476ms`

### `server/talk-server.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 12517): `AssertionError: expected { kind: 'done', ok: true, …(1) } to match object { kind: 'done', ok: true, …(1) }`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/talk-server.e2e.test.ts`
  - `asks RootClaw in its own Quick asks chat, as the desktop app does, and follows the reply to the end 1087ms`

### `server/team-move.e2e.test.ts` — 5 failed test(s)
- First detailed error (log line 12540): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/team-move.e2e.test.ts`
  - `moves Scout with its two chats, its routine and its files; its notes about Ada stay on My Cloud 57ms`
  - `a move cut short, by the app killed while My Cloud holds the bot and by a dropped request, goes on to the end: nothing doubled, the routine never on in two places 21ms`
  - `a bot whose name Acme already uses arrives as "Scout (Ada)" 25ms`
  - `refuses someone else's bot: Acme's own, one another person moves, and anything but its own bot to a move-in sign-in 17ms`
  - `Ada's moved chats are hers on any device: the server names them among the conversations she opened 0ms`

### `server/team-package-skills.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 12626): `AssertionError: expected '{"bot":{"id":"9509751a-b84c-44cb-be41…' to contain 'hello from fake claude'`
- Preliminary cluster: **Legacy fake reply expectation** — confirmed in bot-setup against the current native fake reply.
- Reproduction: `pnpm exec vitest run server/team-package-skills.e2e.test.ts`
  - `transfers only selected skills disabled, preserves originals, and rolls back failed installation 3907ms`

### `server/team-setup.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 12642): `AssertionError: expected undefined to be defined`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/team-setup.e2e.test.ts`
  - `Clive sets up multi-provider teams at Ask with no card, keeps existing threads through setup and deletion, and adds a specialist it picked itself at once, with an Undo 2275ms`

### `server/teammate-follow-ups.e2e.test.ts` — 6 failed test(s)
- First detailed error (log line 12654): `AssertionError: expected 'You are Mira, a personal bot in RootC…' to contain '@Clive answered: "the main one".'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/teammate-follow-ups.e2e.test.ts`
  - `Q1 takes Clive's later reply to Mira's thread as the answer to the question her work waits on, not as new work 6712ms`
  - `Q2 takes Clive's reply to Mira's thread as the answer to the card her ask tool waits on, and her turn carries on with it 33600ms`
  - `F1 hands Clive's correction to the turn Mira is running for him, and her one result carries it 7885ms`
  - `F2 sends Clive's follow-up to the one thread he names, among those he opened on Mira, and its result comes back to him 8915ms`
  - `F4 keeps a second assignment Clive hands Mira in the same turn its own job, though the first is already running 3666ms`
  - `F3 refuses a thread Clive did not open on Mira, saying where thread ids come from 3587ms`

### `server/tested-ai.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 12786): `AssertionError: expected {} to deeply equal { claude: 'failed', spare: null }`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/tested-ai.e2e.test.ts`
  - `moves nothing on one miss, then the default and the untouched first bot to the AI that answered, and remembers it 36674ms`
  - `never tests or moves a saved default 5979ms`

### `server/thread-model-follow.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 12834): `Error: provider instance "" is unavailable — pick another model in settings`
- Preliminary cluster: **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace.
- Reproduction: `pnpm exec vitest run server/thread-model-follow.e2e.test.ts`
  - `runs a thread whose engine is missing on its bot's model, once, and the thread follows the bot 6761ms`
  - `runs a thread whose engine is disabled on its bot's model, once, and the thread follows the bot 6757ms`
  - `gives way to a signed-out engine when the bot's model is on another engine that can run 7626ms`
  - `keeps the sign-in failure when the bot's model is on the same signed-out engine 6669ms`

### `server/thread-title-regenerate.e2e.test.ts` — 4 failed test(s)
- First detailed error (log line 12888): `TypeError: Cannot read properties of undefined (reading 'id')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/thread-title-regenerate.e2e.test.ts`
  - `names a renamed thread from its recent conversation, without tool output 20ms`
  - `keeps the current title and says so when the one-shot fails or answers something unusable 15ms`
  - `refuses a thread with nothing to name it from, and an unknown one 4ms`
  - `is refused once generated titles are switched off 46ms`

### `server/tool-results.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 12950): `TypeError: Cannot read properties of undefined (reading 'ROOTCLAW_THREAD_ID')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/tool-results.e2e.test.ts`
  - `bounds a real roster, retrieves its tail, isolates owners and expires stopped capabilities 4013ms`

### `server/tool-scope.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 12963): `TypeError: Cannot read properties of undefined (reading 'ROOTCLAW_GATE_TOOL_SCOPE')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/tool-scope.e2e.test.ts`
  - `carries the latest original tool selection into fresh direct and room MCP connections 3921ms`

### `server/triggers.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 12977): `AssertionError: expected +0 to be 1 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/triggers.e2e.test.ts`
  - `sets up schedule and webhook triggers from chat at Ask, with no confirmation, no leaked secret, and a working link 22477ms`

### `server/trust-controls.e2e.test.ts` — 13 failed test(s)
- First detailed error (log line 13001): `AssertionError: {"error":"unauthorized: this session has expired or was revoked; pair this device again"}: expected 401 to be 201 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/trust-controls.e2e.test.ts`
  - `keeps activity, shared memory and policy changes admin-only 15ms`
  - `sends in Full without a card, and still refuses an app outside the bot's scope 6ms`
  - `shows each outbound batch recipient and amount with explicit preview truncation before consent 4ms`
  - `rechecks scope revocation after project-session metadata and before the actual send 9ms`
  - `rechecks turn revocation after project-session metadata and before the actual send 3ms`
  - `reserves a daily slot before provider await, so simultaneous calls cannot overspend 4ms`
  - `never treats arbitrary workbench code as a counted daily allowance 4ms`
  - `tells a scoped bot its multi-execute arguments were unreadable, not that it lacks access 4ms`
  - `applies a bot's team fact at Ask with an Undo only an admin may use, and still refuses restricted memory 6ms`
  - `puts a bot's fact into every teammate's prompt at once, and Undo takes it back out 19ms`
  - `settles only the source task after approval or Stop, leaving the selected sibling unchanged 10ms`
  - `preserves accounts referenced by a fallback chain before delete or credential-directory change 3ms`
  - `does not relay if the allowance cannot be durably written 3ms`

### `server/turn-clock.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 13233): `AssertionError: Context from RootClaw updated since this conversation started; it replaces any earlier copy:`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/turn-clock.e2e.test.ts`
  - `stamps every direct and room turn with the time it was sent 4672ms`

### `server/usage-traces.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 13252): `AssertionError: expected null to be truthy`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/usage-traces.e2e.test.ts`
  - `traces a person's message to the Chief through the teammate it delegated to and the tools that teammate used 25797ms`

### `server/use-my-mac.e2e.test.ts` — 5 failed test(s)
- First detailed error (log line 13274): `AssertionError: expected 409 to be 202 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/use-my-mac.e2e.test.ts`
  - `a bot's browser on My Cloud reaches Instagram from the Mac's own connection: the website sees the Mac, not My Cloud 37ms`
  - `every other site loads straight from My Cloud: the Mac is never asked, nor looks it up 2ms`
  - `a page that reaches for the Mac's home network, the Mac itself, a metadata service, NAT64 or another port is refused on the Mac 1ms`
  - `a 2 MiB file on the Mac reads whole through My Cloud, under its 4 MB body 83ms`
  - `when the Mac goes away, a page in flight ends at once, My Cloud says it is away, and the next page goes My Cloud's own way without waiting 90003ms`

### `server/verification-fixture.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 13365): `AssertionError: expected undefined to be 'unavailable' // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/verification-fixture.e2e.test.ts`
  - `keeps the fixture blind to this machine's installed CLIs (#2035) 2314ms`

### `server/voice-notes.e2e.test.ts` — 8 failed test(s)
- First detailed error (log line 13384): `TypeError: Cannot read properties of undefined (reading 'tools')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/voice-notes.e2e.test.ts`
  - `advertises send_voice_note to a ready bot and attaches the clip to the settling reply 3488ms`
  - `delivers a WAV voice note from a provider that answers in WAV 3681ms`
  - `keeps a voice-only reply's words on the attachment as its transcript when the turn writes no reply 4218ms`
  - `hides the tool and refuses the call when no voice is configured 4277ms`
  - `hides the tool and refuses the call when voice notes are turned off for the bot 4394ms`
  - `attaches a parked voice note to a room post and delivers it exactly once 3867ms`
  - `refuses a room post that asks to attach a voice note this turn never recorded 3731ms`
  - `keeps the parked note when the room-post append fails, so a retry can attach it 6560ms`

### `server/waits.e2e.test.ts` — 2 failed test(s)
- First detailed error (log line 13505): `AssertionError: expected false to be true // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/waits.e2e.test.ts`
  - `waits for a file with no AI, posts once in the asked chat, notifies, and continues there; Cancel on its card stops another 17613ms`
  - `refuses a new wait in the run a wait's follow-up started, so a wait never renews itself 17653ms`

### `server/webhook-address.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 13553): `AssertionError: expected +0 to be 1 // Object.is equality`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/webhook-address.e2e.test.ts`
  - `gives the address to the owning bot and its Chief, never to a teammate, another audience or an outside event's run 22644ms`

### `server/webhook-room-post.e2e.test.ts` — 1 failed test(s)
- First detailed error (log line 13577): `AssertionError: expected 'You are Scout, a bot in the room "Mor…' to contain 'Posted by an outside app through a we…'`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/webhook-room-post.e2e.test.ts`
  - `posts text, a voice note and an image into a room as one bot message, with no run, and refuses once the bot leaves 3398ms`

### `server/x-research.e2e.test.ts` — 5 failed test(s)
- First detailed error (log line 13618): `TypeError: Cannot read properties of undefined (reading 'result')`
- Preliminary cluster: **Other / unclassified** — needs individual reproduction and tracing.
- Reproduction: `pnpm exec vitest run server/x-research.e2e.test.ts`
  - `shows no research tools without a treg key or a Cloud plan, even to a bot switched on 3367ms`
  - `with the person's own treg key, every bot has the tools by default and calls go straight to treg, never the relay 3747ms`
  - `with only a Cloud plan, calls go through the relay with the plan's token, and a bot switched off has no tools 3524ms`
  - `with both a treg key and a Cloud plan, the person's own key wins and the card says so; removing it falls back to the plan 3662ms`
  - `with a Cloud plan whose relay has research off, bots get x_search and not the research tools, and X still works 4043ms`

## Suite setup/cleanup failures without a failed-test marker

- `server/bulk-delete-tasks.e2e.test.ts` — log line 2930: `Error: ENOENT: no such file or directory, chmod '/root/RootClaw/server/testing/fake-claude-cli.ts'`; **Removed fake executable** — confirmed; the referenced file is absent and the focused chmod test reproduced ENOENT. Reproduce with `pnpm exec vitest run server/bulk-delete-tasks.e2e.test.ts`.
- `server/cloud-lending-browser.e2e.test.ts` — log line 2954: `AssertionError: expected 409 to be 202 // Object.is equality`; **Other / unclassified** — needs individual reproduction and tracing. Reproduce with `pnpm exec vitest run server/cloud-lending-browser.e2e.test.ts`.
- `server/cloud-personal.e2e.test.ts` — log line 2975: `Error: timed out waiting for a turn to start`; **Timeout/wait** — independent or downstream cause not yet established. Reproduce with `pnpm exec vitest run server/cloud-personal.e2e.test.ts`.
- `server/cloud-team-bot-access.e2e.test.ts` — log line 2997: `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`; **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace. Reproduce with `pnpm exec vitest run server/cloud-team-bot-access.e2e.test.ts`.
- `server/cloud-team-inbox.e2e.test.ts` — log line 3016: `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`; **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace. Reproduce with `pnpm exec vitest run server/cloud-team-inbox.e2e.test.ts`.
- `server/cloud-team-private.e2e.test.ts` — log line 3036: `AssertionError: {"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be 202 // Object.is equality`; **No active native provider in fixture** — confirmed on Group Local VM; other files still require their own trace. Reproduce with `pnpm exec vitest run server/cloud-team-private.e2e.test.ts`.
- `server/helper-model.e2e.test.ts` — log line 3056: `Error: ENOENT: no such file or directory, chmod '/root/RootClaw/server/testing/fake-claude-cli.ts'`; **Removed fake executable** — confirmed; the referenced file is absent and the focused chmod test reproduced ENOENT. Reproduce with `pnpm exec vitest run server/helper-model.e2e.test.ts`.
- `server/hooks.e2e.test.ts` — log line 3085: `Error: ENOENT: no such file or directory, chmod '/root/RootClaw/server/testing/fake-claude-cli.ts'`; **Removed fake executable** — confirmed; the referenced file is absent and the focused chmod test reproduced ENOENT. Reproduce with `pnpm exec vitest run server/hooks.e2e.test.ts`.
- `server/shared-computers.e2e.test.ts` — log line 3097: `TypeError: Cannot read properties of undefined (reading 'ROOTCLAW_COMMS_TOKEN')`; **Other / unclassified** — needs individual reproduction and tracing. Reproduce with `pnpm exec vitest run server/shared-computers.e2e.test.ts`.
- `server/steer-unattended.e2e.test.ts` — log line 3110: `Error: ENOENT: no such file or directory, chmod '/root/RootClaw/server/testing/fake-claude-cli.ts'`; **Removed fake executable** — confirmed; the referenced file is absent and the focused chmod test reproduced ENOENT. Reproduce with `pnpm exec vitest run server/steer-unattended.e2e.test.ts`.
