-- What each model call actually cost.
--
-- Added because the honest answer to "how much is this spending" was that
-- nobody knew. Call counts were easy to reason about and misleading: the
-- expensive part of a web search is not the search fee but the pages it drags
-- into the context window, and that is invisible without measuring.
--
-- Recorded per call rather than aggregated so a later question -- which team,
-- which step, which model -- can be answered without having anticipated it.

create table llm_usage (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  -- What the call was for, e.g. 'search', 'notes', 'translate'.
  purpose text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  -- Cached reads are billed at about a tenth of input; writes at a premium.
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  -- Billed separately from tokens, per search.
  web_searches integer not null default 0,
  created_at timestamptz not null default now()
);

create index llm_usage_created_idx on llm_usage (created_at desc);
create index llm_usage_team_idx on llm_usage (team, created_at desc);

alter table llm_usage enable row level security;

create policy "Signed-in users can read usage"
  on llm_usage for select
  to authenticated
  using (true);
