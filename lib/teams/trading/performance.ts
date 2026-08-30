import { createAdminClient } from "@/lib/supabase/admin";

import { TRADING_CONFIG } from "./config";
import { fetchAccountSummary, fetchDailyFills, type Fill } from "./kis";

/**
 * What the session was worth, written down before it can be lost.
 *
 * The broker forgets a position the moment it is flattened: the balance shows
 * what is held now, never what a closed trade sold for. So the result of a
 * morning is recoverable for about an hour after it ends, and then it is gone.
 * Everything here exists to capture it inside that window -- the day's fills,
 * what each strategy made from them, and what the account was worth at the end.
 *
 * It is also what a promotion is decided on. "This strategy is profitable" is
 * not a claim the desk could previously evaluate about itself.
 */

type OrderRow = {
  id: string;
  tick_id: string | null;
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  filled_quantity: number;
  kis_order_no: string | null;
};

/**
 * Write the executed price and quantity onto the orders they belong to.
 *
 * Matched on the broker's order number where there is one, and on the ticker
 * and side otherwise -- a ticker is bought once a day by one strategy, so the
 * fallback is unambiguous for buys, and sells of a name all belong to whoever
 * owned it.
 */
async function applyFills(orders: OrderRow[], fills: Fill[]): Promise<void> {
  const supabase = createAdminClient();

  for (const fill of fills) {
    const match =
      orders.find((o) => o.kis_order_no && o.kis_order_no === fill.orderNo) ??
      orders.find((o) => o.ticker === fill.ticker && o.side === fill.side);

    if (!match) {
      console.warn(`fill for ${fill.ticker} (${fill.orderNo}) matched no order`);
      continue;
    }

    const { error } = await supabase
      .from("orders")
      .update({
        filled_quantity: fill.quantity,
        filled_price: fill.price,
        status: fill.quantity >= match.quantity ? "filled" : "submitted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", match.id);

    if (error) console.warn(`applying fill to ${match.ticker} failed: ${error.message}`);
  }
}

/**
 * Realised profit per strategy, in KRW.
 *
 * Proceeds minus cost, per ticker, credited to whoever bought it. Every
 * position is flattened before the close, so on a normal session this is the
 * whole result rather than a partial view -- and it is only attributable at all
 * because a ticker belongs to exactly one strategy for the day.
 *
 * A name still held when this runs is left out rather than marked to market:
 * an unrealised number sitting in a column called realised is the kind of thing
 * that gets believed later.
 */
export function realisedByStrategy(
  fills: Fill[],
  ownerByTicker: Map<string, string>,
): { total: number; byStrategy: Record<string, number> } {
  const bought = new Map<string, { qty: number; cost: number }>();
  const sold = new Map<string, { qty: number; proceeds: number }>();

  for (const fill of fills) {
    const bucket = fill.side === "buy" ? bought : sold;
    const key = fill.ticker;
    const entry = bucket.get(key) ?? { qty: 0, cost: 0, proceeds: 0 };
    entry.qty += fill.quantity;
    if (fill.side === "buy") {
      (entry as { cost: number }).cost += fill.quantity * fill.price;
    } else {
      (entry as { proceeds: number }).proceeds += fill.quantity * fill.price;
    }
    bucket.set(key, entry as never);
  }

  const byStrategy: Record<string, number> = {};
  let total = 0;

  for (const [ticker, sale] of sold) {
    const buy = bought.get(ticker);
    if (!buy || buy.qty <= 0) continue;

    // Cost of the shares actually sold, not of everything bought -- a partial
    // exit should not book the whole position's cost against it.
    const unitCost = buy.cost / buy.qty;
    const realised = sale.proceeds - unitCost * sale.qty;
    const owner = ownerByTicker.get(ticker) ?? "unattributed";

    byStrategy[owner] = (byStrategy[owner] ?? 0) + realised;
    total += realised;
  }

  return { total, byStrategy };
}

export type SessionResult = {
  realised: number;
  byStrategy: Record<string, number>;
  cash: number | null;
  holdingsValue: number | null;
  unrealisedPnl: number | null;
  totalEquity: number | null;
};

/**
 * Capture the session: fills, profit, and what the account is worth.
 *
 * Deliberately tolerant. A failure to record must not fail the close -- the
 * positions are already flat by the time this runs, and losing the record of a
 * session is better than leaving the desk in a state where the close reported
 * itself failed.
 */
export async function captureSession(
  runId: string,
  tradeDate: string,
  ownerByTicker: Map<string, string>,
): Promise<SessionResult> {
  const supabase = createAdminClient();

  const [summary, daily] = await Promise.all([
    fetchAccountSummary().catch(() => null),
    fetchDailyFills(tradeDate).catch((cause) => {
      console.warn(`fills unavailable: ${cause instanceof Error ? cause.message : cause}`);
      return { fills: [] as Fill[], raw: null };
    }),
  ]);

  if (daily.fills.length) {
    const { data: orderRows } = await supabase
      .from("orders")
      .select("id, tick_id, ticker, side, quantity, filled_quantity, kis_order_no")
      .eq("run_id", runId)
      .in("status", ["submitted", "filled"]);

    await applyFills((orderRows ?? []) as OrderRow[], daily.fills);
  }

  const { total, byStrategy } = realisedByStrategy(daily.fills, ownerByTicker);

  const cash = summary?.cash ?? null;
  const holdingsValue = summary?.holdingsValue ?? null;
  const totalEquity = cash !== null && holdingsValue !== null ? cash + holdingsValue : null;

  const { error } = await supabase.from("equity_snapshots").upsert(
    {
      trade_date: tradeDate,
      environment: TRADING_CONFIG.environment,
      cash_krw: cash,
      holdings_value_krw: holdingsValue,
      total_equity_krw: totalEquity,
      unrealised_pnl_krw: summary?.unrealisedPnl ?? null,
      realised_pnl_krw: total,
      by_strategy: byStrategy,
      capital_krw: TRADING_CONFIG.capitalKrw,
      fills_raw: daily.raw ?? null,
      captured_at: new Date().toISOString(),
    },
    { onConflict: "trade_date,environment" },
  );

  if (error) console.warn(`equity snapshot failed: ${error.message}`);

  return {
    realised: total,
    byStrategy,
    cash,
    holdingsValue,
    unrealisedPnl: summary?.unrealisedPnl ?? null,
    totalEquity,
  };
}
