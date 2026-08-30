import { describe, expect, it } from "vitest";

import { TRADING_CONFIG } from "@/lib/teams/trading/config";
import {
  isBullishEngulfing,
  isGiantBar,
  isPinbar,
  isRun,
  sizePosition,
  trendIsBullish,
} from "@/lib/teams/trading/strategies/orb";

import { candle, flatSeries } from "../helpers/builders";

/**
 * The opening-range strategy's decisions, one predicate at a time.
 *
 * These come from `references/trading/30min_candle`, and the point of testing
 * them separately from the state machine is that the document can be checked
 * against the code by reading this file. When a number in `TRADING_CONFIG.orb`
 * is tuned, what changes here is which side of a threshold a case falls on --
 * never whether the rule is the one the document describes.
 */

const { orb } = TRADING_CONFIG;

/** Twenty-one flat bars: enough history for ATR(14) and a 20-bar volume mean. */
const HISTORY = flatSeries(21, { open: 10_000, high: 10_050, low: 9_950, close: 10_000, volume: 1_000 });

describe("momentum — a single outsized bar", () => {
  it("needs both the size and the volume", () => {
    const big = candle({ open: 10_000, close: 10_250, high: 10_300, low: 9_990, volume: 2_500 });
    expect(isGiantBar(big, HISTORY)).toBe(true);
  });

  it("rejects a large body on ordinary volume", () => {
    const quiet = candle({ open: 10_000, close: 10_250, high: 10_300, low: 9_990, volume: 1_500 });
    expect(isGiantBar(quiet, HISTORY)).toBe(false);
  });

  it("rejects heavy volume with nothing behind it", () => {
    const churn = candle({ open: 10_000, close: 10_020, high: 10_060, low: 9_990, volume: 3_000 });
    expect(isGiantBar(churn, HISTORY)).toBe(false);
  });

  it("declines to judge when there is not enough history", () => {
    const big = candle({ open: 10_000, close: 10_250, high: 10_300, low: 9_990, volume: 2_500 });
    expect(isGiantBar(big, flatSeries(5))).toBe(false);
  });
});

describe("momentum — a run of closes", () => {
  const up = (i: number) => candle({ open: 100 + i, close: 105 + i });
  const down = candle({ open: 120, close: 110 });

  it("accepts the configured number of consecutive rising closes", () => {
    const bars = Array.from({ length: orb.consecutiveBars }, (_, i) => up(i));
    expect(isRun(bars)).toBe(true);
  });

  it("is broken by a single close down", () => {
    const bars = [...Array.from({ length: orb.consecutiveBars - 1 }, (_, i) => up(i)), down];
    expect(isRun(bars)).toBe(false);
  });

  it("looks only at the most recent bars", () => {
    const bars = [down, ...Array.from({ length: orb.consecutiveBars }, (_, i) => up(i))];
    expect(isRun(bars)).toBe(true);
  });

  it("refuses to judge too few bars", () => {
    expect(isRun([up(0)])).toBe(false);
  });
});

describe("confirmation bars at the line", () => {
  it("reads a long lower wick under a rising close as a pin bar", () => {
    expect(isPinbar(candle({ open: 970, high: 1_000, low: 900, close: 990 }))).toBe(true);
  });

  it("rejects a rising close with a short wick", () => {
    expect(isPinbar(candle({ open: 910, high: 1_000, low: 900, close: 990 }))).toBe(false);
  });

  it("rejects a falling close however long the wick", () => {
    expect(isPinbar(candle({ open: 990, high: 1_000, low: 900, close: 970 }))).toBe(false);
  });

  it("rejects a bar with no range at all", () => {
    expect(isPinbar(candle({ open: 100, high: 100, low: 100, close: 100 }))).toBe(false);
  });

  it("reads a close above a previous down bar's open as engulfing", () => {
    const previous = candle({ open: 105, close: 100 });
    expect(isBullishEngulfing(candle({ open: 95, close: 108 }), previous)).toBe(true);
  });

  it("is not engulfing when the previous bar rose", () => {
    const previous = candle({ open: 100, close: 105 });
    expect(isBullishEngulfing(candle({ open: 95, close: 108 }), previous)).toBe(false);
  });

  it("is not engulfing without a previous bar", () => {
    expect(isBullishEngulfing(candle(), undefined)).toBe(false);
  });
});

describe("the daily trend filter", () => {
  it("passes when today opened above yesterday's high", () => {
    const daily = [candle({ high: 100, close: 95 }), candle({ open: 105 })];
    expect(trendIsBullish(daily)).toBe(true);
  });

  it("passes on the moving averages when the gap test does not", () => {
    // Sixty rising closes: the fast average leads the slow one.
    const rising = Array.from({ length: 61 }, (_, i) => candle({ open: 100 + i, close: 100 + i, high: 100 + i }));
    expect(trendIsBullish(rising)).toBe(true);
  });

  it("fails on a falling series", () => {
    const falling = Array.from({ length: 61 }, (_, i) => candle({ open: 200 - i, close: 200 - i, high: 200 - i }));
    expect(trendIsBullish(falling)).toBe(false);
  });

  it("fails rather than guessing with almost no history", () => {
    expect(trendIsBullish([candle()])).toBe(false);
  });
});

describe("position sizing", () => {
  it("buys the quantity that makes a stop-out cost the risk budget", () => {
    // 1R is 100원; a 500,000원 risk budget is 5,000 shares, but the order
    // ceiling allows only 500 of a 10,000원 stock.
    expect(sizePosition(10_000, 9_900, 5_000_000, 500_000)).toBe(500);
  });

  it("lets the risk budget bind when the stop is wide", () => {
    // 1R is 1,000원; the risk budget allows 500 shares, the ceiling 500.
    expect(sizePosition(10_000, 9_000, 5_000_000, 500_000)).toBe(500);
  });

  it("takes the smaller of the two, never the larger", () => {
    const tight = sizePosition(10_000, 9_990, 1_000_000, 500_000); // risk allows 50,000
    expect(tight).toBe(100); // ceiling allows 100
  });

  it("refuses a stop at or above the entry", () => {
    expect(sizePosition(10_000, 10_000, 5_000_000, 500_000)).toBe(0);
    expect(sizePosition(10_000, 10_500, 5_000_000, 500_000)).toBe(0);
  });

  it("rounds down to whole shares", () => {
    expect(Number.isInteger(sizePosition(3_333, 3_300, 1_000_000, 100_000))).toBe(true);
  });
});
