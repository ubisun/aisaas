-- What the desk was worth at the end of each session.
--
-- The account summary was already being fetched at the close and put into the
-- Telegram briefing, then discarded. That made the one question the desk exists
-- to answer -- did this make money -- unanswerable, and it is also the question
-- a strategy has to pass before it is promoted to a live account.
--
-- Keyed by environment as well as date: the paper and live accounts are
-- different accounts with different balances, and a returns chart that mixed
-- them would be worse than no chart.
create table equity_snapshots (
  trade_date date not null,
  environment text not null check (environment in ('demo', 'real')),

  -- Straight from the broker at the close.
  cash_krw numeric(18, 2),
  holdings_value_krw numeric(18, 2),
  total_equity_krw numeric(18, 2),
  unrealised_pnl_krw numeric(18, 2),

  -- Worked out from the day's fills. Every position is flattened before the
  -- close, so on a normal day this is the whole result of the session.
  realised_pnl_krw numeric(18, 2),
  -- Realised profit per strategy, {"orb-v1": 12345.0}. This is what a promotion
  -- decision is made on, and it is only meaningful because a ticker belongs to
  -- exactly one strategy for the session.
  by_strategy jsonb not null default '{}'::jsonb,

  -- The capital the desk was sized against that day. Stored rather than read
  -- from config at display time, so a later change to the configured capital
  -- does not silently rewrite history's returns.
  capital_krw numeric(18, 2),

  -- The execution-inquiry response as it arrived.
  --
  -- Kept because the endpoint has never returned a filled row -- the desk has
  -- never traded -- so the field names the parser uses are from the vendor's
  -- documentation rather than from anything observed. The first real session
  -- will show whether they are right, and this is what will be read to find
  -- out without having to trade again.
  fills_raw jsonb,

  captured_at timestamptz not null default now(),
  constraint equity_snapshots_pkey primary key (trade_date, environment)
);

create index equity_snapshots_date_idx on equity_snapshots (trade_date desc);

alter table equity_snapshots enable row level security;

create policy "Signed-in users can read equity snapshots"
  on equity_snapshots for select to authenticated using (true);
