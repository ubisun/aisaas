import { collectQuotes } from "@/lib/market/finnhub";
import { isStale } from "@/lib/market/session";
import { notify } from "@/lib/notify";
import { generateReport, REPORT_MODEL } from "@/lib/report/generate";
import { createAdminClient } from "@/lib/supabase/admin";

export type JobOutcome = {
  status: "succeeded" | "skipped";
  sessionDate: string;
  detail?: string;
};

/**
 * One report run, end to end: collect quotes, store them, generate the brief,
 * store it. Kept out of the route handler so the same code path can be driven
 * directly -- from a script, or eventually a test -- without going through
 * QStash signature verification.
 *
 * Throws on failure; the caller decides how to record it and whether the
 * delivery should be retried.
 */
export async function runMarketCloseJob(
  runId: string,
  sessionDate: string,
): Promise<JobOutcome> {
  const supabase = createAdminClient();
  const startedAt = Date.now();

  await supabase.from("report_runs").update({ status: "collecting" }).eq("id", runId);
  const quotes = await collectQuotes();

  // Every quote predating the expected session means the market never opened --
  // a holiday. Skipping keeps the previous session from being re-reported under
  // a new date.
  if (quotes.every((quote) => isStale(quote.timestamp, sessionDate))) {
    const detail = `No trading activity for ${sessionDate}; likely a market holiday.`;
    await notify({ type: "report.skipped", sessionDate, detail });
    return { status: "skipped", sessionDate, detail };
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
      us_summary_ko: report.us_summary_ko,
      kr_sector_outlook: report.kr_sector_outlook,
      model: REPORT_MODEL,
    },
    { onConflict: "run_id" },
  );
  if (reportError) throw new Error(`Storing the report failed: ${reportError.message}`);

  await notify({
    type: "report.published",
    sessionDate,
    sectorCount: report.kr_sector_outlook.length,
    durationMs: Date.now() - startedAt,
  });

  return { status: "succeeded", sessionDate };
}
