# Context eval (native engine)

Run: 2026-11-01T00:30:21.275Z

Fake provider servers (OpenAI chat, Anthropic Messages, Gemini, OpenAI Responses), scripted model, no real API quota.
Request size is the server's own count (JSON chars / 4); OpenAI, Anthropic and Responses refuse input + max output over the limit; each refusal uses that provider's own wording.

## ctx-budget: budget (window 8k, enforced 8k)

| Metric | Value |
|---|---|
| Wire | openai |
| Turns × tool rounds | 4 × 50 (200 rounds, 6000-byte outputs) |
| Thread survived (no fatal error) | YES (4/4 turns ok) |
| Model requests | 248 (summaries 44) |
| Max accepted request tokens | 4621 (enforced limit 8000) |
| Max request tokens incl. rejected | 4621 |
| Requests rejected as too large | 0 (forced overflow compactions: 0) |
| Cumulative accepted input | 644977 tokens (80.6× enforced limit) |
| Pairing violations (orphan result or unanswered call) | 0 |
| Input + max output over limit (after learning) | 0 |
| Compactions | 44 |
| Outputs or messages offloaded | 180 |
| read_tool_output pages ok | 20/20 |
| Fact retention | 28/28 (100%) |
| Scenario | PASS |

## ctx-overflow: overflow (advertised 16k, enforced 8k)

| Metric | Value |
|---|---|
| Wire | openai |
| Turns × tool rounds | 4 × 50 (200 rounds, 6000-byte outputs) |
| Thread survived (no fatal error) | YES (4/4 turns ok) |
| Model requests | 248 (summaries 43) |
| Max accepted request tokens | 6164 (enforced limit 8000) |
| Max request tokens incl. rejected | 7106 |
| Requests rejected as too large | 1 (forced overflow compactions: 1) |
| Cumulative accepted input | 651747 tokens (81.5× enforced limit) |
| Pairing violations (orphan result or unanswered call) | 0 |
| Input + max output over limit (after learning) | 0 |
| Compactions | 43 |
| Outputs or messages offloaded | 180 |
| read_tool_output pages ok | 20/20 |
| Fact retention | 28/28 (100%) |
| Scenario | PASS |

## ctx-giant-paste: giant paste (3× window user message, enforced 8k)

| Metric | Value |
|---|---|
| Wire | openai |
| User message | 24000 tokens (3× enforced limit), fact planted mid-paste |
| Thread survived (no fatal error) | YES (1/1 turns ok) |
| Model requests | 9 (summaries 3) |
| Max accepted request tokens | 5019 (enforced limit 8000) |
| Max request tokens incl. rejected | 5019 |
| Requests rejected as too large | 0 (forced overflow compactions: 0) |
| Cumulative accepted input | 32663 tokens (4.1× enforced limit) |
| Pairing violations (orphan result or unanswered call) | 0 |
| Input + max output over limit (after learning) | 0 |
| Compactions | 3 |
| Outputs or messages offloaded | 6 |
| read_tool_output pages ok | 5/5 |
| Request kept head, tail and handle (middle omitted) | YES |
| Fact retention | 1/1 (100%) |
| Scenario | PASS |

## ctx-wire-openai: OpenAI chat wire (advertised 16k, enforced 8k)

| Metric | Value |
|---|---|
| Wire | openai |
| Turns × tool rounds | 2 × 30 (60 rounds, 6000-byte outputs) |
| Thread survived (no fatal error) | YES (2/2 turns ok) |
| Model requests | 75 (summaries 12) |
| Max accepted request tokens | 6164 (enforced limit 8000) |
| Max request tokens incl. rejected | 7106 |
| Requests rejected as too large | 1 (forced overflow compactions: 1) |
| Cumulative accepted input | 196749 tokens (24.6× enforced limit) |
| Pairing violations (orphan result or unanswered call) | 0 |
| Input + max output over limit (after learning) | 0 |
| Compactions | 12 |
| Outputs or messages offloaded | 54 |
| read_tool_output pages ok | 6/6 |
| Fact retention | 10/10 (100%) |
| Scenario | PASS |

## ctx-wire-anthropic: Anthropic Messages wire (unknown window, enforced 8k)

| Metric | Value |
|---|---|
| Wire | anthropic |
| Turns × tool rounds | 2 × 30 (60 rounds, 6000-byte outputs) |
| Thread survived (no fatal error) | YES (2/2 turns ok) |
| Model requests | 75 (summaries 12) |
| Max accepted request tokens | 4587 (enforced limit 8000) |
| Max request tokens incl. rejected | 4587 |
| Requests rejected as too large | 1 (forced overflow compactions: 0) |
| Cumulative accepted input | 188252 tokens (23.5× enforced limit) |
| Pairing violations (orphan result or unanswered call) | 0 |
| Input + max output over limit (after learning) | 0 |
| Compactions | 12 |
| Outputs or messages offloaded | 54 |
| read_tool_output pages ok | 6/6 |
| Fact retention | 10/10 (100%) |
| Scenario | PASS |

## ctx-wire-gemini: Gemini wire (unknown window, enforced 8k)

| Metric | Value |
|---|---|
| Wire | gemini |
| Turns × tool rounds | 2 × 30 (60 rounds, 6000-byte outputs) |
| Thread survived (no fatal error) | YES (2/2 turns ok) |
| Model requests | 74 (summaries 11) |
| Max accepted request tokens | 7063 (enforced limit 8000) |
| Max request tokens incl. rejected | 8012 |
| Requests rejected as too large | 1 (forced overflow compactions: 1) |
| Cumulative accepted input | 198771 tokens (24.8× enforced limit) |
| Pairing violations (orphan result or unanswered call) | 0 |
| Input + max output over limit (after learning) | 0 |
| Compactions | 11 |
| Outputs or messages offloaded | 54 |
| read_tool_output pages ok | 6/6 |
| Fact retention | 10/10 (100%) |
| Scenario | PASS |

## ctx-wire-responses: OpenAI Responses wire (unknown window, enforced 8k, refusal names no limit)

| Metric | Value |
|---|---|
| Wire | responses |
| Turns × tool rounds | 2 × 30 (60 rounds, 6000-byte outputs) |
| Thread survived (no fatal error) | YES (2/2 turns ok) |
| Model requests | 74 (summaries 11) |
| Max accepted request tokens | 7964 (enforced limit 8000) |
| Max request tokens incl. rejected | 8894 |
| Requests rejected as too large | 1 (forced overflow compactions: 1) |
| Cumulative accepted input | 201859 tokens (25.2× enforced limit) |
| Pairing violations (orphan result or unanswered call) | 0 |
| Input + max output over limit (after learning) | 0 |
| Compactions | 11 |
| Outputs or messages offloaded | 54 |
| read_tool_output pages ok | 6/6 |
| Fact retention | 10/10 (100%) |
| Scenario | PASS |

## ctx-long-thread: long thread (24 turns, transcript carried, enforced 8k)

| Metric | Value |
|---|---|
| Wire | openai |
| Turns × tool rounds | 24 × 12 (288 rounds, 6000-byte outputs, transcript carried) |
| Thread survived (no fatal error) | YES (24/24 turns ok) |
| Model requests | 373 (summaries 60) |
| Max accepted request tokens | 6164 (enforced limit 8000) |
| Max request tokens incl. rejected | 7106 |
| Requests rejected as too large | 1 (forced overflow compactions: 1) |
| Cumulative accepted input | 975101 tokens (121.9× enforced limit) |
| Pairing violations (orphan result or unanswered call) | 0 |
| Input + max output over limit (after learning) | 0 |
| Compactions | 60 |
| Outputs or messages offloaded | 264 |
| read_tool_output pages ok | 24/24 |
| Fact retention | 48/48 (100%) |
| Scenario | PASS |

**Result: PASS**
