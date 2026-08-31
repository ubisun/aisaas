# The gate

`npm test` must pass before anything merges.

It runs in about a second, needs no Docker, no credentials and no network. That
is a deliberate constraint rather than a happy accident: a gate that needs
setting up is a gate that gets skipped, and a skipped gate is worse than none
because it is still believed in.

```bash
npm test          # the gate
npm run test:watch
```

## How it is organised

By department, because that is how the company is organised and how work
arrives.

```
tests/
  helpers/builders.ts   shapes the desk passes around, with sane defaults
  shared/               roster, notifications, model cost
  market-report/        session dates, staleness
  strategy/             the cycle key
  trading/              the desk — see below
```

`trading/` is the one that gets the care:

| File | What it holds to account |
|---|---|
| `invariants.test.ts` | The desk's promises, against hostile input. **Read this first.** |
| `risk-entries.test.ts` | Every reason a buy is refused |
| `risk-exits.test.ts` | Exits are generated, and never blocked by a risk control |
| `live-account-lock.test.ts` | The live account is unreachable |
| `schedule.test.ts` | The session clock, the calendar, capital and its ceiling |
| `candles.test.ts` | Bars, the opening range, the indicators |
| `orb.test.ts` | The opening-range strategy's decisions |
| `attribution.test.ts` | Who owned what, and what it made |

## Adding to it

**A new strategy.** Add `trading/strategies/<name>.test.ts` for its own
decisions — its predicates, its sizing, whatever it is that makes it different.

Do **not** add cases to `invariants.test.ts` for it. Those run against
generated proposals rather than against a particular strategy, so a new
strategy is covered by construction. That is the point: the gate does not need
to know what the strategy is trying to do in order to stop it doing something
forbidden.

**A new department.** Add a folder named after it. Test what is pure first —
date rules, thresholds, anything that decides. Reach for the database only when
the logic genuinely lives in a query.

**A new promise the desk makes.** That belongs in `invariants.test.ts`, and it
is the only reason to edit that file.

**A bug found in production.** Write the failing test first, in the file where
the rule lives. Every bug found on 2026-08-30 was in a pure function — the loss
limit that also blocked stop-losses, the position cap that counted the whole
account, sizing that computed a risk budget and discarded it, an opening range
that mixed in the previous session. All four would have been caught here.

## Conventions

- **Name the promise, not the function.** `refuses a ticker another strategy
  has already bought`, not `screenEntries denies claimed`. The failure output is
  read by someone who did not write the code.
- **Use the builders.** A test about the order ceiling should not have to invent
  a market capitalisation. When a type gains a field, tests that do not care
  keep compiling.
- **Assert the reason, not only the refusal.** A gate that refuses for the wrong
  reason is a gate whose next change will be wrong too.
- **Pass an explicit time.** Every date-sensitive function takes `at`. The
  suite pins `TZ=UTC` so a machine in Seoul cannot make a broken one pass.
- **Do not assert today's roster.** Which departments are on duty changes; the
  mechanism does not.

## What this does not cover

Deliberately, so nobody mistakes a pass for more than it is:

- **Network calls.** Nothing here talks to Korea Investment, Finnhub, Anthropic
  or Telegram. Vendor contracts are verified against the real API and written
  up in the commit that adds them — including negative controls, since an
  endpoint that rejects a bogus transaction id is the only proof a valid one
  was checked at all.
- **Database queries.** `claimRun`'s stale recovery, `reconcileFills` and the
  approval flow run against Postgres. They were verified by seeding the local
  stack; making that repeatable is the next thing worth doing.
- **The ORB state machine end to end.** The predicates are covered; the
  transitions between ticks need the database.
- **Whether a strategy makes money.** That is what `/performance` is for.
