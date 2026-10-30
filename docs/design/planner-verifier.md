# Planner / verifier for the native engine (design, not implemented)

Status: phases 0–2 implemented (`server/drivers/plan-verify.ts`). Flag: `engine.planVerify` (off by default).

## 1. How the loop works today (grounding)

- `server/drivers/openai-chat.ts` runs one turn as up to `MAX_CHAT_ROUNDS = 64` rounds. Each round does request-size
  accounting, then `adapter.complete(...)` (the `ModelAdapter` contract, `server/drivers/model-adapter.ts`), then
  executes tool calls, then loops. A reply with no tool calls ends the turn.
- There is already a weak "verifier": announcement nudges (`MAX_ANNOUNCEMENT_NUDGES`, stopReason `incomplete_action`)
  and corrective rounds after tool errors (`correctiveRounds` vs `turn.toolErrorCorrectiveRounds`).
- Context: `server/drivers/turn-context.ts` estimates tokens (now exact via `server/drivers/tokenizer.ts`), compacts
  older exchanges into a `SUMMARY_TAG` message once the request passes `turnCompactBudget`, and keeps the last
  `keepExchanges` exchanges verbatim.
- Budget: `server/budget-guard.ts` `BudgetMeter` counts provider usage per round (`add` → ok/warn/stop) and
  `wouldExceed` pre-checks the next prompt; a stop is a neutral notice with stopReason `budget`.
- Failover: `server/drivers/failover.ts` (`failoverKind`) only switches model while `produced` is false, i.e. before
  any streamed text or tool call.
- Run-store: `server/run-store.ts` folds runtime events into one `RunRecord` per run (rounds, tools, usage,
  stopReason, errors).

## 2. When to plan (heuristic, never every turn)

Plan only if at least one holds, checked once before round 0:
- the user message asks for multi-step work (imperative + "and then", numbered list, ≥ 2 distinct verbs), or is long
  (> ~150 tokens) and tools are enabled;
- the turn has workspace/shell tools in scope (`WORKSPACE_TOOL_DEFINITIONS`) and the request names files or commands;
- mid-turn re-plan: the round count passes 8 without a final answer, or a corrective round fired.
Never plan for: greetings/short questions, turns with `tools: false`, routine/background turns unless their config
opts in. The heuristic is pure code (no model call) so a skipped plan costs zero tokens.

## 3. Plan shape and where it lives

- Produced by the turn's own model in round 0 via a tool `update_plan({ steps: [{ id, title, status, check? }] })`,
  status ∈ pending | doing | done | blocked; ≤ 8 steps, ≤ 120 chars each. No separate planner call.
- Stored on the turn (not in the transcript text). Rendered as one compact system message re-inserted just before the
  latest user message each round, so it is always present and never duplicated.
- Compaction: the plan message is pinned (excluded from `planCompaction` folding) and is not part of the summary.
  Its size (~150–300 tokens) is counted by `estimateRequestTokens`.
- Emitted as a runtime event (`plan.updated`) so run-store and the UI can show it later.

## 4. Verifier step

Triggered when the model proposes a final answer and a plan exists (or tools that mutate state ran):
1. Self-check (cheap): one non-streamed `adapter.complete` with the plan, the final draft and the last tool results
   (truncated to ~2k tokens) asking for `{"verdict":"pass"|"fail","missing":[...]}`. Uses `summaryModel` if set.
2. Tool-based checks (preferred when available): a step's optional `check` (e.g. "run `pnpm typecheck`", "read
   file X") is executed through the normal tool path with the same approval rules; read-only checks only.
3. On fail: append the `missing` list as a user-role nudge and continue the loop. Cap: `maxVerifyRetries` (default 1,
   max 3). After the cap, the answer is delivered with a short "unverified: …" note and stopReason
   `unverified`, never an error.
The verifier never runs before `produced`, so it does not change failover semantics.

## 5. Interaction with existing pieces

- Compaction: plan pinned; verifier prompt built from post-compaction messages; verifier's own call never compacts.
- Budget guard: before planning/verifying, `meter.wouldExceed(estimate)`; if it would, skip the step (log it)
  rather than stop the turn. Verifier usage goes through `meter.add` like any round.
- Failover: planning happens in round 0 before output, so a failing model still fails over cleanly; the plan is
  kept and handed to the next model in the chain.
- Run-store: new fields `plan?: { steps, revisions }`, `verify?: { attempts, verdict }`; stopReason `unverified`.

## 6. Cost per turn

- Skipped (most turns): 0 extra tokens.
- Planned turn: plan tool round ~300 output + ~250 input/round for the pinned plan (≈ 2–5k over a 10–20 round turn).
- Verifier: ~2.5k input + ~100 output per attempt; ≤ 2 attempts by default.
Target: ≤ 15% extra tokens on planned turns, ≈ 0 on the rest.

## 7. Measuring it (evals)

- Fixed task set (~40): multi-file edits, shell debugging, research-with-tools, plus 15 trivial turns to check the
  heuristic stays off. Run each flag-off vs flag-on, 3 seeds, through 9router `MyCombo` and one OpenAI model.
- Metrics from run-store: task success (scripted checks), rounds, tokens, cost, `incomplete_action` rate, verifier
  false-fail rate (fail verdict on a scripted pass), wall time.
- Ship gate: success +10 pts or more on multi-step tasks, ≤ 15% token overhead, no regression on trivial turns.

## 8. Rollout

1. Phase 0: run-store fields + `plan.updated` event, flag off.
2. Phase 1: `engine.planVerify: "plan"` — planning only, evals.
3. Phase 2: `"plan+verify"` — self-check verifier, cap 1.
4. Phase 3: tool-based checks; default on for workspace-tool turns only if Phase 2 gates pass.
Rollback = flag off; no data migration needed.

## 9. Open questions

- Should the plan be visible to the user live, or only in a Runs page?
- Is a separate cheaper model for the verifier worth it, given provider caching on the main model?
- Do non-OpenAI adapters (Anthropic, Gemini) follow the `update_plan` tool reliably, or need a text-format fallback?
- How should the plan survive a run retry (`POST /api/runs/:id/retry`): restore or re-plan?
- Should the existing announcement nudges merge into the verifier to avoid two overlapping checks?

## 10. Measured (9router, model MyCombo, Oct 31 2026)

Prompt: "First list the three smallest prime numbers greater than 100, then compute their sum, and finally check
the sum is correct and explain briefly." No real tools mounted (pure reasoning).

| Run | Rounds | Input / output tokens | Wall time |
|---|---|---|---|
| Flag off (baseline) | 1 | 227 / 143 | 3.4 s |
| v1: plan in system message, status-only rounds, verifier with history | 4 + 1 check | 9,069 / 980 (≈ 40× / 7×) | 73 s |
| v2 round 1 (initial plan) only; round 2 hit a 9router `fetch failed` | 1 | 4,610 / 266 | 22 s |

What v1 taught, and the v2 changes:
- The model spent 3 rounds only updating step statuses. v2 allows one update_plan-only round (the initial plan);
  with no real tool to batch with, or after a second status-only round, the tool is withdrawn and the final answer
  completes the plan. The hint tells the model to batch status changes with its next real tool call.
- The plan sat in the system message, so every update broke the provider prefix cache. v2 keeps it in one trailing
  context message, replaced in place and taken out before compaction; the system message never changes.
- The verifier sent the recent tool results (~2.4k tokens). v2 sends task + plan + answer only, truncated, with a
  200-token output cap, and skips short answers with no tools run unless the plan has 3+ steps.
- v1 also lost transport retries after a plan call (update_plan counted as a handled call); fixed in v2.

MyCombo's input counts vary a lot between identical requests (the same initial-plan round took 376 input tokens
in v1 and 4,610 in v2), so this router is too noisy to measure overhead precisely; use a fixed model for the eval set
in §7 before turning the flag on by default.

### Ollama Cloud, model `beam` (same prompt, 4 requests per run)

| Run | Rounds (input / output) | Total | Time | Result |
|---|---|---|---|---|
| Flag off | 227 / 306 | 227 / 306 | 1.3 s | correct |
| v2 plan+verify (verify gate: 3+ steps) | plan 401 / 263, answer 588 / 527, check 376 / 156 | 1,365 / 946 (4.3× tokens) | 5.9 s | pass |
| v3 (verify gate: 4+ steps or a real tool; default `engine.verifyMinSteps` 4) | plan 401 / 108, then 2 rounds of stray `update_plan` calls (433 / 200, 662 / 79) | 1,496 / 387 before the 4-request cap | 3.7 s | no answer |

v3 found a real bug: after the tool was withdrawn the model kept sending status-only `update_plan` calls
(`{"id":"1","status":"done"}`, no title), which were rejected as invalid, so it retried in a loop. Fixed: status-only
updates merge into the plan by id, and a call after withdrawal is acknowledged with "give the final answer now"
instead of failing. A turn whose final answer is accepted now records the plan as completed (open steps done, one
revision up); a check that still fails after the cap leaves them open. Not yet re-measured live after the fix.
