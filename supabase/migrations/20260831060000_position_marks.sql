-- The last thing known about a position before it disappeared.
--
-- The paper environment does not populate the execution inquiry: an order that
-- demonstrably filled -- the balance showed the shares -- returns "조회할 내역이
-- 없습니다" from `inquire-daily-ccld`. So on the paper account there is no way
-- to learn what a position sold for, and per-strategy profit, which is the
-- whole basis for promoting a strategy, cannot be computed from fills.
--
-- The balance does say what a position is worth while it is held. Because a
-- ticker is bought once a day and flattened before the close, the last reading
-- before it vanishes is that position's result, give or take the slippage
-- between that tick and the fill, and the fees.
--
-- One row per position per session, overwritten each tick, so this is at most a
-- handful of rows a day rather than a time series.
create table position_marks (
  run_id uuid not null references runs (id) on delete cascade,
  ticker text not null,
  -- Whatever the balance last said.
  quantity integer not null,
  average_price numeric(14, 2) not null,
  current_price numeric(14, 2) not null,
  -- Unrealised in KRW at that moment: the estimate of what this position made.
  pnl_krw numeric(18, 2) not null,
  observed_at timestamptz not null default now(),
  constraint position_marks_pkey primary key (run_id, ticker)
);

alter table position_marks enable row level security;

create policy "Signed-in users can read position marks"
  on position_marks for select to authenticated using (true);

-- Separate the measured from the estimated, so nobody later reads one as the
-- other. `realised_pnl_krw` is per-strategy arithmetic; `account_realised_krw`
-- is the broker's own figure for the account and is exact.
alter table equity_snapshots add column account_realised_krw numeric(18, 2);
alter table equity_snapshots add column bought_krw numeric(18, 2);
alter table equity_snapshots add column sold_krw numeric(18, 2);
alter table equity_snapshots add column charges_krw numeric(18, 2);
-- 'fills' when the execution inquiry answered, 'marks' when it was empty and
-- the estimate was used, 'none' when there was nothing to attribute.
alter table equity_snapshots add column attribution_source text;
-- What the per-strategy numbers do not account for: fees, slippage between the
-- last mark and the fill, and anything the estimate simply missed. Watching
-- this is how the estimate's error stays visible instead of being absorbed.
alter table equity_snapshots add column unattributed_krw numeric(18, 2);
