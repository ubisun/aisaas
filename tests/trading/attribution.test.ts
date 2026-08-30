import { describe, expect, it } from "vitest";

import { realisedByStrategy } from "@/lib/teams/trading/performance";
import { buildPositions, lossPctOf, ownerMap } from "@/lib/teams/trading/session";

import { orderRow, position } from "../helpers/builders";

/**
 * Who owned what, and what it made.
 *
 * This is the arithmetic a promotion decision rests on. It is only possible at
 * all because a ticker belongs to exactly one strategy for the session -- that
 * single rule is what replaces a position ledger, and every test here depends
 * on it holding.
 */

const holding = (over: Record<string, unknown> = {}) => ({
  ticker: "005930",
  name: "삼성전자",
  quantity: 10,
  sellableQuantity: 10,
  averagePrice: 10_000,
  currentPrice: 10_000,
  pnlPct: 0,
  ...over,
});

const strategies = new Map([
  ["tick-orb", "orb-v1"],
  ["tick-agent", "agent-v1"],
  ["tick-gate", "risk-gate"],
]);

describe("ownerMap", () => {
  it("credits a ticker to the strategy whose buy was submitted", () => {
    const owners = ownerMap([orderRow({ tick_id: "tick-orb" })], strategies);
    expect(owners.get("005930")).toBe("orb-v1");
  });

  it("keeps the first claim when a name somehow appears twice", () => {
    const owners = ownerMap(
      [
        orderRow({ id: "1", tick_id: "tick-orb" }),
        orderRow({ id: "2", tick_id: "tick-agent" }),
      ],
      strategies,
    );
    expect(owners.get("005930")).toBe("orb-v1");
  });

  it("does not claim on a rejected order", () => {
    const owners = ownerMap([orderRow({ status: "rejected" })], strategies);
    expect(owners.size).toBe(0);
  });

  it("does not claim on a sell", () => {
    const owners = ownerMap([orderRow({ side: "sell", tick_id: "tick-gate" })], strategies);
    expect(owners.size).toBe(0);
  });

  it("ignores an order that cannot be traced to a strategy", () => {
    const owners = ownerMap([orderRow({ tick_id: null })], strategies);
    expect(owners.size).toBe(0);
  });

  it("keeps two strategies apart", () => {
    const owners = ownerMap(
      [
        orderRow({ id: "1", ticker: "005930", tick_id: "tick-orb" }),
        orderRow({ id: "2", ticker: "000660", tick_id: "tick-agent" }),
      ],
      strategies,
    );
    expect([...owners]).toEqual([
      ["005930", "orb-v1"],
      ["000660", "agent-v1"],
    ]);
  });
});

describe("buildPositions", () => {
  it("measures the ladder against what was filled, not what was ordered", () => {
    const [built] = buildPositions(
      [holding({ quantity: 6 })],
      [orderRow({ quantity: 10, filled_quantity: 6 })],
    );
    expect(built.boughtQuantity).toBe(6);
  });

  it("carries the exit levels the entry was placed with", () => {
    const [built] = buildPositions(
      [holding()],
      [orderRow({ stop_loss: 9_900, take_profit: 10_300 })],
    );
    expect(built.stopLoss).toBe(9_900);
    expect(built.takeProfit).toBe(10_300);
  });

  it("leaves the levels null when the entry had no opinion", () => {
    const [built] = buildPositions([holding()], [orderRow()]);
    expect(built.stopLoss).toBeNull();
    expect(built.takeProfit).toBeNull();
  });

  it("falls back to the held quantity for a position it has no order for", () => {
    const [built] = buildPositions([holding({ quantity: 7 })], []);
    expect(built.boughtQuantity).toBe(7);
  });
});

describe("lossPctOf", () => {
  it("is zero while a position is in profit", () => {
    expect(lossPctOf([position({ averagePrice: 10_000, currentPrice: 11_000 })], 10_000_000)).toBe(0);
  });

  it("is a positive percentage of the base when losing", () => {
    // 10 shares down 1,000원 each is 10,000원, against a 1,000,000원 base.
    const held = position({ quantity: 10, averagePrice: 10_000, currentPrice: 9_000 });
    expect(lossPctOf([held], 1_000_000)).toBe(1);
  });

  it("nets gains against losses across positions", () => {
    const winner = position({ ticker: "A", quantity: 10, averagePrice: 10_000, currentPrice: 11_000 });
    const loser = position({ ticker: "B", quantity: 10, averagePrice: 10_000, currentPrice: 9_000 });
    expect(lossPctOf([winner, loser], 1_000_000)).toBe(0);
  });

  it("is zero against a base of nothing rather than infinite", () => {
    expect(lossPctOf([position({ currentPrice: 1 })], 0)).toBe(0);
  });
});

describe("realisedByStrategy", () => {
  const fill = (ticker: string, side: "buy" | "sell", quantity: number, price: number) => ({
    orderNo: "",
    ticker,
    side,
    quantity,
    price,
  });

  it("books proceeds less cost to the strategy that bought", () => {
    const result = realisedByStrategy(
      [fill("005930", "buy", 10, 10_000), fill("005930", "sell", 10, 10_300)],
      new Map([["005930", "orb-v1"]]),
    );
    expect(result.total).toBe(3_000);
    expect(result.byStrategy["orb-v1"]).toBe(3_000);
  });

  it("books a loss the same way", () => {
    const result = realisedByStrategy(
      [fill("A", "buy", 10, 10_000), fill("A", "sell", 10, 9_800)],
      new Map([["A", "orb-v1"]]),
    );
    expect(result.total).toBe(-2_000);
  });

  it("sums a laddered exit", () => {
    const result = realisedByStrategy(
      [
        fill("B", "buy", 10, 10_000),
        fill("B", "sell", 5, 10_300),
        fill("B", "sell", 5, 10_500),
      ],
      new Map([["B", "orb-v1"]]),
    );
    expect(result.total).toBe(5 * 300 + 5 * 500);
  });

  it("charges only the cost of the shares actually sold", () => {
    const result = realisedByStrategy(
      [fill("C", "buy", 10, 10_000), fill("C", "sell", 6, 10_200)],
      new Map([["C", "orb-v1"]]),
    );
    expect(result.total).toBe(6 * 200);
  });

  it("keeps two strategies' results apart", () => {
    const result = realisedByStrategy(
      [
        fill("X", "buy", 10, 10_000),
        fill("X", "sell", 10, 10_500),
        fill("Y", "buy", 10, 20_000),
        fill("Y", "sell", 10, 19_000),
      ],
      new Map([
        ["X", "orb-v1"],
        ["Y", "agent-v1"],
      ]),
    );
    expect(result.byStrategy["orb-v1"]).toBe(5_000);
    expect(result.byStrategy["agent-v1"]).toBe(-10_000);
    expect(result.total).toBe(-5_000);
  });

  it("leaves a position still held out of realised profit", () => {
    const result = realisedByStrategy(
      [fill("D", "buy", 10, 10_000)],
      new Map([["D", "orb-v1"]]),
    );
    expect(result.total).toBe(0);
    expect(Object.keys(result.byStrategy)).toHaveLength(0);
  });

  it("parks a sale it cannot attribute rather than dropping it", () => {
    const result = realisedByStrategy(
      [fill("E", "buy", 10, 10_000), fill("E", "sell", 10, 10_100)],
      new Map(),
    );
    expect(result.byStrategy.unattributed).toBe(1_000);
  });

  it("ignores a sale of something never bought", () => {
    const result = realisedByStrategy([fill("F", "sell", 10, 10_000)], new Map());
    expect(result.total).toBe(0);
  });
});
