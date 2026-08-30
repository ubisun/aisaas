import { describe, expect, it } from "vitest";

import { TRADING_CONFIG } from "@/lib/teams/trading/config";
import { mandatoryExits, screenEntries, screenExits, windowState } from "@/lib/teams/trading/risk";
import type { ProposedOrder } from "@/lib/teams/trading/types";

import { candidate, kst, position, tickContext } from "../helpers/builders";

/**
 * The desk's non-negotiables, asserted against everything a strategy might ask
 * for rather than against one case at a time.
 *
 * The other files test rules. This one tests that no combination of them lets
 * something through -- which is the failure a new strategy actually causes. A
 * strategy is written to be clever, and the gate's job is to be unimpressed by
 * cleverness it did not anticipate.
 *
 * **Adding a strategy does not mean adding cases here.** These run against
 * whatever proposals are generated below, so a new strategy is covered by
 * construction. Add to this file only when the desk gains a new promise.
 */

const { limits, window: w } = TRADING_CONFIG;

/**
 * A deliberately hostile spread of proposals: absurd sizes, unknown tickers,
 * sells, duplicates, fractions. Roughly what a strategy looks like on the day
 * it has a bug.
 */
function hostileProposals(): ProposedOrder[] {
  const tickers = ["005930", "000660", "999999", "005930"];
  const quantities = [1, 10, 100, 10_000, 0, -1, 2.5];
  const sides: ProposedOrder["side"][] = ["buy", "sell"];

  const orders: ProposedOrder[] = [];
  for (const ticker of tickers) {
    for (const quantity of quantities) {
      for (const side of sides) {
        orders.push({ ticker, side, quantity, reason: "fuzz" });
      }
    }
  }
  return orders;
}

const SHORTLIST = [candidate({ ticker: "005930" }), candidate({ ticker: "000660" })];

const TIMES = ["08:00", "09:09", "09:10", "10:30", "11:29", "11:30", "14:00", "15:14", "15:15", "16:00"];

describe("no entry ever escapes the desk's promises", () => {
  const context = tickContext({ candidates: SHORTLIST, maxOrderValueKrw: 5_000_000 });

  for (const time of TIMES) {
    it(`holds at ${time} KST`, () => {
      const at = kst("2026-08-31", time);
      const verdicts = screenEntries({
        context,
        proposals: hostileProposals(),
        strategyLossPct: 0,
        accountLossPct: 0,
        claimedByOthers: new Set(),
        ordersSoFar: 0,
        at,
      });

      const passed = verdicts.filter((v) => v.allowed).map((v) => v.order);

      // Outside the entry window nothing may be bought at all.
      if (windowState(at) !== "entries-open") {
        expect(passed).toHaveLength(0);
        return;
      }

      expect(passed.length).toBeLessThanOrEqual(limits.maxEntriesPerDay);

      for (const order of passed) {
        expect(order.side).toBe("buy");
        expect(Number.isInteger(order.quantity)).toBe(true);
        expect(order.quantity).toBeGreaterThan(0);

        // Only from the shortlist.
        const listed = SHORTLIST.find((c) => c.ticker === order.ticker);
        expect(listed).toBeDefined();

        // Never above the order ceiling.
        const price = order.limitPrice ?? listed!.price;
        expect(price * order.quantity).toBeLessThanOrEqual(context.maxOrderValueKrw);
      }

      // Never the same name twice.
      const names = passed.map((o) => o.ticker);
      expect(new Set(names).size).toBe(names.length);
    });
  }

  it("buys nothing once either loss limit is reached, at any time of day", () => {
    for (const time of TIMES) {
      for (const [strategyLossPct, accountLossPct] of [
        [limits.strategyLossLimitPct, 0],
        [0, limits.dailyLossLimitPct],
        [limits.strategyLossLimitPct, limits.dailyLossLimitPct],
      ]) {
        const verdicts = screenEntries({
          context,
          proposals: hostileProposals(),
          strategyLossPct,
          accountLossPct,
          claimedByOthers: new Set(),
          ordersSoFar: 0,
          at: kst("2026-08-31", time),
        });
        expect(verdicts.filter((v) => v.allowed)).toHaveLength(0);
      }
    }
  });

  it("never buys a name another strategy has taken", () => {
    const verdicts = screenEntries({
      context,
      proposals: hostileProposals(),
      strategyLossPct: 0,
      accountLossPct: 0,
      claimedByOthers: new Set(["005930", "000660"]),
      ordersSoFar: 0,
      at: kst("2026-08-31", "10:00"),
    });
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(0);
  });

  it("records a reason for every refusal", () => {
    const verdicts = screenEntries({
      context,
      proposals: hostileProposals(),
      strategyLossPct: 0,
      accountLossPct: 0,
      claimedByOthers: new Set(),
      ordersSoFar: 0,
      at: kst("2026-08-31", "10:00"),
    });

    for (const verdict of verdicts) {
      if (verdict.allowed) continue;
      expect(verdict.reason.length).toBeGreaterThan(0);
      // The strategy's own intent survives alongside the refusal, so a
      // strategy that keeps asking for the impossible is visible later.
      expect(verdict.order.reason).toBe("fuzz");
    }
  });
});

describe("a held position is always closable", () => {
  const held = [
    position({ ticker: "005930", pnlPct: -30 }),
    position({ ticker: "000660", pnlPct: 40, stopLoss: 9_000, takeProfit: 11_000 }),
  ];

  it("generates and passes exits whatever the desk has lost", () => {
    for (const time of ["09:15", "11:30", "15:15", "15:30"]) {
      const at = kst("2026-08-31", time);
      const exits = mandatoryExits(held, at);
      const verdicts = screenExits(held, exits, at);
      expect(verdicts.every((v) => v.allowed)).toBe(true);
    }
  });

  it("flattens everything held once the session closes", () => {
    const at = kst("2026-08-31", "15:20");
    const exits = mandatoryExits(held, at);
    expect(exits.map((o) => o.ticker).sort()).toEqual(["000660", "005930"]);
    expect(exits.every((o) => o.side === "sell")).toBe(true);
  });

  it("never sells more than is sellable", () => {
    const partial = [position({ quantity: 10, sellableQuantity: 3, boughtQuantity: 10, pnlPct: -10 })];
    for (const time of ["10:00", "15:20"]) {
      const at = kst("2026-08-31", time);
      for (const order of mandatoryExits(partial, at)) {
        expect(order.quantity).toBeLessThanOrEqual(3);
      }
    }
  });

  it("never generates a buy", () => {
    for (const time of TIMES) {
      const exits = mandatoryExits(held, kst("2026-08-31", time));
      expect(exits.every((o) => o.side === "sell")).toBe(true);
    }
  });
});

describe("the window itself", () => {
  it("closes entries before it flattens, never the other way round", () => {
    const lastEntry = w.lastEntryHour * 60 + w.lastEntryMinute;
    const close = w.closeHour * 60 + w.closeMinute;
    const open = w.openHour * 60 + w.openMinute;
    expect(open).toBeLessThan(lastEntry);
    expect(lastEntry).toBeLessThanOrEqual(close);
  });

  it("flattens before the closing auction begins at 15:20", () => {
    // An order sent into the auction does not trade, and the position would
    // carry overnight -- which breaks the premise that the same capital is
    // available again the next morning.
    expect(w.closeHour * 60 + w.closeMinute).toBeLessThan(15 * 60 + 20);
  });
});
