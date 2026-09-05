import { createAdminClient } from "@/lib/supabase/admin";

import { TRADING_CONFIG } from "./config";
import { fetchVolumeRank, type RankedStock } from "./kis";
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
  marketCapEok: number;
};

/**
 * Choose the shortlist from ranking rows that have already been fetched.
 *
 * Pure, so the choosing can be tested without the network. Two filters, in this
 * order: what is actually being traded, and whether that activity is large
 * relative to the company's size.
 *
 * No quote call anywhere. The ranking response carries shares outstanding and
 * KIS's own traded-value-to-market-cap figure, which agrees with the quote
 * endpoint's market cap to within 0.02%. That is what makes a pool three times
 * wider cost less than the narrow one did.
 */
export function selectFrom(rows: RankedStock[]): ScreenedCandidate[] {
  const byTicker = new Map<string, RankedStock>();
  for (const row of rows) {
    if (!row.ticker) continue;
    const existing = byTicker.get(row.ticker);
    // The same name can appear in more than one band or market; keep the
    // reading that saw the most trading, which is the freshest.
    if (!existing || row.turnover > existing.turnover) byTicker.set(row.ticker, row);
  }

  const screened: ScreenedCandidate[] = [];

  for (const row of byTicker.values()) {
    if (row.turnover < screening.minTurnoverKrw) continue;
    if (row.marketCapEok <= 0) continue;
    if (row.turnoverToMarketCapPct < screening.minTurnoverToMarketCapPct) continue;

    screened.push({
      ticker: row.ticker,
      name: row.name,
      price: row.price,
      changePct: row.changePct,
      turnover: row.turnover,
      turnoverToMarketCapPct: row.turnoverToMarketCapPct,
      turnoverRank: row.rank,
      marketCapEok: row.marketCapEok,
    });
  }

  // Most repriced relative to size first, then let the cap decide.
  screened.sort((a, b) => b.turnoverToMarketCapPct - a.turnoverToMarketCapPct);
  return screened.slice(0, limits.maxCandidates);
}

/**
 * The shortlist as it stands right now.
 *
 * Called once per tick rather than once per morning. The screen asks what is
 * being traded heavily *this morning*, which a list computed before the opening
 * bell cannot answer -- today's accumulated turnover is zero until the market
 * opens.
 *
 * The turnover floor doubles as a time gate, which is why the entry window did
 * not need moving: ten minutes after the open only the genuinely heavy names
 * have cleared it, and the list fills out as the morning goes on.
 */
export async function screenNow(tradeDate: string): Promise<ScreenedCandidate[]> {
  // Kept in the signature: the caller passes the session it is screening for,
  // and a future screen that wants yesterday's close will need it.
  void tradeDate;

  // One call per market per price band. Six calls, and nothing else -- the size
  // figures the screen needs already travel with the ranking.
  const rows: RankedStock[] = [];
  for (const market of screening.markets) {
    for (const [low, high] of screening.priceBands) {
      try {
        rows.push(...(await fetchVolumeRank(market, low, high)).slice(0, screening.rankPoolSize));
      } catch (cause) {
        // One band failing should cost that band, not the morning.
        console.warn(
          `screen: ${market} ${low}-${high ?? "up"} unavailable`,
          cause instanceof Error ? cause.message : cause,
        );
      }
    }
  }

  return selectFrom(rows);
}
