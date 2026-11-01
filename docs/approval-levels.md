# Approval levels

RootClaw runs every bot on its built-in native engine, and the native engine's
tool gate decides what needs a person (`server/auto-approve.ts`,
`server/drivers/chat-tool-approval.ts`). A bot has three levels:

| Level | Behavior |
| --- | --- |
| **Ask for approval** | Shell commands, file writes and patches, `web_fetch` and `web_search`, and tools that act outside the bot (MCP tools, computer control, sends through connected apps) raise an approval card. Reading files in the bot's workspace never asks. |
| **Approve for me** | Like Ask, except a web search runs without a card. Everything else that asks still asks, with the note "The provider requires your approval for this action." |
| **Full access** | Every tool call is approved for you, including shell commands, writes, web access, computer actions and sends through connected apps (email, messages, posts, payments) within the bot's connected-app scope; apps outside that scope are still refused. RootClaw profile changes, routine actions, team setup, bot deletion and enabled skill authoring apply without a second approval, and peer-review prompts are skipped within the bot's authorized scope. Work handed on with `coordinate_bots` uses the receiving bot's setting, never the sender's — except from a Chief of Staff, whose level flows down (below). |

The levels Auto-accept edits and Custom (`config.toml`) belonged to the removed
external engines; the native engine does not offer them
(`supportsApprovalMode` in `shared/approval-mode.ts`).

At every level, some calls run without a card because a person already
granted them:

- **Full access** (above).
- **A saved exact command**: a shell command line, in that folder, that you
  saved for the bot.
- **A remembered MCP read tool** (below).
- **"Always allow this session"** on an earlier card (below).
- **A bot reading its own files**: its standing instructions (`SOUL.md`), its
  skills with every saved revision, its memory and its conversation folders.
  That covers a plain reading command (`cat`, `head`, `tail`, `grep`, `rg`,
  `sed -n`, `ls`, `wc`, `nl`, `stat`) made of plain words alone, when every
  path is inside the bot's own folders once links are followed. Anything else
  in the command (a pipe, a redirect, a second command, a variable, a glob)
  asks as before, and so does every read in a guest's turn, since a bot's
  folder holds its owner's memory. On a Cloud the bot's box also shows it its
  own `SOUL.md`, read-only.

Some things no level and no grant answers: a question the bot asks you
(`ask_user`) and a missing credential always reach a person. A tool that sends
something on your behalf asks below Full access even with a saved grant
("This sends something on your behalf, so it asks you first."). A request to
loosen the bot's own safety limits is approved automatically only in Full
access. When the optional safety floor is on (`safetyFloor.enabled` in
`config.json` or `ROOTCLAW_SAFETY_FLOOR=1`; not applied on a Windows server),
the commands on its never-list are never approved automatically, Full access
included, for every bot; only a person answering the card can allow one. A
command the floor cannot read gets a card instead of an automatic allow
([verification/safety-floor.md](verification/safety-floor.md)).

Approval levels sit on top of the shell sandbox, not instead of it: a shell
command still runs inside bubblewrap (or `sandbox-exec` on macOS) with no
network unless the call asks for `network`, which the approval card shows
([install.md](install.md#requirements)).

## Defaults

Every bot and conversation starts at **Full access** (`DEFAULT_APPROVAL_MODE`
in `shared/approval-mode.ts`); a real question or a missing credential still
reaches you. That covers a bot made in New bot, through the API or by
onboarding, each new thread, a Chief's new teammates, and bots imported from a
team backup, a shared team file or the organization library. A level a person
picks stays until someone changes it. On a hosted company workspace the
default stays Ask, because Full access there comes only from the operator's
dedicated policy ([guarded messages](verification/guarded-messages.md)).

Full access applies the moment you pick it: no confirmation dialog, no second
step. It can be turned on from any client that can reach the app's API: the
desktop app, a browser, a paired phone or web client, or a bot or script
calling the local API where local calls count as you (development, the CLI, a
self-hosted server). Picked in bot settings, it applies to the bot and every
one of its existing threads at once; picked in the composer, to that thread;
Refresh permissions copies it onto one thread.

### Changing the level while the bot works

You don't have to stop a bot to change its level. The native engine's tool
gate reads the level before each tool call, so a change applies from the next
call, up or down. A request already on screen stays for you to answer, and an
action already running finishes. A team change sets the level on working bots
too.

A department's sidebar menu has **Set for all bots in this department…**, for
the owner or an admin. It sets one approval level, or one model and effort,
on every bot in that department. It lists what each bot will get before
anything changes, then saves the bots one at a time with the same request and
checks as each bot's own settings. A bot that cannot take the change, or that
is working during a model change, is skipped and the summary gives the
reason. A skipped bot is not changed later: once its turn ends, run the team
change again or set that bot in its own settings. A level reaches each bot and
every one of its threads, so a thread opened with New thread moves too; a bot
is "already set" only when all of its threads are. Model changes move the
threads that use the bot's model; a thread with a model of its own keeps it,
including the one open on screen (the bot's own settings, by contrast, move
that thread with the bot).

Full access does not bypass operating system privacy controls,
authentication, CAPTCHA or MFA, service permissions,
or workspace/team ownership and computer-sharing grants. Full Access controls
approval prompts; it does not sign in for you, enable a feature you disabled,
or grant another bot access to a different workspace.

The effective setting belongs to the source conversation. An existing Ask
thread remains Ask even if the bot default is Full; a Full thread works
without these extra prompts even if the bot default is Ask. A bot nobody has
set a level on follows the default, and so does each of its threads without a
level of its own. Bots and threads that saved Ask before Full access became
the default keep it: choose Full access in the bot's settings, or **Set for
all bots in this department…**, to move a bot and every one of its threads at once.
RootClaw adds no review card of its own at any level: a bot's profile,
working folder, model, skill, team setup and team memory changes apply at
once and leave a one-line receipt with Undo, so the bot continues in the same
turn. Routine requests keep their own rule until Triggers v2 replaces them,
and on My Cloud a turn a guest or a webhook drove still waits for the owner. Invalid input, unavailable services, or failed
writes return errors, not a request to approve again. An expired
permission request is not turned into another Allow/Deny card.

A turn a webhook, a routine, or another bot started runs in the bot's level
like any other turn. The decision log records that nobody was at the keyboard
when such a turn asked.

### A Chief of Staff's level covers the work it delegates

Teammates start at Full access like every bot, but a person may have set one
lower, and switching each thread a Chief opens back up by hand was where a
team's owner spent their day. So **a Chief of Staff's level flows down**. Work
it hands out with `coordinate_bots` — into the work thread the Chief's
conversation has with a teammate, a fresh thread with `thread: "new"`, or a
thread it opened earlier, named by its id —
starts at the level of the Chief conversation it came from: Approve for me or
Full access. The teammate's thread is switched to that
level, keeps it, and opens with a line saying so ("Approve for me — delegated
by Clive, a Chief of Staff on Approve for me"); you can still change it in
that thread. Work a Chief hands out inside a room runs at the Chief's level
for that turn. It flows down every hop, not just the first: when Ada, working
for Clive, hands part of it to Bea, Bea's work runs at Clive's level too
("Approve for me — delegated by Ada, from Clive, a Chief of Staff on Approve
for me"), in threads and rooms alike. Each hand-off looks up its chain to the
nearest Chief conversation (`server/host/delegated-level.ts`). The level is
computed once when the assignment is written and recorded on it
(docs/runtime-contract.md §3); the turn runs with exactly that level.

It only ever raises: a teammate already on a higher level keeps it, and a
Chief handing work out from an Ask conversation passes nothing on. The
teammate's
own default and its other conversations do not change, and an ordinary bot's
hand-off, with no Chief up its chain, still uses the recipient's setting. A consultation (`consult: true`)
answers from what the teammate knows and acts on nothing, so no level travels
with it. Questions and missing credentials still reach you.

## Answering a request

Approve or deny requests in the conversation to let the bot continue. **Allow
once** answers this request only. **Always allow this session** keeps the
allow for that bot in that conversation, in memory until the server restarts,
and never in a guest's turn. It covers that exact tool, never "every command":
a shell grant covers one exact command line, a shell command with network
access is a separate grant from the same command without it, and a
`web_fetch` grant covers that one site. Another bot in the same room asks
again.

For a read-shaped tool from a configured custom MCP server, the card also
offers **Always allow**. This is an explicit standing grant for that exact bot,
provider instance, MCP server, tool name, and current server configuration. A
different tool still asks; editing the server command, URL, headers, or
credentials invalidates the grant. It is not offered for create/update/delete
tools, computer control, a sandbox change, an unconfigured server, or a guest's
turn. A custom MCP server controls its own tool names, so only remember tools
from a server you trust. The grant applies to the bot's current and future
conversations, including newly delegated work. Saved entries are visible and
revocable in the bot's Access settings.

The harness's own agents tools (coordinating teammates, threads, memory) never
ask: RootClaw authorizes each of those routes itself.

### Changing a bot's model

A bot keeps its level when you switch it to another model or provider: every
provider runs on the same native engine and the same tool gate.

## Asking you questions

The native engine gives every bot an `ask_user` tool. No approval level ever
answers a question for you: Ask, Approve for me and Full access all leave a
question card for a person. One call can carry up to 6 questions
(`MAX_QUESTIONS` in `shared/ask-question.ts`).

Older conversations may still hold a question a removed engine parsed out of
model-authored output rather than a real tool call. Those cards keep their
"Agent-composed question" badge, and their decision-log rows keep
`origin: output`. Flat clients (notifications, older companion builds) see
plain buttons only when a card asks a single choice question; a
multi-question card renders its structured form on current apps instead.

### Read-only integration tools

RootClaw's built-in agents MCP server describes its scoped reads with
explicit read-only, non-destructive, idempotent, closed-world metadata:
`list_bots`, `list_rooms`, `list_threads`, `assignment_status`,
`session_search`, `trigger_info`, and `skills_list`.
Session recall still enforces own-bot access and records its existing room
disclosure audit. These hints do not grant access to another bot's conversations.
Writes, credential requests, proposals, and third-party tools do not inherit
these hints. The metadata is available to every engine using this integration;
whether an engine consumes it remains that engine's behavior. Arbitrary MCP
display titles or `readOnlyHint` claims from a third-party server are not
authorization to bypass a prompt.

## Verification for contributors

```sh
pnpm exec vitest run server/auto-approve.test.ts server/drivers/chat-tool-approval.test.ts
pnpm exec vitest run server/full-access-workflows.e2e.test.ts
```

The [Full Access workflow recipe](verification/full-access.md) describes the
second run: immediate profile, routine, team, skill and peer actions through
the real server and MCP proxy, and that explicit Ask sibling threads still
wait.
