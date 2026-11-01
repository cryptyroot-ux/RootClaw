# Conversation context compaction

Long direct conversations can summarize older exchanges before the next turn.
The full transcript, its branches and attachments are retained. The new session
gets a bounded summary plus recent exchanges; later turns resume that session.
A visible, expandable note explains what was summarized, even with tool chips off;
when no model wrote the summary, it says the agent continues from recent excerpts only.

## Exercise the real path

```sh
pnpm exec vitest run server/context-compaction.e2e.test.ts
pnpm exec vitest run server/context-rebuild.test.ts server/compaction-summary.test.ts server/context-budget.test.ts server/delta-context.e2e.test.ts
pnpm exec vitest run server/side-jobs.test.ts server/helper-model.e2e.test.ts
pnpm exec vitest run server/store.test.ts server/config.test.ts src/components/DigestChip.test.ts
pnpm test:packaged-server
```

The API fixture launches the shared isolated server and fake engine. It uses
`control-rootclaw` for create, send, wait, edit and Stop. Its new manual operation is
`POST /api/bots/:id/compact` with `{ "threadId": "owned-thread-id" }`; this uses
normal turn admission, returns 202, and completes through that thread's ordinary
busy/idle state. The route accepts no agent-written summary or file path.
From 80% of a known window, the bot's 1:1 header shows the figure with a
**Compact now** button that calls this route (hidden again once a compaction
record is newer than the last reply).

## Rooms

A room turn resumes no stored session: every turn re-sends the room's
bounded recent transcript (but see Room sessions below). What grows is the
warm provider process a driver keeps between one bot's consecutive turns in
a room (Claude's idle reuse).
Each settled room turn records that bot's last measured prompt for the room's
thread (in memory, like the warm process itself) and the room wire carries it
as `memberContext`. From 80% the roster avatar gets a mark and a line under
the header offers **Compact now**: `POST /api/groups/:id/members/:botId/compact`
(202; 409 before a reading, 404 for a non-member). It runs nothing; the bot's
next turn in that room starts with the existing `sessionReset`, so a fresh
provider session gets the same bounded transcript every turn gets. Before a
room turn, a bot at or above `context.roomCompactAt` (default `0.9`, read like
`compactAt`) is compacted the same way without asking; `autoCompact: false`
turns that off, but not the button. Either way the room shows an activity line.
A reading lives only as long as the warm process it measures: it is dropped
when another member's turn dispatches on the same engine in that thread (the
driver replaces the thread's one warm process), and once it is older than the
session idle window or the thread's keep-warm hold, whichever ends later.

```sh
pnpm exec vitest run server/room-context.e2e.test.ts server/room-context.test.ts src/lib/context-warning.test.ts
```

The fixture proves a warm process is kept below the threshold or with
automatic compaction off, and replaced after Compact now and above 90%, and
that another member's turn replaces a bot's process and clears its warning.

## ACP agents' own readings

An ACP agent reports how full its context is (`usage_update`: `used`, and the
window as `size` when it sends one). A 1:1 conversation shows those figures,
and they are for the meter only: the ACP driver marks its reading
`contextReading: "meter"`, so the fold before a 1:1 turn is still timed from
the transcript estimate and the model's window, and a room keeps no reading
for an ACP member (no mark, no automatic fresh session, 409 from the room's
Compact now). The 1:1 header's warning and its button follow the shown figure.

```sh
pnpm exec vitest run server/context-budget.test.ts
```

The fixture runs each 1:1 scenario twice, with the fake agent silent and with
it reporting, and requires the same compaction at the same turns: a 95% report
folds nothing at the default threshold, a near-empty report does not postpone
a fold the transcript has reached, and a room member reporting 95% keeps its
session.

Evidence covers:

- Automatic compaction keeps the two latest exchanges and the incoming request.
- A completed turn retains the driver's latest-prompt measurement, separately from summed input tokens.
- Claude compaction leaves headroom before the selected account's numeric native threshold, including after a previous compaction; `auto` and `off` do not invent a numeric native limit.
- Manual compaction executes no additional agent turn and retains the original messages.
- A repeated request at the same compacted tip is a no-op.
- Restart before the next send retains the summary and replaces the native session once.
- A later send keeps that replacement session instead of injecting the summary again.
- Editing an old message replays its selected branch, not the abandoned summary.
- Stop aborts a hanging helper without a late record; a new send still works.
- With the `helper` setting naming an instance, a bot on an engine with no tool-free one-shot for the summary (the fake Pi and the fake Codex) gets a model-written summary from that instance, booked as a helper call; without the setting, or with the bot switched to never use the helper, the Pi bot keeps the excerpt summary.
- Private session bookkeeping stays off the task wire shape; stored summaries redact secrets.

Each API fixture retains exact requests, waits and bounded transcripts in
`<server-log>.context.json`, prints that location, and closes its exact child and
temporary home. No live account, computer or user workspace is touched.

## Tool history in a rebuilt session

A session rebuilt from the inline replay (an engine switched in mid-thread, a
rewind, a session the provider lost, a compaction) is sent what was said. With
`context.replayToolHistory: true` in config.json, or `ROOTCLAW_REPLAY_TOOL_HISTORY=1`
in the server's environment (`0` forces it off), that replay also names each
earlier tool call on one line, between the two messages it ran between, as
`[ran: Bash: pnpm test — failed]` or `[ran: Read: server/config.ts — ok]`. It is
off by default, and off the replay is byte-for-byte what it was.

```sh
pnpm exec vitest run server/replay-tool-history.e2e.test.ts
pnpm exec vitest run server/context-rebuild.test.ts server/replay-settings.test.ts server/turn-context.test.ts server/config.test.ts
```

The fixture's engine runs a command and reads a file each turn. The test rewinds
with `control-rootclaw edit` and reads the prompt the engine received: no such line
while the setting is off, both lines in order once it is on (the command, and
the file read), and the plain message for every turn that resumes its session.
It then switches the bot to the fixture's Codex and reads what that engine was
sent: the lines for each of Claude's turns. Its evidence is
`<server-log>.replay-tools.json`.

A line shows the tool, what it acted on and `ok`, `failed` or `no result
recorded`. What it acted on is the command beside the chip in the chat, or, for
a call whose chip shows none (a `Read`, a search), one argument from the input
preview behind the chip: the command, file, search pattern or query. A web
address is cut to its scheme and host (`https://hooks.example.com`), wherever it
is the whole target, so no path, query string or password in it is sent. An
input that is one plain string (a Codex web search's query) is used only when it
is a single line of at most 200 characters. Never a tool result, and nothing
else of the preview (a `Write`'s content, an `Edit`'s old and new text).

Each line is put on one line, redacted, cleared of anything that would open a
harness note (`escapeNotes` in `server/peer-provenance.ts`), then clipped to 120
characters; a long path keeps its end. At most 20 lines are sent, the most
recent, only for calls between the first and last replayed message, and only
from the bytes of `rebuildBytes` that messages left unused: the messages
selected are the same with the setting on or off. Engines that replay natively
(API models sent the transcript itself) and room turns are unchanged. A call is
still named without a target when its preview is arguments that hold none of
those at the top level. A URL inside a command is left as the command ran.

## API models on the native loop

API-key models (OpenAI-compatible endpoints, Anthropic Messages, Gemini, OpenAI
Responses) run on RootClaw's own loop, which keeps each request under the model's
window itself:

- The window comes from what the provider reports, then the catalog, then a
  registry of known families (DeepSeek, Qwen, Kimi, GLM, Llama, Gemma, gpt-oss,
  Mistral). An unknown model gets the default and is marked estimated.
- A refusal that names the limit (OpenAI and vLLM "maximum context length is N",
  Anthropic "N tokens > M maximum" and "input length and `max_tokens` exceed
  context limit: A + B > C", Gemini "maximum number of tokens allowed (N)",
  llama.cpp "available context size (N tokens)") teaches that instance and model
  the real window: the round is compacted and resent, and later rounds and turns
  fit it. When the input alone already fits the learned window (only the reply
  ceiling was refused), the same request is resent with a lower ceiling. A context
  refusal with no number (OpenAI Responses) lowers the window to
  `min(0.9 × refused, max(largest accepted, 0.75 × refused))`, both counted in the
  provider's own tokens (the estimate scaled by its last reported ratio, plus the
  ceiling sent). A later accepted request larger than the learned window raises it
  again. A learned window never exceeds the declared one and lives in memory until
  restart.
- The input budget leaves room for the reply: `min(8192, W/8)` plus a 1% margin.
  When less room is left, `max_tokens` (`max_output_tokens`, `maxOutputTokens`)
  is lowered so input plus output stays within the window, never below
  `max(256, reserve / 4)`: under that, the turn compacts and shortens the pasted
  message first, and fails with the request-too-large message if it still does
  not fit. The compaction summary request carries `max_tokens` too, capped at the
  reserve.
- A fold is skipped (no summary request) when it would free under a tenth of the
  budget, when the turn grew by less than a quarter of the budget since the last
  fold, or, below the hard limit, when the newest exchange alone (before any
  summary) is over the budget.
- When the newest exchange alone is too large to send (for example one round of
  several tool results, each under the offload threshold), the turn does not ask
  for a summary. With tool-output offload on, it saves the largest of those
  results in full, the same way it saves a large tool output, and keeps a head and
  tail preview with a handle for `read_tool_output`. Then it sends once. If that
  still does not fit, or offload is off, the turn fails with the request-too-large
  message. A turn pays for at most two summaries caused by an overflow (a refusal,
  or a request over the hard limit). After that it shortens without a summary or
  fails cleanly (`server/drivers/tail-overflow.test.ts`). Only text tool results
  are saved this way. A multimodal tool result (an array with image or other
  parts) in the newest exchange is not offloaded, so a turn whose newest exchange
  is too large because of one still fails cleanly with the request-too-large
  message.
- The pinned plan (planner on) counts in every size check: compaction, tail
  offload, shortening a pasted message, and the window check. It is taken out
  while older steps are folded and pinned again after, so it is never summarized
  (`server/drivers/cut01-review.test.ts`). A summary call cut off by an abort
  ends the turn as aborted; only a failed summary call falls back to the
  deterministic summary.
- A user message is shortened only when the request is still over the budget
  after compaction; it keeps as much head and tail as the budget allows, and the
  middle is saved like a large tool output, with a handle the model pages through
  with `read_tool_output`. A later cut starts again from the original, so the
  saved copy is always the whole message. This needs tool-output offload on.
- Between turns, `compactConversation` sizes the thread with the model's
  tokenizer and the learned calibration, against the learned window, instead of
  bytes / 4.

```sh
pnpm exec vitest run server/model-context-window-families.test.ts server/drivers/context-learned-window.test.ts server/drivers/output-reserve.test.ts server/thread-compaction-tokens.test.ts server/drivers/request-fit.test.ts server/drivers/compaction-thrash.test.ts server/drivers/cut01-lock.test.ts server/drivers/tail-overflow.test.ts server/drivers/cut01-review.test.ts server/context-budget.test.ts
npm run eval:context
```

The eval drives the real driver for each wire against a fake provider that
enforces an 8k limit and refuses in that provider's own words (OpenAI, Anthropic
and Responses also refuse input plus `max_tokens` over the limit), with a scripted
model and planted facts. It writes `evals/reports/context-eval.md`: per scenario,
requests refused, largest accepted request against the limit, requests whose input
plus max output went over the limit after the first refusal (must be 0), pairing violations
(a tool result without its call, or a call without its result, in any request),
cumulative input and fact retention. `ctx-giant-paste` sends a user message three
times the limit with a fact in its middle; `ctx-long-thread` runs 24 turns with
the transcript carried, past 50 times the limit in total input. No real API is
called.

## Bounds and limitations

`context` settings in config.json are optional. `autoCompact: false` disables
automatic folding, `compactAt` is a fraction below 1 or a token count, and
`rebuildBytes` controls replay size (default 24,000 bytes). Context-only settings
do not reload provider processes. The default threshold is 80% of the known
model window; a real latest-prompt measurement wins over a transcript estimate,
except an ACP agent's own reading, which is shown and does not time compaction.
Summed input tokens across tool rounds are never treated as context size.
For Claude, the threshold and post-compaction regrowth floor also leave 10%
headroom below the selected account's numeric native-compaction setting.
That account's setting takes precedence over the inherited launch environment.
Native `auto`/`off` settings supply no known numeric bound; other engines keep
their own model-window threshold. The native CLI setting itself is unchanged.

The selected account's tool-free helper can produce a historical summary, with
a 20-second timeout and source-labelled fallback when unavailable. Summaries
are capped at 6,000 bytes and retain recent source corrections. The helper may
incur provider usage; its one-shot cost is not separately reported by the current
provider interface. Summaries are not verified facts and can omit details.

An engine with no tool-free helper for the summary (Pi and Muse Code, which have
none at all, and Codex and the ACP engines, whose one-shot starts a whole agent
process and is kept for background work) keeps the source-labelled fallback
unless a helper model is set ([the memory guide](../memory.md), "The helper
model"). That instance then writes the summary under the same 20-second timeout
and fallback, and its call is one usage row with the trigger `helper`. A bot
switched to never use the helper (`helperModel: false`) keeps the fallback.
`server/helper-model.e2e.test.ts` boots its own server in a throwaway home with
the fake Claude, Codex and Pi engines, once with the setting and once without.

This slice covers direct threads. It does not add channel compaction, change
provider-native compaction, prove live-model summary quality, or ship native
iOS/Android compaction controls. The renderer test checks note markup and escaping,
not a real browser click. Native mobile indicators remain separate PR work.
