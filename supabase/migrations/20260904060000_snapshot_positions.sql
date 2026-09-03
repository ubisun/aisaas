-- What each position did, kept with the day it belongs to.
--
-- The pieces already existed and were scattered: `position_marks` holds the
-- last reading of a position, `orders` says who bought it, `strategy_ticks`
-- says which strategy that was. Assembling them at read time means three
-- queries and a join for every page view, and -- worse -- means the answer can
-- change later if the marks are overwritten or an order is amended.
--
-- So the assembly happens once, at the close, alongside the day's profit. A
-- session's detail is then a single row, and it is a record of what was true
-- that day rather than a re-derivation from tables that have moved on.
alter table equity_snapshots add column positions jsonb not null default '[]'::jsonb;

comment on column equity_snapshots.positions is
  'Per-position detail for the session: ticker, owning strategy, quantity, entry and exit price, cost and profit. Estimated from the last mark when the broker reports no fills.';
