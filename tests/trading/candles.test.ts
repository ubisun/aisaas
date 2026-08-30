import { describe, expect, it } from "vitest";

import { atr, ema, openingRange, volumeMa } from "@/lib/teams/trading/candles";
import { aggregate } from "@/lib/teams/trading/kis";

import { candle } from "../helpers/builders";

/**
 * Bars and the numbers read off them.
 *
 * Everything the opening-range strategy decides rests on these, and they are
 * the kind of arithmetic that is wrong quietly. The date filtering in
 * particular: the KIS endpoints walk backwards from a requested time and cross
 * into the previous session without saying so, so a request ending 09:35 came
 * back beginning at yesterday 13:57. Matching bars on the clock alone folded
 * yesterday's opening range into today's, and nothing about the result looked
 * wrong.
 */

const minute = (time: string, over: Partial<ReturnType<typeof candle>> = {}) =>
  candle({ time, ...over });

describe("aggregate", () => {
  it("folds five one-minute bars into one five-minute bar", () => {
    const bars = [
      minute("0935", { open: 100, high: 110, low: 95, close: 105, volume: 10 }),
      minute("0936", { open: 105, high: 130, low: 104, close: 120, volume: 20 }),
      minute("0937", { open: 120, high: 125, low: 90, close: 95, volume: 30 }),
      minute("0938", { open: 95, high: 100, low: 94, close: 99, volume: 40 }),
      minute("0939", { open: 99, high: 101, low: 97, close: 100, volume: 50 }),
    ];

    const [bar] = aggregate(bars, 5);
    expect(bar.time).toBe("0935");
    expect(bar.open).toBe(100); // the first open
    expect(bar.close).toBe(100); // the last close
    expect(bar.high).toBe(130); // the extreme high
    expect(bar.low).toBe(90); // the extreme low
    expect(bar.volume).toBe(150); // the sum
  });

  it("buckets by wall clock, so a minute that did not trade shifts nothing", () => {
    // 09:36 and 09:38 are missing; the survivors still land in the 09:35 bucket.
    const bars = [minute("0935"), minute("0937"), minute("0939"), minute("0940")];
    const out = aggregate(bars, 5);
    expect(out.map((b) => b.time)).toEqual(["0935", "0940"]);
  });

  it("keeps different days in different buckets", () => {
    const bars = [
      minute("0935", { date: "20260828" }),
      minute("0935", { date: "20260831" }),
    ];
    expect(aggregate(bars, 5)).toHaveLength(2);
  });

  it("supports a thirty-minute bar", () => {
    const bars = Array.from({ length: 30 }, (_, i) =>
      minute(String(900 + i).padStart(4, "0"), { high: 100 + i }),
    );
    const out = aggregate(bars, 30);
    expect(out).toHaveLength(1);
    expect(out[0].high).toBe(129);
  });

  it("ignores a bar with no usable timestamp", () => {
    expect(aggregate([minute("")], 5)).toHaveLength(0);
  });
});

describe("openingRange", () => {
  const today = "2026-08-31";
  const stamp = "20260831";

  it("is the high and low of the first thirty minutes", () => {
    const bars = [
      minute("0900", { date: stamp, high: 105, low: 99 }),
      minute("0915", { date: stamp, high: 120, low: 95 }),
      minute("0929", { date: stamp, high: 110, low: 100 }),
      minute("0935", { date: stamp, high: 200, low: 50 }), // outside the range
    ];
    const range = openingRange(bars, today);
    expect(range).toEqual({ high: 120, low: 95, complete: true });
  });

  it("reports itself incomplete while the window is still running", () => {
    const bars = [minute("0900", { date: stamp }), minute("0925", { date: stamp })];
    expect(openingRange(bars, today)?.complete).toBe(false);
  });

  it("is complete from the first bar after the window", () => {
    const bars = [minute("0900", { date: stamp }), minute("0930", { date: stamp })];
    expect(openingRange(bars, today)?.complete).toBe(true);
  });

  it("ignores the previous session even at the same clock time", () => {
    const bars = [
      minute("0900", { date: "20260828", high: 9_999, low: 1 }), // yesterday
      minute("0905", { date: stamp, high: 105, low: 100 }),
      minute("0931", { date: stamp }),
    ];
    const range = openingRange(bars, today);
    expect(range?.high).toBe(105);
    expect(range?.low).toBe(100);
  });

  it("is null when the session has produced nothing yet", () => {
    expect(openingRange([minute("0900", { date: "20260828" })], today)).toBeNull();
  });
});

describe("indicators", () => {
  it("needs one more bar than its period to compute a true range", () => {
    expect(atr(Array.from({ length: 14 }, () => candle()), 14)).toBeNull();
    expect(atr(Array.from({ length: 15 }, () => candle()), 14)).not.toBeNull();
  });

  it("measures the true range including the gap from the previous close", () => {
    const bars = [
      candle({ high: 100, low: 100, close: 100 }),
      candle({ high: 120, low: 110, close: 115 }),
    ];
    // Range 10, but the gap from the previous close to the high is 20.
    expect(atr(bars, 1)).toBe(20);
  });

  it("averages volume over the period and no further", () => {
    const bars = [
      candle({ volume: 1_000_000 }), // outside a two-bar window
      candle({ volume: 100 }),
      candle({ volume: 300 }),
    ];
    expect(volumeMa(bars, 2)).toBe(200);
    expect(volumeMa(bars, 5)).toBeNull();
  });

  it("weights an exponential average towards the recent bars", () => {
    const flat = Array.from({ length: 20 }, () => candle({ close: 100 }));
    expect(ema(flat, 20)).toBe(100);

    const rising = [...flat, candle({ close: 200 })];
    const value = ema(rising, 20);
    expect(value).toBeGreaterThan(100);
    expect(value).toBeLessThan(200);
  });

  it("returns null rather than a number built from too little history", () => {
    expect(ema([candle()], 20)).toBeNull();
    expect(volumeMa([], 5)).toBeNull();
    expect(atr([], 14)).toBeNull();
  });
});
