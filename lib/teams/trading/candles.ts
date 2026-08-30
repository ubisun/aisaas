import { createAdminClient } from "@/lib/supabase/admin";

import { TRADING_CONFIG } from "./config";
import {
  aggregate,
  fetchDailyCandles,
  fetchMinuteCandles,
  fetchPastMinuteCandles,
  type Candle,
} from "./kis";

/**
 * Candle data, priced in API calls.
 *
 * Every read here costs 1.2s in the paper environment, so the shape of this
 * file is set by what the endpoints will actually give: thirty one-minute bars
 * ending at a requested time, and no way to ask for more. A strategy wanting
 * twenty five-minute bars is asking for a hundred minutes of history, which
 * would be four calls per name per tick.
 *
 * Today's bars therefore accumulate in `candle_cache` and each tick merges in
 * only the newest thirty, which is one call per name per tick at any point in
 * the session. Yesterday's tail and the daily series are fetched once and never
 * refetched -- they cannot change.
 */

const { orb } = TRADING_CONFIG;

function seoulNow(): { hhmmss: string; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return {
    hhmmss: `${parts.hour}${parts.minute}${parts.second}`,
    date: `${parts.year}${parts.month}${parts.day}`,
  };
}

async function readCache(
  ticker: string,
  tradeDate: string,
  kind: "today1m" | "prev1m" | "daily",
): Promise<Candle[] | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("candle_cache")
    .select("payload")
    .match({ ticker, trade_date: tradeDate, kind })
    .maybeSingle();

  return data ? ((data.payload as Candle[]) ?? []) : null;
}

async function writeCache(
  ticker: string,
  tradeDate: string,
  kind: "today1m" | "prev1m" | "daily",
  candles: Candle[],
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("candle_cache").upsert(
    { ticker, trade_date: tradeDate, kind, payload: candles, fetched_at: new Date().toISOString() },
    { onConflict: "ticker,trade_date,kind" },
  );
  // A failed cache write costs another call next tick; it is not worth failing
  // a tick that can still trade.
  if (error) console.warn(`candle cache write failed for ${ticker}/${kind}: ${error.message}`);
}

/** Merge two one-minute series, newest value winning, oldest first. */
function merge(existing: Candle[], incoming: Candle[]): Candle[] {
  const byKey = new Map(existing.map((c) => [`${c.date}${c.time}`, c]));
  for (const candle of incoming) byKey.set(`${candle.date}${candle.time}`, candle);
  return [...byKey.values()].sort((a, b) =>
    `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`),
  );
}

/**
 * Today's one-minute bars, oldest first, topped up with the latest thirty.
 *
 * One call regardless of how far into the session it is, because what is
 * already known is not asked for again.
 */
export async function todayMinutes(ticker: string, tradeDate: string): Promise<Candle[]> {
  const cached = (await readCache(ticker, tradeDate, "today1m")) ?? [];
  const latest = await fetchMinuteCandles(ticker, 1, seoulNow().hhmmss);
  const merged = merge(cached, latest);

  if (merged.length !== cached.length) await writeCache(ticker, tradeDate, "today1m", merged);
  return merged;
}

/**
 * The previous session's one-minute tail.
 *
 * This is what makes the momentum test evaluable when it matters. ATR(14) on
 * five-minute bars needs seventy minutes of history; at 09:35 the session has
 * produced five. Without yesterday's bars the strategy could not judge a
 * breakout until the late morning, by which time the opening range has stopped
 * meaning anything.
 */
export async function previousMinutes(
  ticker: string,
  tradeDate: string,
  previousTradingDate: string,
): Promise<Candle[]> {
  const cached = await readCache(ticker, tradeDate, "prev1m");
  if (cached) return cached;

  const bars = await fetchPastMinuteCandles(ticker, 1, previousTradingDate.replace(/-/g, ""));
  await writeCache(ticker, tradeDate, "prev1m", bars);
  return bars;
}

/** Daily bars for the trend filter. Fetched once a day per name. */
export async function dailyCandles(ticker: string, tradeDate: string): Promise<Candle[]> {
  const cached = await readCache(ticker, tradeDate, "daily");
  if (cached) return cached;

  const to = tradeDate.replace(/-/g, "");
  const from = new Date(Date.parse(`${tradeDate}T00:00:00Z`) - 120 * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");

  const bars = await fetchDailyCandles(ticker, from, to);
  await writeCache(ticker, tradeDate, "daily", bars);
  return bars;
}

export type BarSeries = {
  /** Five-minute bars for today, oldest first, opening range included. */
  today: Candle[];
  /** Five-minute bars carried over from the previous session. */
  previous: Candle[];
  /** Today's bars preceded by yesterday's, for indicators that need history. */
  continuous: Candle[];
  /** The first `rangeMinutes` of today, folded into one bar. */
  openingRange: { high: number; low: number; complete: boolean } | null;
  daily: Candle[];
};

/**
 * Everything the opening-range strategy reads about one name.
 *
 * Three calls on the first tick of the day, one on every tick after.
 */
export async function loadBars(
  ticker: string,
  tradeDate: string,
  previousTradingDate: string,
): Promise<BarSeries> {
  const [todayRaw, prevRaw, daily] = await Promise.all([
    todayMinutes(ticker, tradeDate),
    previousMinutes(ticker, tradeDate, previousTradingDate),
    dailyCandles(ticker, tradeDate),
  ]);

  const stamp = tradeDate.replace(/-/g, "");
  const today = aggregate(
    todayRaw.filter((c) => c.date === stamp),
    orb.triggerMinutes,
  );
  const previous = aggregate(
    prevRaw.filter((c) => c.date !== stamp),
    orb.triggerMinutes,
  );

  return {
    today,
    previous,
    continuous: [...previous, ...today],
    openingRange: openingRange(todayRaw, tradeDate),
    daily,
  };
}

/**
 * The reference range: the first thirty minutes of the session.
 *
 * Reported as incomplete until the session clock has passed the end of the
 * window, because a range read off a half-finished period is not the range --
 * it is a guess that will move, and every decision downstream is measured
 * against it.
 */
export function openingRange(
  minuteBars: Candle[],
  tradeDate: string,
): { high: number; low: number; complete: boolean } | null {
  const startMinutes = 9 * 60;
  const endMinutes = startMinutes + orb.rangeMinutes;

  // Filtered by date as well as by time. The endpoints walk backwards from the
  // requested moment and will cross into the previous session, so matching on
  // the clock alone would silently fold yesterday's opening range into today's
  // -- and every decision the strategy makes is measured against this number.
  const today = minuteBars.filter((c) => c.date === tradeDate.replace(/-/g, ""));
  if (!today.length) return null;

  const inRange = today.filter((c) => {
    if (c.time.length < 4) return false;
    const minutes = Number(c.time.slice(0, 2)) * 60 + Number(c.time.slice(2, 4));
    return minutes >= startMinutes && minutes < endMinutes;
  });
  if (!inRange.length) return null;

  const last = today[today.length - 1];
  const lastMinutes = Number(last.time.slice(0, 2)) * 60 + Number(last.time.slice(2, 4));

  return {
    high: Math.max(...inRange.map((c) => c.high)),
    low: Math.min(...inRange.map((c) => c.low)),
    complete: lastMinutes >= endMinutes,
  };
}

/** Average true range over `period` bars, or null when there are too few. */
export function atr(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;

  const ranges: number[] = [];
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }
  return ranges.reduce((sum, r) => sum + r, 0) / ranges.length;
}

/** Mean volume over `period` bars, or null when there are too few. */
export function volumeMa(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  return slice.reduce((sum, c) => sum + c.volume, 0) / slice.length;
}

/** Exponential moving average of closes, or null when there are too few bars. */
export function ema(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let value = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
  for (const candle of candles.slice(period)) value = candle.close * k + value * (1 - k);
  return value;
}
