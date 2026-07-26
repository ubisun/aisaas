-- Decisions the company defers to the CEO.
--
-- Work that has no automatic oracle -- publishing content, going live with a
-- strategy, anything outward-facing -- stops here and waits for a human.
--
-- Nothing can block waiting for that answer: a function has 60 seconds and a
-- queued step cannot sit idle. So an approval carries its own continuation.
-- The requesting step describes what should happen on each outcome, returns,
-- and the decision -- whenever it arrives, from Telegram or the dashboard --
-- enqueues it. That is what makes this reusable by every team instead of
-- something the report side and the trading side each reinvent.

create type approval_status as enum (
  'pending',
  'approved',
  'rejected',
  'expired'
);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  -- What sort of decision this is, for grouping and for the dashboard.
  kind text not null,
  -- The run that asked, when there is one.
  run_id uuid references runs (id) on delete set null,

  -- Shown to the CEO, in Telegram and on the web. Plain text: the renderers
  -- escape it, so it must not contain markup.
  title text not null,
  body text not null,

  -- Where to send the work next, as { "path": "/api/workers/...", "body": {...} }.
  -- Null means the decision itself is the whole point and nothing follows.
  on_approve jsonb,
  on_reject jsonb,

  status approval_status not null default 'pending',
  -- An unanswered approval must not wait forever; past this it is refused
  -- rather than silently actioned late.
  expires_at timestamptz not null,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_via text check (decided_via in ('telegram', 'web')),

  -- Lets the Telegram message be edited in place once a decision is made, so
  -- the buttons cannot be pressed twice.
  telegram_chat_id text,
  telegram_message_id bigint
);

create index approvals_pending_idx on approvals (status, requested_at desc);
create index approvals_team_idx on approvals (team, requested_at desc);

alter table approvals enable row level security;

-- Readable by signed-in users; decisions are made through server code, which
-- uses the service role. A browser cannot approve anything by writing directly
-- to the table.
create policy "Signed-in users can read approvals"
  on approvals for select
  to authenticated
  using (true);
