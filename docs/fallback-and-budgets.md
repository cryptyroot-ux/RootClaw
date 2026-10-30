# Native engine: fallback chain and budget guard

## Fallback chain

Each bot's **Backup AIs** (bot panel → Model, saved as `bot.fallback`) form an ordered chain of engine instances.
A native (OpenAI-compatible) turn moves to the next usable entry only when it failed **before anything reached the
person** and was not stopped by them:

| Failure (after `retry.ts` gives up)                  | Hold on the failed entry                         |
|------------------------------------------------------|--------------------------------------------------|
| 429 that names quota/billing (`insufficient_quota`)  | whole engine, until its reset (or ~1 h guessed)  |
| persistent 5xx / 429 rate limit / network            | that model, 10 min                               |
| model not found (404 / "unknown model")              | that model, 6 h                                  |
| request too large after emergency compaction         | that model, 10 min                               |
| 401/403                                              | signed-out path (backups the person chose)       |
| 400/422, aborts, failures after output streamed      | none: never switches                             |

The person's message is resent on the backup with one notice. Holds persist in `limit-holds.json` /
`limit-takeover-holds.json`; the move persists in `limit-failovers.json`, and the conversation returns to its own engine
before the next turn once the hold has passed. Any other engine instance may be a chain entry (no per-driver lists).

## Budget guard (`settings.json` → `budgets`)

```json
{
  "budgets": {
    "monthlyUsd": 50,
    "warnAtPercent": 80,
    "turn":  { "tokens": 200000, "usd": 0.50 },
    "daily": { "tokens": 2000000, "usd": 5 },
    "bots": { "<botId>": { "turn": { "usd": 0.20 }, "daily": { "tokens": 500000 } } }
  }
}
```

- `turn` / `daily`: global caps, all bots together; `bots[botId]` adds tighter caps for one bot. Each cap may set
  `tokens`, `usd`, or both. The tightest remaining allowance wins.
- `daily` counts the usage ledger since local midnight (host time zone).
- USD uses the provider-reported usage priced by `billing.prices` or the built-in list price table; a model with no
  price is held to its token caps only.
- `warnAtPercent` (default 80): one notice in the conversation when a turn crosses it.
- At 100% a turn that wants another round stops cleanly (`stopReason: "budget"`, ok). The conversation shows a
  neutral notice naming the cap, not an error, and the fallback chain does not take over. A final answer
  that already arrived still lands. A turn whose daily allowance is already used up is refused at start (HTTP 409,
  `budget_cap`).
- `monthlyUsd` is the older workspace cap, enforced only with the `budgets` entitlement.
