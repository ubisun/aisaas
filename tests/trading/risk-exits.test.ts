import { describe, expect, it } from "vitest";

import { TRADING_CONFIG } from "@/lib/teams/trading/config";
import { mandatoryExits, screenExits } from "@/lib/teams/trading/risk";

import { kst, order, position } from "../helpers/builders";

/**
 * Exits.
 *
 * The gate generates these rather than screening them, because a strategy that
 * could decline a stop would eventually decline one. Two properties matter more
 * than any individual rule here and are asserted first: an exit is never
 * refused for a reason that exists to reduce risk, and the flatten always
 * happens.
 *
 * Both were broken on 2026-08-30. The loss limit was checked before the
 * buy/sell branch, so reaching it denied the stop-losses too -- the desk would
 * have been locked into exactly the positions the limit existed to escape.
 */

const { exits } = TRADING_CONFIG;
const OPEN = kst("2026-08-31", "10:00");
const AFTER_CLOSE = kst("2026-08-31", "15:20");

describe("exits are never blocked by a risk control", () => {
  it("is generated for a stop regardless of how much the desk has lost", () => {
    const orders = mandatoryExits([position({ pnlPct: -5 })], OPEN);
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe("sell");
  });

  it("passes the exit gate, which has no loss limit and no order cap to hit", () => {
    const held = position({ pnlPct: -5 });
    const verdicts = screenExits([held], mandatoryExits([held], OPEN), OPEN);
    expect(verdicts.every((v) => v.allowed)).toBe(true);
  });
});

describe("the house rules", () => {
  it("stops out at the configured loss", () => {
    const orders = mandatoryExits([position({ pnlPct: exits.stopLossPct })], OPEN);
    expect(orders[0].reason).toMatch(/Stop loss/);
    expect(orders[0].quantity).toBe(10);
  });

  it("leaves a position alone just above the stop", () => {
    expect(mandatoryExits([position({ pnlPct: exits.stopLossPct + 0.01 })], OPEN)).toHaveLength(0);
  });

  it("takes half off at the first rung", () => {
    const orders = mandatoryExits([position({ pnlPct: exits.ladder[0].atPct })], OPEN);
    expect(orders[0].quantity).toBe(5);
    expect(orders[0].reason).toMatch(/Take profit/);
  });

  it("takes the rest at the second rung", () => {
    const held = position({ quantity: 5, sellableQuantity: 5, boughtQuantity: 10, pnlPct: 5 });
    const orders = mandatoryExits([held], OPEN);
    expect(orders[0].quantity).toBe(5);
  });

  it("does not take the same rung twice", () => {
    // Half already sold, price back at the first rung: nothing further is owed.
    const held = position({ quantity: 5, sellableQuantity: 5, boughtQuantity: 10, pnlPct: 3 });
    expect(mandatoryExits([held], OPEN)).toHaveLength(0);
  });

  it("closes a remainder that gives back what the first rung proved", () => {
    const held = position({
      quantity: 5,
      sellableQuantity: 5,
      boughtQuantity: 10,
      pnlPct: exits.giveBackPct,
    });
    const orders = mandatoryExits([held], OPEN);
    expect(orders[0].reason).toMatch(/Gave back/);
    expect(orders[0].quantity).toBe(5);
  });

  it("does not apply the give-back rule to an untouched position", () => {
    const held = position({ quantity: 10, boughtQuantity: 10, pnlPct: exits.giveBackPct });
    expect(mandatoryExits([held], OPEN)).toHaveLength(0);
  });
});

describe("levels carried by the entry replace the house rules", () => {
  it("sells at the strategy's stop rather than at the house percentage", () => {
    const held = position({
      currentPrice: 9_800,
      stopLoss: 9_900,
      takeProfit: 10_300,
      pnlPct: -2,
    });
    const orders = mandatoryExits([held], OPEN);
    expect(orders[0].reason).toMatch(/Stop at/);
    expect(orders[0].quantity).toBe(10);
  });

  it("sells the whole position at the strategy's target, not half", () => {
    const held = position({
      currentPrice: 10_400,
      stopLoss: 9_900,
      takeProfit: 10_300,
      pnlPct: 4,
    });
    const orders = mandatoryExits([held], OPEN);
    expect(orders[0].reason).toMatch(/Take profit at/);
    expect(orders[0].quantity).toBe(10);
  });

  it("holds between its own levels even where a house rung would have fired", () => {
    // +3% would take half off under the house ladder; this position has its own
    // target and has not reached it.
    const held = position({
      currentPrice: 10_300,
      stopLoss: 9_500,
      takeProfit: 11_000,
      pnlPct: 3,
    });
    expect(mandatoryExits([held], OPEN)).toHaveLength(0);
  });

  it("still flattens at the close", () => {
    const held = position({ currentPrice: 10_100, stopLoss: 9_500, takeProfit: 11_000 });
    const orders = mandatoryExits([held], AFTER_CLOSE);
    expect(orders[0].reason).toMatch(/flattening/i);
  });
});

describe("the flatten", () => {
  it("sells everything held once the session is closed", () => {
    const orders = mandatoryExits(
      [position({ ticker: "A" }), position({ ticker: "B", pnlPct: 12 })],
      AFTER_CLOSE,
    );
    expect(orders).toHaveLength(2);
    expect(orders.every((o) => o.reason.includes("flattening"))).toBe(true);
  });

  it("generates nothing before the session opens", () => {
    expect(mandatoryExits([position()], kst("2026-08-31", "08:00"))).toHaveLength(0);
  });

  it("skips a position with nothing sellable", () => {
    expect(mandatoryExits([position({ sellableQuantity: 0 })], AFTER_CLOSE)).toHaveLength(0);
  });
});

describe("the exit gate checks only what can stop a fill", () => {
  it("refuses a sale of something not held", () => {
    const verdicts = screenExits([], [order({ side: "sell" })], OPEN);
    expect(verdicts[0].allowed).toBe(false);
  });

  it("refuses a sale larger than the sellable quantity", () => {
    const held = position({ sellableQuantity: 4 });
    const verdicts = screenExits([held], [order({ side: "sell", quantity: 10 })], OPEN);
    expect(verdicts[0].allowed).toBe(false);
    expect((verdicts[0] as { reason: string }).reason).toMatch(/only 4 sellable/);
  });

  it("allows a sale of exactly what is sellable", () => {
    const held = position({ sellableQuantity: 4 });
    const verdicts = screenExits([held], [order({ side: "sell", quantity: 4 })], OPEN);
    expect(verdicts[0].allowed).toBe(true);
  });
});
