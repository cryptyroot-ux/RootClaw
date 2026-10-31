# Engine task eval

Tool-using coding tasks with automatic checkers (no model judging), run through a real native-engine turn under a
hard request budget. `basic` = the original 5 tasks; `hard` = 10 more: multi-file refactor, failing test, apply a
diff, long context with forced compaction (`compactAt`), parallel reads, offline web lookup (a loopback page server,
`ROOTCLAW_WEB_ALLOW_PRIVATE=127.0.0.0/8` for that turn only), skill use (a SKILL.md outside the folder, listed the way
the server lists skills), async bug, CLI flag, INI→JSON.

```bash
node --experimental-strip-types evals/engine-tasks/run-engine-tasks.ts --provider ollama --model beam \
  --suite hard --mode off --max-requests 40 --round-cap 12 [--models-file models.json]
# any OpenAI-compatible API:
node --experimental-strip-types evals/engine-tasks/run-engine-tasks.ts --provider openai-compat \
  --url https://openrouter.ai/api/v1 --key-env OPENROUTER_API_KEY --model <id> --suite hard --mode off
```

Reports go to `evals/reports/runs/` (gitignored), with pass/fail, rounds, tokens, provider-reported cost when given,
and the number of mid-turn compactions.

## Comparing with Claude Code or Codex

These numbers say nothing about Claude Code or Codex on their own. A fair comparison needs: the same task folders and
checkers; the same underlying model (or each tool's default, reported as such); several seeds per task; the same round
or time limit; a fresh folder per run; network rules equal for all tools; and token/cost read from each provider's
usage, not estimated. Until that has been run, no "better than" claim is supported.
