# Context eval (native engine)

Run: 2026-10-30T15:16:32.957Z

Fake OpenAI-compatible server, scripted model, no real API quota. Request size is the server's own count (JSON chars / 4).

## budget (window 8k, enforced 8k)

| Metric | Value |
|---|---|
| Turns × tool rounds | 4 × 50 (200 rounds, 6000-byte outputs) |
| Thread survived (no fatal error) | YES (4/4 turns ok) |
| Model requests | 276 (summaries 72) |
| Max accepted request tokens | 5333 (enforced limit 8000) |
| Max request tokens incl. rejected | 5333 |
| Requests rejected as too large | 0 (recovered by forced compaction: 0) |
| Compactions | 72 |
| Tool outputs offloaded | 180 |
| read_tool_output pages ok | 20/20 |
| Fact retention | 28/28 (100%) |

## overflow (advertised 16k, enforced 8k)

| Metric | Value |
|---|---|
| Turns × tool rounds | 4 × 50 (200 rounds, 6000-byte outputs) |
| Thread survived (no fatal error) | YES (4/4 turns ok) |
| Model requests | 252 (summaries 24) |
| Max accepted request tokens | 7824 (enforced limit 8000) |
| Max request tokens incl. rejected | 8728 |
| Requests rejected as too large | 24 (recovered by forced compaction: 24) |
| Compactions | 24 |
| Tool outputs offloaded | 180 |
| read_tool_output pages ok | 20/20 |
| Fact retention | 28/28 (100%) |

**Result: PASS**
