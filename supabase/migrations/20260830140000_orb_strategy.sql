-- What a stateful strategy needs to survive between ticks, and what an entry
-- needs to carry so its exit can be honoured.
--
-- Two things the desk could not previously express:
--
-- 1. A strategy that is a state machine. The opening-range strategy waits for a
--    breakout, then for a pullback, then for a confirmation candle -- three
--    ticks apart, in three separate function invocations with nothing shared
--    between them.
--
-- 2. An exit priced by the entry rather than by the house rules. The house
--    exits are a percentage of cost; this strategy's stop is the low of the
--    candle it entered on, and its target is twice that distance. Neither can
--    be recovered later from the position alone.

-- Per strategy, per ticker, for one trading day.
create table strategy_state (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id) on delete cascade,
  strategy text not null,
  ticker text not null,
  -- The state machine's position, named by the strategy that owns it. Kept as
  -- text rather than an enum: a second stateful strategy will have different
  -- states, and widening an enum for each one is a migration per idea.
  state text not null,
  -- Whatever the strategy needs to remember -- the opening range, the bar that
  -- broke out, how many attempts are left.
  detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint strategy_state_key unique (run_id, strategy, ticker)
);

create index strategy_state_run_idx on strategy_state (run_id, strategy);

alter table strategy_state enable row level security;

create policy "Signed-in users can read strategy state"
  on strategy_state for select to authenticated using (true);

-- The exit levels an entry was placed with.
--
-- Null means the house rules apply, which is what every existing order is and
-- what a strategy that has no opinion about its exit still gets. When set, the
-- risk gate closes the position at these prices instead -- the strategy still
-- cannot propose a sell, it can only say what its entry was worth risking.
alter table orders add column stop_loss numeric(14, 2);
alter table orders add column take_profit numeric(14, 2);

-- Minute bars, cached for the day.
--
-- Measured against the API before designing around it: the intraday endpoint
-- answers with thirty one-minute bars ending at the time asked for, and offers
-- no way to request more. Twenty five-minute bars is a hundred minutes, which
-- would be four calls per name per tick at 1.2s each.
--
-- So today's bars accumulate here instead. Each tick fetches only the newest
-- thirty and merges them in, which covers the five-minute gap with room to
-- spare and costs one call per name per tick however late in the session it is.
--
-- The other two kinds are fetched once a day and never change: yesterday's tail,
-- which is what lets ATR(14) and a 20-bar volume average mean anything at 09:35
-- when the session has produced seven bars, and the daily bars behind the trend
-- filter.
create table candle_cache (
  ticker text not null,
  -- KRX trading date the cache belongs to, Asia/Seoul.
  trade_date date not null,
  -- 'today1m' accumulates through the session; 'prev1m' is the previous
  -- session's tail; 'daily' is the daily series. The opening range is derived
  -- from 'today1m' rather than stored, so it cannot disagree with the bars it
  -- came from.
  kind text not null check (kind in ('today1m', 'prev1m', 'daily')),
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  constraint candle_cache_pkey primary key (ticker, trade_date, kind)
);

create index candle_cache_date_idx on candle_cache (trade_date);

alter table candle_cache enable row level security;

create policy "Signed-in users can read cached candles"
  on candle_cache for select to authenticated using (true);
