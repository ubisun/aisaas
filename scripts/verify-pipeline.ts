/**
 * Runs one report end to end against the real services, skipping only QStash.
 *
 * Temporary: this exists to prove the pipeline works before the schedule is
 * wired up, and should be deleted once QStash drives it.
 *
 *   npx tsx --env-file=.env.local scripts/verify-pipeline.ts
 */
import { sessionDate } from "@/lib/market/session";
import { runMarketCloseJob, runTranslateJob } from "@/lib/report/run";
import { createAdminClient } from "@/lib/supabase/admin";

async function main() {
  const session = sessionDate();
  const supabase = createAdminClient();

  console.log(`Session date (America/New_York): ${session}`);

  const { data: run, error } = await supabase
    .from("report_runs")
    .upsert(
      { session_date: session, status: "queued", detail: null, finished_at: null },
      { onConflict: "session_date" },
    )
    .select("id")
    .single();

  if (error) throw new Error(`Claiming the run failed: ${error.message}`);
  console.log(`Run id: ${run.id}\n`);

  const started = Date.now();
  try {
    const { outcome, needsTranslation } = await runMarketCloseJob(run.id, session);
    console.log(`English report in ${((Date.now() - started) / 1000).toFixed(1)}s`);

    if (needsTranslation) {
      const translateStarted = Date.now();
      await runTranslateJob(run.id, session, started);
      console.log(
        `Korean translation in ${((Date.now() - translateStarted) / 1000).toFixed(1)}s`,
      );
    }

    await supabase
      .from("report_runs")
      .update({
        status: outcome.status,
        detail: outcome.detail ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", run.id);

    console.log(`${outcome.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (outcome.detail) console.log(outcome.detail);

    if (outcome.status === "succeeded") {
      const { data: report } = await supabase
        .from("reports")
        .select("us_summary, us_summary_ko, kr_sector_outlook")
        .eq("run_id", run.id)
        .single();

      console.log(`\n--- US summary (EN) ---\n${report?.us_summary}`);
      console.log(`\n--- US summary (KO) ---\n${report?.us_summary_ko}`);
      console.log(`\n--- KRX sector outlook ---`);
      for (const item of report?.kr_sector_outlook ?? []) {
        console.log(`${item.sector} — ${item.direction} (confidence: ${item.confidence})`);
        console.log(`  ${item.rationale}`);
      }
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    await supabase
      .from("report_runs")
      .update({ status: "failed", detail, finished_at: new Date().toISOString() })
      .eq("id", run.id);
    throw cause;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
