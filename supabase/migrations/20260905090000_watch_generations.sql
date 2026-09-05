-- One row per invocation of the position watcher.
--
-- The watcher is a chain: each run polls for a few minutes and queues its
-- successor, and a generation cap is the last thing standing between a bug and
-- a function that re-queues itself forever. On 2026-09-04 a session that should
-- have needed 91 generations used 99, leaving one below the cap of 100 -- and
-- there was no way to find out why, because the watcher recorded nothing about
-- itself. It wrote a tick only when it decided to sell.
--
-- A cap raised without understanding why it was nearly reached is a bug papered
-- over, so this exists to answer the question the next time it comes up: how
-- many times did each generation actually look, how long did it live, and what
-- ended it.
create table watch_generations (
  run_id uuid not null references runs (id) on delete cascade,
  generation integer not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  /** Balance reads completed. A generation that ends with none died early. */
  polls integer not null default 0,
  exits integer not null default 0,
  /** flat | closed | generations | handed-on | failed */
  stopped text,
  detail text,
  constraint watch_generations_pkey primary key (run_id, generation)
);

create index watch_generations_run_idx on watch_generations (run_id, generation);

alter table watch_generations enable row level security;

create policy "Signed-in users can read watch generations"
  on watch_generations for select to authenticated using (true);
