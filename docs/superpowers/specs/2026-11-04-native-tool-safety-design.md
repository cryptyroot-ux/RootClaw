# Native Tool Dispatch and Diagnostic Command Safety

## Intent

Close the two RootClaw P0 gaps identified in the 2026-11-04 audit: a native tool call must not bypass its turn's `toolScope`, and untrusted arguments to `network_tool` or `process_tool` must not become shell syntax. This hardens the existing RootClaw engine without creating a new project or removing these tools.

## Goals

- Enforce native tool scope at dispatch time, including calls the model returns even when the tool was not offered.
- Preserve normal validation, approval, safety-floor, and refusal behavior for allowed native calls.
- Execute host diagnostics with argument vectors rather than `/bin/bash -c`.
- For the computer-exec backend, encode each dynamic argument as one literal shell argument because that interface accepts a command string.
- Add regression tests for denied native dispatch and shell metacharacters in diagnostic inputs.

## Non-goals

- Rebuild all native tools behind a new execution broker.
- Claim complete OS sandboxing for host diagnostics or change their network reachability.
- Redesign approval policy, provider contracts, durable recovery, compaction, or other audit findings.

## Constraints

- RootClaw remains the existing product and repository.
- Keep `network_tool` and `process_tool` available and retain current approval semantics.
- No new dependency unless the existing code cannot safely express the required argument handling.
- The fix must cover both host execution and the computer-exec command-string path.

## Approaches

1. **Incremental boundary fixes (selected):** add a second scope check immediately before native provider validation/execution; use direct process arguments on the host and safe per-argument quoting for the computer-exec command string. This preserves features while closing the demonstrated bypasses.
2. **Disable host diagnostics:** remove or refuse these tools when they would run on the host, while fixing dispatch scope. This reduces exposure but removes functionality and leaves injection risks in the computer-exec path.
3. **Unified execution broker:** route every native tool through a new scope/approval/environment/sandbox broker. This could provide a broader boundary, but is substantially wider than the two reproduced defects and would delay the targeted fix.

## Acceptance criteria

- A native provider call denied by `toolScope` is refused before provider validation or execution, even if the model returns its name directly.
- An allowed native call still passes through the existing validation, approval, safety-floor, and execution flow.
- Host `network_tool` and `process_tool` invocations do not use a shell to parse dynamic arguments.
- Computer-exec commands preserve each dynamic value as a single argument; inputs containing quotes, whitespace, `$()`, backticks, semicolons, and pipes cannot execute extra commands.
- Tests exercise both denied dispatch and diagnostic argument handling on the relevant backend paths.

## Builder decisions

Choose the smallest local helper/interface that safely quotes command arguments for the existing computer-exec protocol, and place regression tests beside the existing native driver tests. Avoid broad refactors; keep the dispatch guard adjacent to native provider dispatch so future providers inherit the enforcement point.
