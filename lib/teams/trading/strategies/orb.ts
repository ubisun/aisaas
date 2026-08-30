import { createAdminClient } from "@/lib/supabase/admin";

import { atr, ema, loadBars, volumeMa, type BarSeries } from "../candles";
import { TRADING_CONFIG } from "../config";
import type { Candle } from "../kis";
import type { ProposedOrder, Strategy, StrategyProposal, TickContext } from "../types";

/**
 * Opening range breakout, in two modes.
 *
 * Reconstructed from `references/trading/30min_candle` -- a specification and a
 * set of notes on a YouTube method. The notes are explicit that the results are
 * the video author's claims rather than verified performance, so the numbers
 * here are taken from the document exactly as written and left in
 * `TRADING_CONFIG.orb` to be measured rather than tuned by feel.
 *
 * The first thirty minutes of the session set a reference range. From 09:30 the
 * strategy watches five-minute closes against the high of that range, and the
 * two modes are branches of one state machine rather than separate ideas:
 *
 *     WAITING_BREAKOUT
 *        ├─ close above the range, with momentum   → enter now      (mode 1)
 *        └─ close above the range, without it      → WAITING_RETEST (mode 2)
 *     WAITING_RETEST
 *        ├─ price returns to the line and a reversal bar confirms  → enter
 *        └─ close back below the range low                         → done
 *
 * Both modes size the stop from the bar they entered on and take profit at
 * twice that distance. That is the whole edge as the document describes it, and
 * it is why the entry carries its own exit levels instead of inheriting the
 * house percentages.
 *
 * Long only. The source covers short setups below the range low, but the desk
 * trades a cash account.
 */

const { orb, limits } = TRADING_CONFIG;

type State = "WAITING_BREAKOUT" | "WAITING_RETEST" | "IN_POSITION" | "INVALIDATED" | "DONE";

type StateDetail = {
  rangeHigh?: number;
  rangeLow?: number;
  /** Bar that broke out without enough momentum, kept for the record. */
  breakoutAt?: string;
  stops?: number;
};

type TickerState = { state: State; detail: StateDetail };

async function loadStates(runId: string): Promise<Map<string, TickerState>> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("strategy_state")
    .select("ticker, state, detail")
    .match({ run_id: runId, strategy: orbStrategy.name });

  return new Map(
    (data ?? []).map((row) => [
      row.ticker as string,
      { state: row.state as State, detail: (row.detail ?? {}) as StateDetail },
    ]),
  );
}

async function saveState(
  runId: string,
  ticker: string,
  state: State,
  detail: StateDetail,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("strategy_state").upsert(
    {
      run_id: runId,
      strategy: orbStrategy.name,
      ticker,
      state,
      detail,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "run_id,strategy,ticker" },
  );
  if (error) console.warn(`orb: saving state for ${ticker} failed: ${error.message}`);
}

/** The higher-timeframe filter: is the daily picture pointing up? */
function trendIsBullish(daily: Candle[]): boolean {
  if (daily.length < 2) return false;

  const today = daily[daily.length - 1];
  const yesterday = daily[daily.length - 2];
  if (today.open > yesterday.high) return true;

  const fast = ema(daily, 20);
  const slow = ema(daily, 60);
  return fast !== null && slow !== null && fast > slow;
}

/** A single bar carrying enough force to be worth entering on immediately. */
function isGiantBar(bar: Candle, history: Candle[]): boolean {
  const range = atr(history, orb.atrPeriod);
  const volume = volumeMa(history, orb.volumeMaPeriod);
  if (range === null || volume === null) return false;

  return (
    Math.abs(bar.close - bar.open) >= orb.giantBarAtrMultiple * range &&
    bar.volume >= orb.giantBarVolumeMultiple * volume
  );
}

/** Momentum by persistence instead of by size: N closes up in a row. */
function isRun(bars: Candle[]): boolean {
  if (bars.length < orb.consecutiveBars) return false;
  return bars.slice(-orb.consecutiveBars).every((b) => b.close > b.open);
}

function isPinbar(bar: Candle): boolean {
  const span = bar.high - bar.low;
  if (span <= 0) return false;
  return bar.close > bar.open && bar.open - bar.low > orb.pinbarWickFraction * span;
}

function isBullishEngulfing(bar: Candle, previous: Candle | undefined): boolean {
  if (!previous) return false;
  return bar.close > previous.open && previous.close < previous.open;
}

/** Whole shares, bounded by the order ceiling and by what one R is worth. */
function sizePosition(entry: number, stop: number, budgetPerOrder: number): number {
  const risk = entry - stop;
  if (risk <= 0) return 0;

  // The document sizes by risk alone. The desk's per-order ceiling is a
  // separate promise and the smaller of the two has to win, or a tight stop
  // would quietly buy a position the gate would then reject.
  const byCeiling = Math.floor(budgetPerOrder / entry);
  return Math.max(0, byCeiling);
}

function bracket(
  ticker: string,
  entryBar: Candle,
  stopReference: number,
  context: TickContext,
  why: string,
): ProposedOrder | null {
  const entry = entryBar.close;
  const stop = stopReference - orb.stopBufferTicks;
  const quantity = sizePosition(entry, stop, context.maxOrderValueKrw);
  if (quantity <= 0) return null;

  return {
    ticker,
    side: "buy",
    quantity,
    reason: why,
    stopLoss: stop,
    takeProfit: entry + orb.rewardMultiple * (entry - stop),
  };
}

/** Decide about one name, advancing its state machine by at most one step. */
async function evaluate(
  runId: string,
  ticker: string,
  bars: BarSeries,
  current: TickerState,
  context: TickContext,
): Promise<{ order: ProposedOrder | null; note: string }> {
  const range = bars.openingRange;
  if (!range) return { order: null, note: `${ticker}: no bars yet` };
  if (!range.complete) return { order: null, note: `${ticker}: opening range still forming` };

  const closed = bars.today.filter((b) => {
    const minutes = Number(b.time.slice(0, 2)) * 60 + Number(b.time.slice(2, 4));
    return minutes >= 9 * 60 + orb.rangeMinutes;
  });
  if (!closed.length) return { order: null, note: `${ticker}: no bar since the range closed` };

  const bar = closed[closed.length - 1];
  const history = bars.continuous.slice(0, -1);
  const detail: StateDetail = { ...current.detail, rangeHigh: range.high, rangeLow: range.low };

  if (current.state === "WAITING_BREAKOUT") {
    if (bar.close <= range.high) {
      // Inside the range is noise by construction; the document is explicit
      // that nothing inside it is tradeable.
      return { order: null, note: `${ticker}: inside the range` };
    }

    if (!trendIsBullish(bars.daily)) {
      await saveState(runId, ticker, "WAITING_RETEST", { ...detail, breakoutAt: bar.time });
      return { order: null, note: `${ticker}: broke out against the daily trend — waiting for a retest` };
    }

    if (isGiantBar(bar, history) || isRun(closed)) {
      const order = bracket(
        ticker,
        bar,
        bar.low,
        context,
        `Momentum breakout: ${bar.close.toLocaleString()} closed above the ${range.high.toLocaleString()} range high with ${isGiantBar(bar, history) ? "an outsized bar on heavy volume" : `${orb.consecutiveBars} closes up in a row`}. Stop under the breakout bar, target 2R.`,
      );
      if (order) return { order, note: `${ticker}: momentum entry` };
    }

    await saveState(runId, ticker, "WAITING_RETEST", { ...detail, breakoutAt: bar.time });
    return { order: null, note: `${ticker}: broke out without momentum — waiting for a retest` };
  }

  if (current.state === "WAITING_RETEST") {
    if (bar.close < range.low) {
      await saveState(runId, ticker, "INVALIDATED", detail);
      return { order: null, note: `${ticker}: closed below the range low — done for the day` };
    }

    const touched =
      bar.low <= range.high * (1 + orb.retestBandAbove) &&
      bar.close >= range.high * (1 - orb.retestBandBelow);
    if (!touched) return { order: null, note: `${ticker}: has not come back to the line` };

    const previous = closed[closed.length - 2];
    if (!isPinbar(bar) && !isBullishEngulfing(bar, previous)) {
      return { order: null, note: `${ticker}: at the line but no reversal bar` };
    }

    const order = bracket(
      ticker,
      bar,
      Math.min(range.high, bar.low),
      context,
      `Retest pullback: price returned to the ${range.high.toLocaleString()} line and ${isPinbar(bar) ? "printed a pin bar" : "engulfed the previous bar"}. Stop below the line, target 2R.`,
    );
    if (order) return { order, note: `${ticker}: retest entry` };
    return { order: null, note: `${ticker}: retest confirmed but the size rounded to zero` };
  }

  return { order: null, note: `${ticker}: ${current.state.toLowerCase()}` };
}

export const orbStrategy: Strategy = {
  name: "orb-v1",
  description:
    "Opening range breakout on the first 30 minutes, entering on momentum or on a confirmed retest, with a 2R bracket",

  async propose(context: TickContext): Promise<StrategyProposal> {
    if (!context.runId || !context.previousTradeDate) {
      return { orders: [], reasoning: "No run context; the strategy needs somewhere to keep state." };
    }
    if (!context.candidates.length) {
      return { orders: [], reasoning: "Nothing on the shortlist to watch." };
    }

    const states = await loadStates(context.runId);

    // Each name costs one call a tick, so the watchlist is bounded. The
    // shortlist is already ordered by how much is being traded relative to
    // size, which is the ordering this strategy wants anyway.
    const watchlist = context.candidates
      .filter((c) => {
        const state = states.get(c.ticker)?.state;
        return state !== "INVALIDATED" && state !== "IN_POSITION" && state !== "DONE";
      })
      .slice(0, orb.watchlistSize);

    const orders: ProposedOrder[] = [];
    const notes: string[] = [];
    let entriesLeft = limits.maxEntriesPerDay - context.entriesUsed;

    for (const candidate of watchlist) {
      if (entriesLeft <= 0) {
        notes.push("Entry budget spent; still watching but not acting.");
        break;
      }

      let bars: BarSeries;
      try {
        bars = await loadBars(candidate.ticker, context.tradeDate, context.previousTradeDate);
      } catch (cause) {
        notes.push(`${candidate.ticker}: bars unavailable (${cause instanceof Error ? cause.message : String(cause)})`);
        continue;
      }

      const current = states.get(candidate.ticker) ?? {
        state: "WAITING_BREAKOUT" as State,
        detail: {},
      };

      const { order, note } = await evaluate(
        context.runId,
        candidate.ticker,
        bars,
        current,
        context,
      );
      notes.push(note);

      if (order) {
        orders.push(order);
        entriesLeft -= 1;
        await saveState(context.runId, candidate.ticker, "IN_POSITION", {
          ...current.detail,
          rangeHigh: bars.openingRange?.high,
          rangeLow: bars.openingRange?.low,
        });
      }
    }

    return {
      orders,
      reasoning: notes.length
        ? notes.join("\n")
        : "Nothing watched this tick.",
    };
  },
};
