import { createAdminClient } from "@/lib/supabase/admin";

import { TRADING_CONFIG } from "./config";
import { fetchAccountSummary, fetchDailyFills, type Fill } from "./kis";
import type { Position } from "./types";

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

/**
 * Remember what each held position is worth right now.
 *
 * Called every tick. On the paper account this is the only trace a position
 * leaves behind: once it is sold the broker forgets the price, and the
 * execution inquiry that would have said so comes back empty.
 */
export async function markPositions(runId: string, positions: Position[]): Promise<void> {
  if (!positions.length) return;

  const supabase = createAdminClient();
  const { error } = await supabase.from("position_marks").upsert(
    positions.map((p) => ({
      run_id: runId,
      ticker: p.ticker,
      quantity: p.quantity,
      average_price: p.averagePrice,
      current_price: p.currentPrice,
      pnl_krw: (p.currentPrice - p.averagePrice) * p.quantity,
      observed_at: new Date().toISOString(),
    })),
    { onConflict: "run_id,ticker" },
  );

  if (error) console.warn(`marking positions failed: ${error.message}`);
}

/**
 * Per-strategy profit estimated from the last mark of each position.
 *
 * Used only when the execution inquiry gives nothing, which on the paper
 * account is always. It is an estimate and is labelled as one wherever it is
 * stored: it misses the slippage between the last tick and the fill, and it
 * misses fees entirely. Both surface as the residual against the broker's own
 * figure for the account, so the size of the error is visible every day rather
 * than assumed to be small.
 *
 * Good enough for the job it has -- deciding which of two strategies did
 * better, when both are measured the same way. Not good enough to quote as a
 * return, which is why the account figure is stored separately.
 */
async function estimateFromMarks(
  runId: string,
  ownerByTicker: Map<string, string>,
): Promise<{ total: number; byStrategy: Record<string, number> }> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("position_marks")
    .select("ticker, pnl_krw")
    .eq("run_id", runId);

  const byStrategy: Record<string, number> = {};
  let total = 0;

  for (const mark of data ?? []) {
    const pnl = Number(mark.pnl_krw);
    const owner = ownerByTicker.get(mark.ticker as string) ?? "unattributed";
    byStrategy[owner] = (byStrategy[owner] ?? 0) + pnl;
    total += pnl;
  }

  return { total, byStrategy };
}

export type SessionResult = {
  /** Per-strategy arithmetic. Exact from fills, estimated from marks. */
  realised: number;
  byStrategy: Record<string, number>;
  /** Where the attribution came from, so a reader knows what it is worth. */
  source: "fills" | "marks" | "none";
  /** The broker's own figure for the account. Exact, fees included. */
  accountRealised: number | null;
  /** What the per-strategy numbers do not account for. */
  unattributed: number | null;
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

  // The exact path first. It is expected to work on a live account and to come
  // back empty on the paper one, so which branch runs is recorded rather than
  // assumed -- promoting to a live account should silently make this better,
  // and the stored source is how anyone would notice that it had.
  let source: "fills" | "marks" | "none" = "none";
  let attribution = { total: 0, byStrategy: {} as Record<string, number> };

  if (daily.fills.length) {
    const { data: orderRows } = await supabase
      .from("orders")
      .select("id, tick_id, ticker, side, quantity, filled_quantity, kis_order_no")
      .eq("run_id", runId)
      .in("status", ["submitted", "filled"]);

    await applyFills((orderRows ?? []) as OrderRow[], daily.fills);
    attribution = realisedByStrategy(daily.fills, ownerByTicker);
    source = "fills";
  } else {
    attribution = await estimateFromMarks(runId, ownerByTicker);
    if (Object.keys(attribution.byStrategy).length) source = "marks";
  }

  const cash = summary?.cash ?? null;
  const holdingsValue = summary?.holdingsValue ?? null;
  const totalEquity = cash !== null && holdingsValue !== null ? cash + holdingsValue : null;
  const accountRealised = summary?.dayChange ?? null;
  const unattributed =
    accountRealised === null ? null : accountRealised - attribution.total;

  const { error } = await supabase.from("equity_snapshots").upsert(
    {
      trade_date: tradeDate,
      environment: TRADING_CONFIG.environment,
      cash_krw: cash,
      holdings_value_krw: holdingsValue,
      total_equity_krw: totalEquity,
      unrealised_pnl_krw: summary?.unrealisedPnl ?? null,
      realised_pnl_krw: attribution.total,
      by_strategy: attribution.byStrategy,
      account_realised_krw: accountRealised,
      bought_krw: summary?.boughtToday ?? null,
      sold_krw: summary?.soldToday ?? null,
      charges_krw: summary?.chargesToday ?? null,
      attribution_source: source,
      unattributed_krw: unattributed,
      capital_krw: TRADING_CONFIG.capitalKrw,
      fills_raw: daily.raw ?? null,
      captured_at: new Date().toISOString(),
    },
    { onConflict: "trade_date,environment" },
  );

  if (error) console.warn(`equity snapshot failed: ${error.message}`);

  return {
    realised: attribution.total,
    byStrategy: attribution.byStrategy,
    source,
    accountRealised,
    unattributed,
    cash,
    holdingsValue,
    unrealisedPnl: summary?.unrealisedPnl ?? null,
    totalEquity,
  };
}
