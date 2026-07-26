-- Daily US market close analysis pipeline.
--
-- One run per US trading session. A run collects quotes, hands them to the
-- model, and produces exactly one report. `session_date` is the US trading
-- date (America/New_York), not the date the job happened to execute -- the
-- job runs after the close, which is already the next day in KST.

create type report_run_status as enum (
  'queued',
  'collecting',
  'analyzing',
  'succeeded',
  'failed',
  'skipped'
);

create table report_runs (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  status report_run_status not null default 'queued',
  -- Set when status is 'failed' or 'skipped' so a retry can tell a holiday
  -- (skip, nothing to do) from a provider outage (retry is worthwhile).
  detail text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- QStash retries deliver the same session more than once. This constraint
  -- is what makes the webhook idempotent; the handler upserts on it.
  constraint report_runs_session_date_key unique (session_date)
);

create index report_runs_status_idx on report_runs (status);

-- Raw closing quotes backing a report, kept so a report can be re-generated
-- or audited without re-fetching from the provider.
create table market_quotes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references report_runs (id) on delete cascade,
  symbol text not null,
  -- 'index' for the broad benchmarks, 'sector' for the sector ETFs that
  -- stand in for the GICS sectors.
  kind text not null check (kind in ('index', 'sector')),
  label text not null,
  close numeric(14, 4) not null,
  previous_close numeric(14, 4) not null,
  change_pct numeric(8, 4) not null,
  collected_at timestamptz not null default now(),
  constraint market_quotes_run_symbol_key unique (run_id, symbol)
);

create index market_quotes_run_id_idx on market_quotes (run_id);

create table reports (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references report_runs (id) on delete cascade,
  session_date date not null,
  -- Narrative summary of the US session.
  us_summary text not null,
  -- Sector outlook for the next KRX session, as an array of
  -- { sector, direction, confidence, rationale }. Kept as jsonb so the
  -- shape can change without a migration while the product is young.
  kr_sector_outlook jsonb not null,
  model text not null,
  created_at timestamptz not null default now(),
  constraint reports_run_id_key unique (run_id),
  constraint reports_session_date_key unique (session_date)
);

create index reports_session_date_idx on reports (session_date desc);

-- Row level security -------------------------------------------------------
--
-- Reports are readable by any signed-in user; the pipeline writes with the
-- service role, which bypasses RLS. No client-side write policies exist on
-- purpose, so a browser session can never author a report.

alter table report_runs enable row level security;
alter table market_quotes enable row level security;
alter table reports enable row level security;

create policy "Signed-in users can read runs"
  on report_runs for select
  to authenticated
  using (true);

create policy "Signed-in users can read quotes"
  on market_quotes for select
  to authenticated
  using (true);

create policy "Signed-in users can read reports"
  on reports for select
  to authenticated
  using (true);
