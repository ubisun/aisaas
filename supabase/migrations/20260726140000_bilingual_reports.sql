-- Reports carry a Korean translation alongside the English original.
--
-- English stays the source of record -- the model reasons in it and the
-- sector rationales are written in it -- with Korean added for readers who
-- want the brief in their own language. Nullable because reports written
-- before this migration have no translation and are not worth backfilling.

alter table reports add column us_summary_ko text;

comment on column reports.us_summary is 'English narrative summary of the US session (source of record).';
comment on column reports.us_summary_ko is 'Korean translation of us_summary. Null for reports generated before bilingual output.';
comment on column reports.kr_sector_outlook is
  'Array of { sector, sector_ko, direction, confidence, rationale, rationale_ko }. '
  'sector_ko and rationale_ko are absent on reports generated before bilingual output.';
