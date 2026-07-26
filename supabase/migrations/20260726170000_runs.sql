-- A single record of every scheduled execution, for every team.
--
-- The report side and the trading side had independently grown the same
-- table: a status, a reason, start and finish timestamps, and a unique key
-- for idempotency. The recovery logic that goes with it -- reclaiming a run
-- killed mid-flight so its slot is not blocked forever -- existed only on the
-- report side and would have been copied into every team after it.
--
-- Teams keep their own domain tables. What they share is this: the fact that
-- something ran, when, and how it ended.
--
--   team   which department the run belongs to ('market-report', 'trading')
--   kind   what kind of work within that team ('daily-close', 'morning-session')
--   key    the idempotency key, usually the date the work is *for*
--
-- `phase` is free text on purpose. Teams describe their own intermediate steps
-- ('collecting', 'analyzing', 'trading') without a schema change or a shared
-- enum that every team would have to agree on.

create type run_status as enum (
  'queued',
  'running',
  'succeeded',
  'failed',
  'skipped'
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  kind text not null,
  key text not null,
  status run_status not null default 'queued',
  phase text,
  detail text,
  -- Team-specific context that does not deserve a column.
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  -- What makes a redelivery idempotent: one run per unit of work.
  constraint runs_identity_key unique (team, kind, key)
);

create index runs_team_started_idx on runs (team, started_at desc);
create index runs_status_idx on runs (status);

-- Move the report team across, preserving ids so the existing foreign keys
-- keep pointing at the same rows.
insert into runs (id, team, kind, key, status, phase, detail, started_at, finished_at)
select
  id,
  'market-report',
  'daily-close',
  session_date::text,
  case status
    when 'queued' then 'queued'
    when 'collecting' then 'running'
    when 'analyzing' then 'running'
    when 'succeeded' then 'succeeded'
    when 'failed' then 'failed'
    when 'skipped' then 'skipped'
  end::run_status,
  case when status in ('collecting', 'analyzing') then status::text end,
  detail,
  started_at,
  finished_at
from report_runs;

alter table market_quotes drop constraint market_quotes_run_id_fkey;
alter table market_quotes
  add constraint market_quotes_run_id_fkey
  foreign key (run_id) references runs (id) on delete cascade;

alter table reports drop constraint reports_run_id_fkey;
alter table reports
  add constraint reports_run_id_fkey
  foreign key (run_id) references runs (id) on delete cascade;

drop table report_runs;
drop type report_run_status;

-- Same posture as every other table: signed-in users read, only the service
-- role writes.
alter table runs enable row level security;

create policy "Signed-in users can read runs"
  on runs for select
  to authenticated
  using (true);
