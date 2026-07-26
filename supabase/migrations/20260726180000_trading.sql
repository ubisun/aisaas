-- Morning day-trading against the Korea Investment paper account.
--
-- The trading morning itself is a row in `runs` (team 'trading'); everything
-- here hangs off that run. Only the parts that are genuinely specific to
-- trading get their own tables.
--
-- The shape is built around one constraint: a trading decision has no oracle
-- at the moment it is made. Every input, every proposal and every rejection is
-- recorded, because that log is the only thing that makes a later strategy --
-- a human's idea, say -- testable against what actually happened.

create type order_side as enum ('buy', 'sell');

create type order_status as enum (
  'proposed',     -- a strategy asked for it
  'rejected',     -- the risk gate refused it; never sent
  'submitted',    -- accepted by Korea Investment
  'filled',
  'cancelled',
  'failed'        -- rejected by Korea Investment
);

-- Stocks in scope for the day, chosen from early-session turnover and the
-- report's sector view. The reason is stored so a later review can tell why
-- something was in scope at all.
create table trade_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id) on delete cascade,
  ticker text not null,
  name text not null,
  sector text,
  turnover_rank integer,
  selection jsonb not null default '{}'::jsonb,
  rationale text,
  created_at timestamptz not null default now(),
  constraint trade_candidates_run_ticker_key unique (run_id, ticker)
);

-- One row per decision point inside the window. `snapshot` holds the market
-- data the strategy actually saw, which is what makes replay possible.
create table strategy_ticks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id) on delete cascade,
  strategy text not null,
  observed_at timestamptz not null default now(),
  snapshot jsonb not null,
  -- What the strategy said and why, before the risk gate saw it.
  proposals jsonb not null default '[]'::jsonb,
  reasoning text
);

create index strategy_ticks_run_idx on strategy_ticks (run_id, observed_at);

create table orders (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id) on delete cascade,
  tick_id uuid references strategy_ticks (id) on delete set null,
  -- Recorded per order rather than per session: this is the field that says
  -- whether real money moved, and it should be impossible to misread.
  environment text not null check (environment in ('demo', 'real')),
  ticker text not null,
  side order_side not null,
  quantity integer not null check (quantity > 0),
  -- Null for market orders.
  limit_price numeric(14, 2),
  status order_status not null default 'proposed',
  -- Populated when the risk gate refuses; the reason is the point of the row.
  rejected_reason text,
  kis_order_no text,
  kis_response jsonb,
  filled_quantity integer not null default 0,
  filled_price numeric(14, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index orders_run_idx on orders (run_id, created_at);
create index orders_status_idx on orders (status);

-- The Korea Investment access token outlives a single function invocation and
-- its issuance is rate limited, so it is cached rather than re-requested per
-- call. RLS is enabled with no policy at all: only the service role reaches it.
create table kis_tokens (
  environment text primary key check (environment in ('demo', 'real')),
  access_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table trade_candidates enable row level security;
alter table strategy_ticks enable row level security;
alter table orders enable row level security;
alter table kis_tokens enable row level security;

create policy "Signed-in users can read candidates"
  on trade_candidates for select to authenticated using (true);

create policy "Signed-in users can read ticks"
  on strategy_ticks for select to authenticated using (true);

create policy "Signed-in users can read orders"
  on orders for select to authenticated using (true);
