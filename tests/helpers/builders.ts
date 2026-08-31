import type { Candle } from "@/lib/teams/trading/kis";
import type { OrderRow } from "@/lib/teams/trading/session";
import type { Candidate, Position, ProposedOrder, TickContext } from "@/lib/teams/trading/types";

/**
 * Builders for the shapes the desk passes around.
 *
 * Every one takes a partial override and fills the rest with something valid,
 * so a test states only what it is actually about. A test for the order-value
 * ceiling should not have to invent a market capitalisation, and when a type
 * gains a field, tests that do not care about it keep compiling.
 *
 * This is the part that decides whether the next person writing a test finds it
 * cheap enough to bother.
 */

/** 09:00 KST on the given trading day, as a UTC instant. */
export function kst(date: string, time = "09:00"): Date {
  const [hour, minute] = time.split(":").map(Number);
  const utc = new Date(`${date}T00:00:00Z`);
  utc.setUTCHours(hour - 9, minute, 0, 0);
  return utc;
}

/** A one-minute or aggregated bar. Defaults to a flat, unremarkable candle. */
export function candle(over: Partial<Candle> = {}): Candle {
  return {
    time: "0935",
    date: "20260831",
    open: 10_000,
    high: 10_050,
    low: 9_950,
    close: 10_000,
    volume: 1_000,
    ...over,
  };
}

/** `count` flat bars, for warming an indicator up to its period. */
export function flatSeries(count: number, over: Partial<Candle> = {}): Candle[] {
  return Array.from({ length: count }, (_, i) =>
    candle({ time: String(900 + i).padStart(4, "0"), ...over }),
  );
}

export function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    ticker: "005930",
    name: "삼성전자",
    price: 10_000,
    changePct: 3.2,
    turnover: 50_000_000_000,
    turnoverToMarketCapPct: 4.5,
    ...over,
  };
}

export function position(over: Partial<Position> = {}): Position {
  return {
    ticker: "005930",
    name: "삼성전자",
    quantity: 10,
    sellableQuantity: 10,
    boughtQuantity: 10,
    averagePrice: 10_000,
    currentPrice: 10_000,
    pnlPct: 0,
    stopLoss: null,
    takeProfit: null,
    ...over,
  };
}

export function order(over: Partial<ProposedOrder> = {}): ProposedOrder {
  return {
    ticker: "005930",
    side: "buy",
    quantity: 10,
    reason: "test",
    ...over,
  };
}

export function orderRow(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "order-1",
    tick_id: "tick-1",
    ticker: "005930",
    side: "buy",
    quantity: 10,
    status: "submitted",
    filled_quantity: 10,
    kis_order_no: "0000000001",
    stop_loss: null,
    take_profit: null,
    ...over,
  };
}

/**
 * A tick context with room to trade: entries unused, budget intact, one
 * candidate on the shortlist. A test that wants a constraint sets it.
 */
export function tickContext(over: Partial<TickContext> = {}): TickContext {
  return {
    tradeDate: "2026-08-31",
    previousTradeDate: "2026-08-28",
    runId: "run-1",
    observedAt: "09:35",
    minutesToLastEntry: 115,
    candidates: [candidate()],
    positions: [],
    sectorOutlook: [],
    entriesUsed: 0,
    entryBudget: 2,
    ordersSoFar: 0,
    maxOrderValueKrw: 5_000_000,
    budgetKrw: 10_000_000,
    ...over,
  };
}

/** The arguments `screenEntries` needs, with nothing blocking by default. */
export function entryGate(over: Record<string, unknown> = {}) {
  return {
    context: tickContext(),
    proposals: [order()],
    strategyLossPct: 0,
    accountLossPct: 0,
    claimedByOthers: new Set<string>(),
    ordersSoFar: 0,
    at: kst("2026-08-31", "09:35"),
    ...over,
  };
}
