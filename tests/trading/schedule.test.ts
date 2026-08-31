import { describe, expect, it } from "vitest";

import {
  isLikelyTradingDay,
  previousTradeDate,
  seoulTradeDate,
} from "@/lib/teams/trading/calendar";
import {
  maxOrderValueKrw,
  strategyBudgetKrw,
  TRADING_CONFIG,
} from "@/lib/teams/trading/config";
import { minutesToLastEntry, windowState } from "@/lib/teams/trading/risk";

import { kst } from "../helpers/builders";

/**
 * When the desk works, and with how much.
 *
 * Timezone arithmetic is the classic silent bug here -- the server runs in UTC,
 * the market runs in Seoul, and every one of these functions has to be right
 * across the date boundary rather than only in the middle of a Korean
 * afternoon. The suite pins TZ=UTC so a machine in Seoul cannot make a broken
 * one pass.
 */

const { window: w, capitalKrw, limits } = TRADING_CONFIG;

describe("the session clock", () => {
  it.each([
    ["before the open", "08:00", "before"],
    ["at the open", "09:10", "entries-open"],
    ["mid-morning", "10:30", "entries-open"],
    ["one minute before the deadline", "11:29", "entries-open"],
    ["on the entry deadline", "11:30", "exits-only"],
    ["holding through the afternoon", "14:00", "exits-only"],
    ["one minute before the flatten", "15:14", "exits-only"],
    ["at the flatten", "15:15", "closed"],
    ["after the bell", "16:00", "closed"],
  ])("is %s at %s", (_label, time, expected) => {
    expect(windowState(kst("2026-08-31", time))).toBe(expected);
  });

  it("matches the configured window rather than a number written twice", () => {
    const open = `${String(w.openHour).padStart(2, "0")}:${String(w.openMinute).padStart(2, "0")}`;
    expect(windowState(kst("2026-08-31", open))).toBe("entries-open");
  });

  it("counts down to the entry deadline", () => {
    expect(minutesToLastEntry(kst("2026-08-31", "11:00"))).toBe(30);
    expect(minutesToLastEntry(kst("2026-08-31", "11:30"))).toBe(0);
  });

  it("never counts down past zero", () => {
    expect(minutesToLastEntry(kst("2026-08-31", "15:00"))).toBe(0);
  });
});

describe("the trading date in Seoul", () => {
  it("is tomorrow's date when UTC is still on yesterday evening", () => {
    // 23:40 UTC on the 30th is 08:40 KST on the 31st -- the moment the desk
    // opens, and the one that would be wrong on a server clock.
    expect(seoulTradeDate(new Date("2026-08-30T23:40:00Z"))).toBe("2026-08-31");
  });

  it("is the same date in the middle of a Korean session", () => {
    expect(seoulTradeDate(new Date("2026-08-31T01:00:00Z"))).toBe("2026-08-31");
  });

  it.each([
    ["Monday", "2026-08-31", true],
    ["Friday", "2026-09-04", true],
    ["Saturday", "2026-09-05", false],
    ["Sunday", "2026-09-06", false],
  ])("treats %s as a trading day: %s", (_label, date, expected) => {
    expect(isLikelyTradingDay(kst(date, "10:00"))).toBe(expected);
  });

  it("walks back to Friday for a Monday's previous session", () => {
    expect(previousTradeDate(kst("2026-08-31", "09:00"))).toBe("2026-08-28");
  });

  it("walks back one day in the middle of a week", () => {
    expect(previousTradeDate(kst("2026-09-02", "09:00"))).toBe("2026-09-01");
  });
});

describe("capital and the ceiling derived from it", () => {
  it("splits the desk's capital evenly among the live strategies", () => {
    expect(strategyBudgetKrw(1)).toBe(capitalKrw);
    expect(strategyBudgetKrw(2)).toBe(capitalKrw / 2);
    expect(strategyBudgetKrw(4)).toBe(capitalKrw / 4);
  });

  it("sizes a shadow session by how many strategies are registered", () => {
    // Nothing live: each is sized as it would be if promoted, so its recorded
    // quantities mean something when the time comes.
    expect(strategyBudgetKrw(0, 2)).toBe(capitalKrw / 2);
  });

  it("never divides by zero", () => {
    expect(strategyBudgetKrw(0, 0)).toBe(capitalKrw);
  });

  it("derives the order ceiling from the budget and the entry count", () => {
    const budget = strategyBudgetKrw(2);
    expect(maxOrderValueKrw(budget)).toBe(Math.floor(budget / limits.maxEntriesPerDay));
  });

  it("keeps the whole budget reachable within the entry budget", () => {
    // The pair used to disagree: 5 entries of ₩1m capped the desk at a quarter
    // of its capital. Deriving one from the other is what stops that returning.
    const budget = strategyBudgetKrw(1);
    expect(maxOrderValueKrw(budget) * limits.maxEntriesPerDay).toBe(budget);
  });
});
