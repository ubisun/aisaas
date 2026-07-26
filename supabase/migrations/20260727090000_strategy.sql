-- The strategy department.
--
-- One idea a day for a company made of a human CEO and a set of agents:
-- something it could actually charge for. The team meets every four hours,
-- searching for how people are making money with AI right now, and files a
-- draft at 17:00 KST. The CEO replies whenever they like; the reply decides
-- whether tomorrow builds on today's idea or starts a new one.
--
-- The cycle is keyed to the KST date the idea is *for*. A meeting held after
-- the 17:00 filing already belongs to tomorrow, which is why the key is
-- computed rather than taken from the clock.

create type idea_status as enum (
  'drafting',    -- meetings are still running
  'reported',    -- filed with the CEO, awaiting a reply
  'accepted',    -- worth carrying forward
  'rejected',    -- explicitly turned down
  'superseded'   -- a later idea grew out of this one
);

create table strategy_ideas (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs (id) on delete set null,
  -- KST date the idea is filed for.
  idea_date date not null,
  -- Set when this grew out of yesterday's idea rather than starting fresh.
  parent_id uuid references strategy_ideas (id) on delete set null,

  title text not null,
  -- English is the source of record; Korean is a translation of it, the same
  -- arrangement the market report uses.
  summary text not null,
  summary_ko text,
  -- The substance: the model, who pays, what it would take to run, what would
  -- have to be true. Kept as jsonb so the shape can evolve without a migration
  -- while the department is young.
  detail jsonb not null default '{}'::jsonb,
  detail_ko jsonb,

  status idea_status not null default 'drafting',
  model text,
  created_at timestamptz not null default now(),
  reported_at timestamptz,
  constraint strategy_ideas_date_key unique (idea_date)
);

create index strategy_ideas_date_idx on strategy_ideas (idea_date desc);

-- What each four-hourly meeting turned up. Kept separately from the idea so a
-- day's research survives even when the idea it fed is later rejected -- the
-- searching is worth something on its own.
create table strategy_meetings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs (id) on delete set null,
  idea_date date not null,
  -- 1 for the first meeting of the cycle, and so on.
  sequence integer not null,
  -- Findings, sources and what changed in the thinking.
  notes jsonb not null default '{}'::jsonb,
  held_at timestamptz not null default now(),
  constraint strategy_meetings_cycle_key unique (idea_date, sequence)
);

create index strategy_meetings_date_idx on strategy_meetings (idea_date, sequence);

-- The CEO's reply. Free text, arriving whenever it arrives.
create table idea_feedback (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references strategy_ideas (id) on delete cascade,
  body text not null,
  via text not null default 'telegram' check (via in ('telegram', 'web')),
  received_at timestamptz not null default now(),
  -- Cleared once a cycle has taken it into account, so the same note does not
  -- steer two days running.
  consumed_at timestamptz
);

create index idea_feedback_pending_idx on idea_feedback (idea_id, consumed_at);

alter table strategy_ideas enable row level security;
alter table strategy_meetings enable row level security;
alter table idea_feedback enable row level security;

create policy "Signed-in users can read ideas"
  on strategy_ideas for select to authenticated using (true);

create policy "Signed-in users can read meetings"
  on strategy_meetings for select to authenticated using (true);

create policy "Signed-in users can read feedback"
  on idea_feedback for select to authenticated using (true);
