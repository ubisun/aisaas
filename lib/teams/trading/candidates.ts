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
  marketCapEok: number;
};

/**
 * Market capitalisation for a set of tickers, fetched at most once each per
 * trading day.
 *
 * This is what makes re-screening affordable. The ranking response carries
 * turnover but not market cap, and market cap costs a quote call per ticker at
 * 1.2s apiece in the paper environment. Since it does not move intraday in any
 * way a 1% threshold notices, the first screen of the day pays for it and every
 * screen after reads the cache.
 *
 * A ticker whose quote fails is simply left out of the map; the screen skips it
 * rather than failing the tick over one name.
 */
async function marketCaps(
  tickers: { ticker: string; name: string }[],
  tradeDate: string,
): Promise<Map<string, number>> {
  const supabase = createAdminClient();
  const caps = new Map<string, number>();

  const { data: cached } = await supabase
    .from("market_caps")
    .select("ticker, market_cap_eok")
    .eq("trade_date", tradeDate)
    .in(
      "ticker",
      tickers.map((t) => t.ticker),
    );

  for (const row of cached ?? []) {
    caps.set(row.ticker as string, Number(row.market_cap_eok));
  }

  const missing = tickers.filter((t) => !caps.has(t.ticker));
  if (!missing.length) return caps;

  const fetched: { ticker: string; trade_date: string; name: string; market_cap_eok: number }[] = [];

  for (const { ticker, name } of missing) {
    try {
      const quote = await fetchQuote(ticker);
      if (quote.marketCapEok <= 0) continue;
      caps.set(ticker, quote.marketCapEok);
      fetched.push({
        ticker,
        trade_date: tradeDate,
        name,
        market_cap_eok: quote.marketCapEok,
      });
    } catch (cause) {
      console.warn(`market cap: skipping ${ticker}`, cause);
    }
  }

  if (fetched.length) {
    // Ignore a write failure: the caps are already in hand for this screen, and
    // the worst case is paying for the quotes again on the next tick.
    const { error } = await supabase
      .from("market_caps")
      .upsert(fetched, { onConflict: "ticker,trade_date" });
    if (error) console.warn(`market cap: caching failed: ${error.message}`);
  }

  return caps;
}

/**
 * The shortlist as it stands right now.
 *
 * Called once per tick rather than once per morning. The screen asks what is
 * being traded heavily *this morning*, which a list computed before the opening
 * bell cannot answer -- today's accumulated turnover is zero until the market
 * opens, so a pre-open screen fails the liquidity filter on every name and
 * returns nothing. That is what it did: 296 of 296 in-window decision points
 * between 07-27 and 08-28 saw an empty shortlist and no order was ever placed.
 *
 * The turnover floor doubles as a time gate, which is why the entry window did
 * not need moving: ten minutes after the open only the genuinely heavy names
 * have cleared it, and the list fills out as the morning goes on.
 */
export async function screenNow(tradeDate: string): Promise<ScreenedCandidate[]> {
  // One ranking call per market, merged. Asking for "all markets" returns what
  // is effectively the KOSPI list, which buries exactly the mid caps this
  // screen is looking for.
  const byTicker = new Map<string, Awaited<ReturnType<typeof fetchVolumeRank>>[number]>();
  for (const market of screening.markets) {
    const rows = (await fetchVolumeRank(market)).slice(0, screening.rankPoolSize);
    for (const row of rows) {
      const existing = byTicker.get(row.ticker);
      // Keep the better rank if a name somehow appears in both lists.
      if (!existing || row.rank < existing.rank) byTicker.set(row.ticker, row);
    }
  }

  const liquid = [...byTicker.values()].filter(
    (row) => row.turnover >= screening.minTurnoverKrw,
  );
  if (!liquid.length) return [];

  const caps = await marketCaps(liquid, tradeDate);

  const screened: ScreenedCandidate[] = [];
  for (const row of liquid) {
    const marketCapEok = caps.get(row.ticker);
    if (!marketCapEok) continue;

    // hts_avls is reported in 억원; turnover is in KRW.
    const marketCapKrw = marketCapEok * 100_000_000;
    const turnoverToMarketCapPct = (row.turnover / marketCapKrw) * 100;
    if (turnoverToMarketCapPct < screening.minTurnoverToMarketCapPct) continue;

    screened.push({
      ticker: row.ticker,
      name: row.name,
      price: row.price,
      changePct: row.changePct,
      turnover: row.turnover,
      turnoverToMarketCapPct,
      turnoverRank: row.rank,
      marketCapEok,
    });
  }

  // Most repriced relative to size first, then let the cap decide.
  screened.sort((a, b) => b.turnoverToMarketCapPct - a.turnoverToMarketCapPct);
  return screened.slice(0, limits.maxCandidates);
}
