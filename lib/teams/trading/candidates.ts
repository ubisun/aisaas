import { createAdminClient } from "@/lib/supabase/admin";

import { TRADING_CONFIG } from "./config";
import { fetchQuote, fetchVolumeRank } from "./kis";
import type { Candidate } from "./types";

/**
 * Choosing what is in scope for the day.
 *
 * Two filters, in this order: what is actually being traded, and whether that
 * activity is large relative to the company's size. A blue chip turning over
 * its usual billions tells you nothing; a mid cap turning over a tenth of
 * itself before ten in the morning is being repriced, and that is the kind of
 * move a day trade can ride.
 *
 * The sector view from the overnight US report is applied last, as a tilt
 * rather than a filter -- the report is a read on the whole market, not a
 * stock picker, and treating it as one would throw away most of what moves.
 */

const { screening, limits } = TRADING_CONFIG;

export type SectorOutlook = {
  sector: string;
  sector_ko?: string;
  direction: string;
  confidence: string;
  rationale: string;
};

export type ReportView = {
  sessionDate: string | null;
  /** Empty when there is no report, or when the newest one is too old to use. */
  outlook: SectorOutlook[];
  /** Calendar days between the report's US session and the KRX trading date. */
  ageDays: number | null;
  stale: boolean;
};

/**
 * The most recent report's sector view.
 *
 * Deliberately not keyed to a specific date: on a Korean Monday the newest
 * report is Friday's US session, which is exactly the one to trade on.
 *
 * It is keyed to *recency* though. Taking whichever report happens to be
 * newest means a run of failed reports would have the trading side quietly
 * acting on a week-old read of the market -- confidently, and with no signal
 * that anything was wrong. Past the age limit the outlook is dropped and the
 * agent is told nothing rather than something untrue.
 */
export async function latestSectorOutlook(tradeDate: string): Promise<ReportView> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("reports")
    .select("session_date, kr_sector_outlook")
    .order("session_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { sessionDate: null, outlook: [], ageDays: null, stale: true };

  const sessionDate = data.session_date as string;
  const ageDays = Math.round(
    (Date.parse(`${tradeDate}T00:00:00Z`) - Date.parse(`${sessionDate}T00:00:00Z`)) / 86_400_000,
  );
  const stale = ageDays > TRADING_CONFIG.maxReportAgeDays;

  return {
    sessionDate,
    outlook: stale ? [] : ((data.kr_sector_outlook ?? []) as SectorOutlook[]),
    ageDays,
    stale,
  };
}

export type ScreenedCandidate = Candidate & {
  turnoverRank: number;
  volumeTurnoverRate: number;
  marketCapEok: number;
};

/**
 * Build the day's candidate list.
 *
 * Quotes are fetched one at a time for the ranked pool because the ranking
 * response carries no market capitalisation, and the ratio is the whole point
 * of the screen.
 */
export async function selectCandidates(): Promise<ScreenedCandidate[]> {
  const ranked = (await fetchVolumeRank()).slice(0, screening.rankPoolSize);

  const screened: ScreenedCandidate[] = [];
  for (const row of ranked) {
    if (row.turnover < screening.minTurnoverKrw) continue;

    let quote;
    try {
      quote = await fetchQuote(row.ticker);
    } catch (cause) {
      console.warn(`candidate screen: skipping ${row.ticker}`, cause);
      continue;
    }

    // hts_avls is reported in 억원; turnover is in KRW.
    const marketCapKrw = quote.marketCapEok * 100_000_000;
    if (marketCapKrw <= 0) continue;

    const turnoverToMarketCapPct = (quote.turnover / marketCapKrw) * 100;
    if (turnoverToMarketCapPct < screening.minTurnoverToMarketCapPct) continue;

    screened.push({
      ticker: row.ticker,
      name: row.name,
      price: quote.price,
      changePct: quote.changePct,
      turnover: quote.turnover,
      turnoverToMarketCapPct,
      turnoverRank: row.rank,
      volumeTurnoverRate: quote.volumeTurnoverRate,
      marketCapEok: quote.marketCapEok,
    });
  }

  // Most repriced relative to size first, then let the cap decide.
  screened.sort((a, b) => b.turnoverToMarketCapPct - a.turnoverToMarketCapPct);
  return screened.slice(0, limits.maxCandidates);
}
