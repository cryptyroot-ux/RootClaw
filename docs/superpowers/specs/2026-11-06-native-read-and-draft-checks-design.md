# Design: fenced native read-and-draft checks

- **Date:** 2026-11-06
- **Status:** Approved
- **Repository:** RootClaw
- **Branch:** `native-e2e-fixture-repair`

## Intent

Allow unattended `read-and-draft` routine checks to use the native OpenAI-compatible driver, so the existing watch can analyze checked mail and meetings and create an authorized reply draft. Keep all action authorization server-enforced; email and calendar content remain untrusted input.

## Current behavior and root cause

`server/host/routine-checks.ts` only queues an AI run for `read-and-draft` routines when `deps.fenced(botId)` is true. `server/host/proactive.ts` derives that value from the selected engine's `driverKind`, but `FENCED_ENGINES` is empty. Consequently, native checks read mail/calendar and produce reminders/briefs without an AI turn or check key, so the server cannot authorize a draft. The isolated E2E reproduces this behavior.

The existing `server/read-and-draft.ts` fence is allow-only: it confines the run's routes and connected-app relay, permits Gmail/Calendar reads, and authorizes a draft only for a checked thread's sender, once. It refuses send, other apps, extra recipients, wrong threads/recipients, and repeat drafts.

The native Chat MCP layer requests permission before executing a Composio tool. For the selected driver, the run handler must auto-answer only the exact multi-execute gateway request so the call reaches the existing per-call relay fence; the handler still refuses every other permission request. At the relay, the read-and-draft policy runs before generic connector-grant denials so a forbidden write remains a handled policy refusal; calls the policy allows must still pass the bot's connector grants and scopes. A draft allowance is committed only after those permissions pass and are revalidated before relay. A relay-fence refusal is a completed policy decision, not a tool execution error, so a valid final report can still be kept after an attempted out-of-policy call.

## Approaches

1. **Use the existing driver fence — selected.** Add the `openai-compat` driver kind to `FENCED_ENGINES`. All instances using that server-owned driver become eligible; every action still passes through the existing run-scoped route and connector fence. This is the smallest change and reuses the runtime boundary intended for this purpose.
2. **Per-bot opt-in.** Keep checks disabled by default and add a bot setting/API field for enabling them. This narrows activation but expands settings, persistence, and user-facing behavior beyond the confirmed request.

The selected scope assumes all configured endpoints on the `openai-compat` driver share the same RootClaw request and tool-routing enforcement; it does not trust the endpoint/provider to enforce this policy.

## Goals

- Let native `openai-compat` read-and-draft checks start the existing constrained AI run.
- Preserve no-turn behavior when no work exists, connected-app read permissions, and non-AI reminders/briefs.
- Prove through an isolated loopback E2E that one draft to the checked email sender can reach the fake connected-app service, while sends, Slack/other apps, wrong recipients, extra recipients, and duplicate drafts do not.
- Keep the read-and-draft system prompt, tool grants, route fence, record-wrapped reads, and check-key authorization intact.
- Update proactive-routine documentation and verification instructions to reflect the native provider and enforced fence.

## Non-goals and anti-goals

- Do not add a per-bot setting, new provider, or new trust level.
- Do not allow sending, replying by send, Slack or other apps, arbitrary Gmail writes, drafts outside checked threads, extra recipients, or multiple drafts for the same checked thread.
- Do not change ordinary routine permissions or the Cloud first-look fence.
- Do not simulate tool results in tests; all provider and connected-app interactions use loopback fakes in an isolated fixture.

## Constraints and acceptance

- Runtime eligibility is based on the server-selected `driverKind`, not user-controlled model text or prompt contents.
- Run with Ask-level approvals and no approval cards: the read-and-draft handler must pass only the native Composio multi-execute gateway to its per-call route fence, which refuses every out-of-policy connected-app call before generic grant denials; otherwise-allowed calls still require the bot's connector grants and scopes. The handler refuses every other out-of-policy request itself.
- Reuse `createReadAndDraft`, `RoutineChecks.mayDraft`, and the existing check key; expand runtime enforcement only if the E2E exposes a concrete gap.
- Update `server/proactive-routines.e2e.test.ts` to script calls only after inspecting the actual tools offered by the native fixture. Assert fake-app effects and refusal/decision evidence, not just model output.
- Run the focused routine, read-and-draft, and routine-checks tests; the full six Phase 5 candidate suites; lint, typecheck, locale check, and diff check. Follow `docs/verification/README.md` and use only isolated fake providers/apps.
- Review the final branch diff, commit/push it, and create a PR against the repository's default branch using its PR template. Do not merge or release.

## Implementation confirmation

The native driver emits the permission event before calling the exact Composio multi-execute tool; the handler passes only that gateway to the connector route, which checks each raw call. The loopback E2E verifies the offered schema, sender-constrained draft, refusal cases, handled refusal results, and completed report.
