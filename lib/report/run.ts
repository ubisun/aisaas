import { collectQuotes } from "@/lib/market/finnhub";
import { isStale } from "@/lib/market/session";
import { notify } from "@/lib/notify";
import {
  generateReport,
  translateReport,
  REPORT_MODEL,
  type GeneratedReport,
} from "@/lib/report/generate";
import { createAdminClient } from "@/lib/supabase/admin";

export type JobOutcome = {
  status: "succeeded" | "skipped";
  sessionDate: string;
  detail?: string;
};

/**
 * Step one: collect the quotes and write the English report.
 *
 * Stops short of the Korean translation, which runs as its own queued step --
 * one call doing both outgrows the 60s function ceiling. The report row is
 * stored here with `us_summary_ko` still null, so a failure in translation
 * leaves a usable English report rather than nothing.
 *
 * Returns `false` when there is nothing to translate (a skipped session).
 */
export async function runMarketCloseJob(
  runId: string,
  sessionDate: string,
): Promise<{ outcome: JobOutcome; needsTranslation: boolean }> {
  const supabase = createAdminClient();

  await supabase.from("report_runs").update({ status: "collecting" }).eq("id", runId);
  const quotes = await collectQuotes();

  // Every quote predating the expected session means the market never opened --
  // a holiday. Skipping keeps the previous session from being re-reported under
  // a new date.
  if (quotes.every((quote) => isStale(quote.timestamp, sessionDate))) {
    const detail = `No trading activity for ${sessionDate}; likely a market holiday.`;
    await notify({ type: "report.skipped", sessionDate, detail });
    return { outcome: { status: "skipped", sessionDate, detail }, needsTranslation: false };
  }

  await supabase.from("market_quotes").delete().eq("run_id", runId);
  const { error: quotesError } = await supabase.from("market_quotes").insert(
    quotes.map((quote) => ({
      run_id: runId,
      symbol: quote.symbol,
      kind: quote.kind,
      label: quote.label,
      close: quote.close,
      previous_close: quote.previousClose,
      change_pct: quote.changePct,
    })),
  );
  if (quotesError) throw new Error(`Storing quotes failed: ${quotesError.message}`);

  await supabase.from("report_runs").update({ status: "analyzing" }).eq("id", runId);
  const report = await generateReport(sessionDate, quotes);

  const { error: reportError } = await supabase.from("reports").upsert(
    {
      run_id: runId,
      session_date: sessionDate,
      us_summary: report.us_summary,
      kr_sector_outlook: report.kr_sector_outlook,
      model: REPORT_MODEL,
    },
    { onConflict: "run_id" },
  );
  if (reportError) throw new Error(`Storing the report failed: ${reportError.message}`);

  return { outcome: { status: "succeeded", sessionDate }, needsTranslation: true };
}

/**
 * Step two: translate the stored report into Korean and announce it.
 *
 * The notification fires here rather than in step one so the message only
 * goes out once the report is complete in both languages.
 */
export async function runTranslateJob(
  runId: string,
  sessionDate: string,
  startedAtMs: number,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: stored, error: loadError } = await supabase
    .from("reports")
    .select("us_summary, kr_sector_outlook")
    .eq("run_id", runId)
    .single();

  if (loadError || !stored) {
    throw new Error(`No report to translate for run ${runId}: ${loadError?.message}`);
  }

  const report = stored as GeneratedReport;
  const translation = await translateReport(report);

  // Match on the English sector name rather than array position -- the model
  // is asked to echo it back precisely so a reordered response still lands on
  // the right row.
  const bySector = new Map(translation.sectors.map((s) => [s.sector, s]));
  const merged = report.kr_sector_outlook.map((outlook) => ({
    ...outlook,
    sector_ko: bySector.get(outlook.sector)?.sector_ko,
    rationale_ko: bySector.get(outlook.sector)?.rationale_ko,
  }));

  const { error: updateError } = await supabase
    .from("reports")
    .update({ us_summary_ko: translation.us_summary_ko, kr_sector_outlook: merged })
    .eq("run_id", runId);

  if (updateError) throw new Error(`Storing the translation failed: ${updateError.message}`);

  await notify({
    type: "report.published",
    sessionDate,
    sectorCount: merged.length,
    durationMs: Date.now() - startedAtMs,
  });
}
