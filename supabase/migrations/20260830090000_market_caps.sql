-- Market capitalisation, cached for the day.
--
-- The candidate screen needs one number the turnover ranking does not carry:
-- market cap, without which "traded value against size" cannot be computed.
-- Getting it costs one quote call per ticker, and the paper environment forces
-- a 1.2s gap between calls, so screening fifteen names takes about nineteen
-- seconds. That was affordable once a day and is not affordable every five
-- minutes.
--
-- Market cap does not move intraday in any way this screen cares about -- the
-- share count is fixed and the price moves are small next to the 1% threshold
-- -- so it is fetched once per ticker per trading day and read from here after
-- that. A re-screen then costs a single ranking call.
--
-- Keyed by trade date rather than kept indefinitely: a stale cap would quietly
-- distort the ratio the whole screen rests on, and a row that must be re-earned
-- each morning cannot go stale.

create table market_caps (
  ticker text not null,
  -- KRX trading date, Asia/Seoul.
  trade_date date not null,
  name text not null,
  -- As KIS reports it, in 억원.
  market_cap_eok numeric not null,
  fetched_at timestamptz not null default now(),
  constraint market_caps_pkey primary key (ticker, trade_date)
);

create index market_caps_date_idx on market_caps (trade_date);

alter table market_caps enable row level security;

create policy "Signed-in users can read market caps"
  on market_caps for select to authenticated using (true);
