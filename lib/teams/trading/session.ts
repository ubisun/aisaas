import { notify } from "@/lib/notify";
import { setPhase } from "@/lib/runs";
import { createAdminClient } from "@/lib/supabase/admin";

import { latestSectorOutlook, selectCandidates } from "./candidates";
import { TRADING_CONFIG } from "./config";
import { fetchAccountSummary, fetchHoldings, placeOrder } from "./kis";
import { mandatoryExits, minutesToLastEntry, screen, seoulClock, windowState } from "./risk";
import { agentStrategy } from "./strategies/agent";
import type { Candidate, Position, ProposedOrder, TickContext } from "./types";

/**
 * A trading morning, from picking candidates to the closing briefing.
 *
 * Every decision point writes a tick row before anything is submitted: what
 * the strategy saw, what it asked for, and what the gate did with each
 * request. That record is the point of the exercise -- it is what makes a
 * later idea testable against a morning that actually happened.
 */

export async function openSession(runId: string, tradeDate: string): Promise<number> {
  const supabase = createAdminClient();
  await setPhase(runId, "selecting");

  const [candidates, report] = await Promise.all([
    selectCandidates(),
    latestSectorOutlook(tradeDate),
  ]);

  await supabase.from("trade_candidates").delete().eq("run_id", runId);
  if (candidates.length) {
    const { error } = await supabase.from("trade_candidates").insert(
      candidates.map((c) => ({
        run_id: runId,
        ticker: c.ticker,
        name: c.name,
        turnover_rank: c.turnoverRank,
        selection: {
          price: c.price,
          changePct: c.changePct,
          turnover: c.turnover,
          turnoverToMarketCapPct: c.turnoverToMarketCapPct,
          volumeTurnoverRate: c.volumeTurnoverRate,
          marketCapEok: c.marketCapEok,
        },
        rationale: `Turnover rank ${c.turnoverRank}, ${c.turnoverToMarketCapPct.toFixed(2)}% of market cap traded`,
      })),
    );
    if (error) throw new Error(`Storing candidates failed: ${error.message}`);
  }

  await supabase
    .from("runs")
    .update({
      metadata: {
        usSessionDate: report.sessionDate,
        reportAgeDays: report.ageDays,
        // Recorded so a morning traded without a sector view is visible later
        // rather than being mistaken for one where the view said nothing.
        reportStale: report.stale,
        candidateCount: candidates.length,
        environment: TRADING_CONFIG.environment,
      },
    })
    .eq("id", runId);

  return candidates.length;
}

async function buildContext(runId: string, tradeDate: string): Promise<TickContext> {
  const supabase = createAdminClient();

  const [{ data: candidateRows }, { data: orderRows }, holdings, report] = await Promise.all([
    supabase.from("trade_candidates").select("ticker, name, selection").eq("run_id", runId),
    supabase
      .from("orders")
      .select("ticker, side, quantity, status")
      .eq("run_id", runId)
      .in("status", ["submitted", "filled"]),
    fetchHoldings(),
    latestSectorOutlook(tradeDate),
  ]);

  const candidates: Candidate[] = (candidateRows ?? []).map((row) => {
    const selection = (row.selection ?? {}) as Record<string, number>;
    return {
      ticker: row.ticker as string,
      name: row.name as string,
      price: selection.price ?? 0,
      changePct: selection.changePct ?? 0,
      turnover: selection.turnover ?? 0,
      turnoverToMarketCapPct: selection.turnoverToMarketCapPct ?? 0,
    };
  });

  const orders = orderRows ?? [];
  const boughtByTicker = new Map<string, number>();
  for (const order of orders) {
    if (order.side !== "buy") continue;
    boughtByTicker.set(
      order.ticker as string,
      (boughtByTicker.get(order.ticker as string) ?? 0) + (order.quantity as number),
    );
  }

  const positions: Position[] = holdings.map((holding) => ({
    ticker: holding.ticker,
    name: holding.name,
    quantity: holding.quantity,
    sellableQuantity: holding.sellableQuantity,
    boughtQuantity: boughtByTicker.get(holding.ticker) ?? holding.quantity,
    averagePrice: holding.averagePrice,
    currentPrice: holding.currentPrice,
    pnlPct: holding.pnlPct,
  }));

  return {
    tradeDate,
    observedAt: seoulClock(),
    minutesToLastEntry: minutesToLastEntry(),
    candidates,
    positions,
    sectorOutlook: report.outlook.map((s) => ({
      sector: s.sector_ko ?? s.sector,
      direction: s.direction,
      confidence: s.confidence,
      rationale: s.rationale,
    })),
    entriesUsed: orders.filter((o) => o.side === "buy").length,
    entryBudget: TRADING_CONFIG.limits.maxEntriesPerDay,
    ordersSoFar: orders.length,
    maxOrderValueKrw: TRADING_CONFIG.limits.maxOrderValueKrw,
  };
}

/** Unrealised loss across holdings, as a positive percentage of cost. */
function lossPct(context: TickContext): number {
  const cost = context.positions.reduce((sum, p) => sum + p.averagePrice * p.quantity, 0);
  if (cost <= 0) return 0;
  const pnl = context.positions.reduce(
    (sum, p) => sum + (p.currentPrice - p.averagePrice) * p.quantity,
    0,
  );
  return pnl >= 0 ? 0 : (-pnl / cost) * 100;
}

export type TickOutcome = {
  submitted: number;
  rejected: number;
  reasoning: string;
};

/**
 * One decision point. Mandatory exits are evaluated first and are not subject
 * to the strategy's opinion; entries come from the strategy and are screened.
 */
export async function runTick(runId: string, tradeDate: string): Promise<TickOutcome> {
  const supabase = createAdminClient();
  const state = windowState();
  await setPhase(runId, state === "closed" ? "closing" : "trading");

  const context = await buildContext(runId, tradeDate);
  const exits = mandatoryExits(context);

  const proposal =
    state === "entries-open"
      ? await agentStrategy.propose(context)
      : { orders: [] as ProposedOrder[], reasoning: "Entries are closed; exits only." };

  const { data: tick, error: tickError } = await supabase
    .from("strategy_ticks")
    .insert({
      run_id: runId,
      strategy: agentStrategy.name,
      snapshot: {
        observedAt: context.observedAt,
        windowState: state,
        candidates: context.candidates,
        positions: context.positions,
        entriesUsed: context.entriesUsed,
        sectorOutlook: context.sectorOutlook,
      },
      proposals: [...exits, ...proposal.orders],
      reasoning: proposal.reasoning,
    })
    .select("id")
    .single();

  if (tickError) throw new Error(`Recording the tick failed: ${tickError.message}`);

  // Exits bypass the strategy but not the gate's bookkeeping: they are still
  // screened so the daily order cap and sellable quantities are respected.
  const verdicts = screen({
    context,
    proposals: [...exits, ...proposal.orders],
    lossPct: lossPct(context),
  });

  let submitted = 0;
  let rejected = 0;

  for (const verdict of verdicts) {
    const base = {
      run_id: runId,
      tick_id: tick.id,
      environment: TRADING_CONFIG.environment,
      ticker: verdict.order.ticker,
      side: verdict.order.side,
      quantity: verdict.order.quantity,
      limit_price: verdict.order.limitPrice ?? null,
    };

    if (!verdict.allowed) {
      rejected += 1;
      await supabase.from("orders").insert({
        ...base,
        status: "rejected",
        rejected_reason: `${verdict.reason} | intent: ${verdict.order.reason}`,
      });
      continue;
    }

    try {
      const result = await placeOrder({
        ticker: verdict.order.ticker,
        side: verdict.order.side,
        quantity: verdict.order.quantity,
        limitPrice: verdict.order.limitPrice,
      });
      submitted += 1;
      await supabase.from("orders").insert({
        ...base,
        status: "submitted",
        kis_order_no: result.orderNo,
        kis_response: result.raw as Record<string, unknown>,
        rejected_reason: verdict.order.reason,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      await supabase.from("orders").insert({
        ...base,
        status: "failed",
        rejected_reason: `${detail} | intent: ${verdict.order.reason}`,
      });
    }
  }

  return { submitted, rejected, reasoning: proposal.reasoning };
}

/**
 * Close the morning: flatten anything left, then brief.
 *
 * The flatten runs through the same tick path so it is recorded like any other
 * decision rather than as a special case.
 */
export async function closeSession(runId: string, tradeDate: string): Promise<void> {
  const supabase = createAdminClient();
  await setPhase(runId, "closing");

  await runTick(runId, tradeDate);

  const [{ data: orderRows }, { data: tickRows }, summary] = await Promise.all([
    supabase
      .from("orders")
      .select("ticker, side, quantity, status, rejected_reason, created_at")
      .eq("run_id", runId)
      .order("created_at", { ascending: true }),
    supabase.from("strategy_ticks").select("id").eq("run_id", runId),
    fetchAccountSummary().catch(() => null),
  ]);

  const orders = orderRows ?? [];
  const submitted = orders.filter((o) => o.status === "submitted" || o.status === "filled");
  const buys = submitted.filter((o) => o.side === "buy");
  const sells = submitted.filter((o) => o.side === "sell");
  const rejected = orders.filter((o) => o.status === "rejected");

  const lines = submitted.map((o) => {
    const arrow = o.side === "buy" ? "🟢 매수" : "🔴 매도";
    return `${arrow} ${o.ticker} × ${o.quantity}\n    ${String(o.rejected_reason ?? "").slice(0, 180)}`;
  });

  await notify({
    type: "trading.session-closed",
    tradeDate,
    entries: buys.length,
    exits: sells.length,
    rejected: rejected.length,
    ticks: (tickRows ?? []).length,
    unrealisedPnl: summary?.unrealisedPnl ?? null,
    holdingsValue: summary?.holdingsValue ?? null,
    lines,
  });
}
