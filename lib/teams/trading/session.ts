import { notify } from "@/lib/notify";
import { setPhase } from "@/lib/runs";
import { createAdminClient } from "@/lib/supabase/admin";

import { previousTradeDate } from "./calendar";
import { fetchAccountSummary } from "./kis";
import { latestSectorOutlook, screenNow, type ScreenedCandidate } from "./candidates";
import { maxOrderValueKrw, strategyBudgetKrw, TRADING_CONFIG } from "./config";
import { cancelOrder, fetchHoldings, placeOrder, type Holding } from "./kis";
import { captureSession } from "./performance";
import {
  mandatoryExits,
  minutesToLastEntry,
  screenEntries,
  screenExits,
  seoulClock,
  windowState,
} from "./risk";
import { activeStrategies, liveStrategies, REGISTRY } from "./strategies";
import type {
  Candidate,
  Position,
  ProposedOrder,
  StrategyProposal,
  TickContext,
  Verdict,
} from "./types";

/**
 * A trading morning, from opening the day to the closing briefing.
 *
 * Several strategies run against the same shortlist, each with its own share of
 * the capital and its own entry budget. Every one writes a tick row before
 * anything is submitted: what it saw, what it asked for, and what the gate did
 * with each request. That record is the point of the exercise -- it is what
 * makes two strategies comparable on the same morning rather than on two
 * different ones.
 *
 * Exits belong to no strategy. They are generated from the positions held and
 * recorded against a tick of their own, under `risk-gate`.
 */

const RISK_GATE = "risk-gate";

/**
 * Open the day.
 *
 * This runs before the opening bell, so it deliberately does no screening: at
 * 08:40 today's accumulated turnover is zero and any shortlist built from it is
 * empty. Picking what to buy belongs to the ticks, which run while the market
 * is actually trading.
 *
 * What is left is the part that must happen before the window rather than
 * inside it -- the run row the ticks and the close both resolve through
 * `findTodayRun`, the record of which overnight report the day is being traded
 * on, and the capital split, which is fixed here so that adding or retiring a
 * strategy mid-session cannot change the budget an order was sized against.
 */
export async function openSession(
  runId: string,
  tradeDate: string,
): Promise<{
  usSessionDate: string | null;
  reportAgeDays: number | null;
  reportStale: boolean;
  liveStrategies: number;
  strategyBudgetKrw: number;
  cashKrw: number | null;
  underfunded: boolean;
}> {
  const supabase = createAdminClient();
  await setPhase(runId, "opening");

  const [report, summary] = await Promise.all([
    latestSectorOutlook(tradeDate),
    fetchAccountSummary().catch(() => null),
  ]);

  const live = liveStrategies();
  const budget = strategyBudgetKrw(live.length, REGISTRY.length);

  // The desk is sized by configuration, not by the deposit -- but if the
  // deposit cannot cover the configured capital the orders will be refused by
  // Korea Investment rather than by us, which is a worse place to find out.
  const cash = summary?.cash ?? null;
  const underfunded = cash !== null && cash < TRADING_CONFIG.capitalKrw;
  if (underfunded) {
    console.warn(
      `trading: deposit ${cash?.toLocaleString()} KRW is below the configured capital ${TRADING_CONFIG.capitalKrw.toLocaleString()} KRW`,
    );
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
        environment: TRADING_CONFIG.environment,
        capitalKrw: TRADING_CONFIG.capitalKrw,
        liveStrategies: live.map((r) => r.strategy.name),
        strategyBudgetKrw: budget,
        cashKrw: cash,
        underfunded,
      },
    })
    .eq("id", runId);

  return {
    usSessionDate: report.sessionDate,
    reportAgeDays: report.ageDays,
    reportStale: report.stale,
    liveStrategies: live.length,
    strategyBudgetKrw: budget,
    cashKrw: cash,
    underfunded,
  };
}

/**
 * Keep a record of what was on the shortlist today.
 *
 * Upserted rather than replaced, so the table accumulates every name considered
 * during the morning instead of only the last tick's view. The per-tick view is
 * already preserved in `strategy_ticks.snapshot`.
 */
async function recordCandidates(
  runId: string,
  candidates: ScreenedCandidate[],
): Promise<void> {
  if (!candidates.length) return;

  const supabase = createAdminClient();
  const { error } = await supabase.from("trade_candidates").upsert(
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
        marketCapEok: c.marketCapEok,
      },
      rationale: `Turnover rank ${c.turnoverRank}, ${c.turnoverToMarketCapPct.toFixed(2)}% of market cap traded`,
    })),
    { onConflict: "run_id,ticker" },
  );

  // A lost record is not worth failing a tick that can still trade.
  if (error) console.warn(`recording candidates failed: ${error.message}`);
}

type OrderRow = {
  id: string;
  tick_id: string | null;
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  status: string;
  filled_quantity: number;
  kis_order_no: string | null;
  stop_loss: number | null;
  take_profit: number | null;
};

/**
 * Work out how much of each buy actually filled, from the balance alone.
 *
 * There is no execution-inquiry call here on purpose. Because a ticker is
 * bought exactly once a day, the day's holding of that name *is* that order's
 * fill -- so the balance already carries the answer, and the balance is
 * fetched every tick regardless.
 *
 * Selling reduces the holding, so what has already been sold is added back;
 * and the figure only ever moves up, because a fill cannot un-happen.
 */
async function reconcileFills(orders: OrderRow[], holdings: Holding[]): Promise<OrderRow[]> {
  const supabase = createAdminClient();
  const heldByTicker = new Map(holdings.map((h) => [h.ticker, h.quantity]));

  const soldByTicker = new Map<string, number>();
  for (const order of orders) {
    if (order.side !== "sell") continue;
    if (order.status !== "submitted" && order.status !== "filled") continue;
    soldByTicker.set(order.ticker, (soldByTicker.get(order.ticker) ?? 0) + order.quantity);
  }

  const updated: OrderRow[] = [];

  for (const order of orders) {
    if (order.side !== "buy" || (order.status !== "submitted" && order.status !== "filled")) {
      updated.push(order);
      continue;
    }

    const held = heldByTicker.get(order.ticker) ?? 0;
    const sold = soldByTicker.get(order.ticker) ?? 0;
    const observed = Math.min(order.quantity, Math.max(order.filled_quantity, held + sold));

    if (observed === order.filled_quantity) {
      updated.push(order);
      continue;
    }

    const status = observed >= order.quantity ? "filled" : order.status;
    const { error } = await supabase
      .from("orders")
      .update({ filled_quantity: observed, status, updated_at: new Date().toISOString() })
      .eq("id", order.id);

    if (error) console.warn(`reconciling ${order.ticker} failed: ${error.message}`);
    updated.push({ ...order, filled_quantity: observed, status });
  }

  return updated;
}

/**
 * Which strategy owns each ticker today.
 *
 * A ticker belongs to whoever's buy reached Korea Investment first, and keeps
 * belonging to them for the rest of the session even after they have sold out
 * of it. Releasing the claim on exit would let two strategies pass the same
 * name back and forth, and the clean attribution that makes per-strategy profit
 * meaningful would go with it.
 */
function ownerMap(orders: OrderRow[], tickStrategy: Map<string, string>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const order of orders) {
    if (order.side !== "buy") continue;
    if (order.status !== "submitted" && order.status !== "filled") continue;
    if (owners.has(order.ticker)) continue;
    const strategy = order.tick_id ? tickStrategy.get(order.tick_id) : undefined;
    if (strategy) owners.set(order.ticker, strategy);
  }
  return owners;
}

function buildPositions(holdings: Holding[], orders: OrderRow[]): Position[] {
  const boughtByTicker = new Map<string, number>();
  const levelsByTicker = new Map<string, { stop: number | null; target: number | null }>();

  for (const order of orders) {
    if (order.side !== "buy") continue;
    if (order.status !== "submitted" && order.status !== "filled") continue;
    // The ladder measures against what was actually acquired, not what was
    // asked for; an unfilled remainder was never part of the position.
    boughtByTicker.set(order.ticker, order.filled_quantity || order.quantity);
    // One buy per ticker per day, so a position has at most one set of levels
    // and there is nothing to reconcile between two entries.
    levelsByTicker.set(order.ticker, {
      stop: order.stop_loss === null ? null : Number(order.stop_loss),
      target: order.take_profit === null ? null : Number(order.take_profit),
    });
  }

  return holdings.map((holding) => {
    const levels = levelsByTicker.get(holding.ticker);
    return {
      ticker: holding.ticker,
      name: holding.name,
      quantity: holding.quantity,
      sellableQuantity: holding.sellableQuantity,
      boughtQuantity: boughtByTicker.get(holding.ticker) ?? holding.quantity,
      averagePrice: holding.averagePrice,
      currentPrice: holding.currentPrice,
      pnlPct: holding.pnlPct,
      stopLoss: levels?.stop ?? null,
      takeProfit: levels?.target ?? null,
    };
  });
}

/** Unrealised loss across a set of positions, as a positive percent of `base`. */
function lossPctOf(positions: Position[], base: number): number {
  if (base <= 0) return 0;
  const pnl = positions.reduce(
    (sum, p) => sum + (p.currentPrice - p.averagePrice) * p.quantity,
    0,
  );
  return pnl >= 0 ? 0 : (-pnl / base) * 100;
}

export type StrategyOutcome = {
  strategy: string;
  live: boolean;
  submitted: number;
  rejected: number;
  reasoning: string;
};

export type TickOutcome = {
  submitted: number;
  rejected: number;
  exits: number;
  candidates: number;
  strategies: StrategyOutcome[];
};

/** Insert a tick row and return its id. */
async function recordTick(
  runId: string,
  strategy: string,
  snapshot: Record<string, unknown>,
  proposals: ProposedOrder[],
  reasoning: string,
): Promise<string> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("strategy_ticks")
    .insert({ run_id: runId, strategy, snapshot, proposals, reasoning })
    .select("id")
    .single();

  if (error) throw new Error(`Recording the tick failed: ${error.message}`);
  return data.id as string;
}

/** Submit the allowed verdicts and record every one of them. */
async function submitVerdicts(
  runId: string,
  tickId: string,
  verdicts: Verdict[],
): Promise<{ submitted: number; rejected: number }> {
  const supabase = createAdminClient();
  let submitted = 0;
  let rejected = 0;

  for (const verdict of verdicts) {
    const base = {
      run_id: runId,
      tick_id: tickId,
      environment: TRADING_CONFIG.environment,
      ticker: verdict.order.ticker,
      side: verdict.order.side,
      quantity: verdict.order.quantity,
      limit_price: verdict.order.limitPrice ?? null,
      stop_loss: verdict.order.stopLoss ?? null,
      take_profit: verdict.order.takeProfit ?? null,
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

  return { submitted, rejected };
}

/**
 * Cancel any buy still working on a name the gate is now taking profit on.
 *
 * Holding a live order to buy more of something you have just decided to sell
 * is trading against your own decision. Only profit-taking triggers this: a
 * stop or the closing flatten implies the price went the other way, where an
 * unfilled buy would have filled long before.
 */
async function cancelWorkingBuys(
  exits: ProposedOrder[],
  orders: OrderRow[],
): Promise<number> {
  const supabase = createAdminClient();
  const takingProfit = new Set(
    exits.filter((e) => e.reason.startsWith("Take profit")).map((e) => e.ticker),
  );
  if (!takingProfit.size) return 0;

  let cancelled = 0;

  for (const order of orders) {
    if (order.side !== "buy" || order.status !== "submitted") continue;
    if (!takingProfit.has(order.ticker)) continue;
    const outstanding = order.quantity - order.filled_quantity;
    if (outstanding <= 0 || !order.kis_order_no) continue;

    const result = await cancelOrder({
      orderNo: order.kis_order_no,
      ticker: order.ticker,
      quantity: outstanding,
    });

    if (result.ok) {
      cancelled += 1;
      await supabase
        .from("orders")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", order.id);
    } else {
      // A cancel that loses a race with a fill is normal, not a fault.
      console.warn(`cancelling ${order.ticker} failed: ${result.detail}`);
    }
  }

  return cancelled;
}

/**
 * One decision point.
 *
 * Exits are settled first and are not subject to anyone's opinion. Entries come
 * from the strategies, in priority order, each screened against its own budget
 * and against the tickers already taken.
 */
export async function runTick(runId: string, tradeDate: string): Promise<TickOutcome> {
  const supabase = createAdminClient();
  const state = windowState();
  await setPhase(runId, state === "closed" ? "closing" : "trading");

  const [{ data: orderRows }, { data: tickRows }, holdings, report] = await Promise.all([
    supabase
      .from("orders")
      .select("id, tick_id, ticker, side, quantity, status, filled_quantity, kis_order_no, stop_loss, take_profit")
      .eq("run_id", runId)
      .in("status", ["submitted", "filled"]),
    supabase.from("strategy_ticks").select("id, strategy").eq("run_id", runId),
    fetchHoldings(),
    latestSectorOutlook(tradeDate),
  ]);

  const tickStrategy = new Map(
    (tickRows ?? []).map((t) => [t.id as string, t.strategy as string]),
  );
  const orders = await reconcileFills((orderRows ?? []) as OrderRow[], holdings);
  const owners = ownerMap(orders, tickStrategy);
  const positions = buildPositions(holdings, orders);

  // --- Exits: account-level, generated rather than proposed. ---
  const exits = mandatoryExits(positions);
  await cancelWorkingBuys(exits, orders);

  let submitted = 0;
  let rejected = 0;
  let exitCount = 0;

  if (exits.length) {
    const exitTick = await recordTick(
      runId,
      RISK_GATE,
      { observedAt: seoulClock(), windowState: state, positions },
      exits,
      "Exits generated by the risk gate.",
    );
    const result = await submitVerdicts(runId, exitTick, screenExits(positions, exits));
    submitted += result.submitted;
    rejected += result.rejected;
    exitCount = result.submitted;
  }

  // --- Entries: one pass per strategy, in priority order. ---
  const screened = state === "entries-open" ? await screenNow(tradeDate) : [];
  await recordCandidates(runId, screened);

  const live = liveStrategies();
  const budget = strategyBudgetKrw(live.length, REGISTRY.length);
  const orderCap = maxOrderValueKrw(budget);
  const accountLossPct = lossPctOf(positions, TRADING_CONFIG.capitalKrw);
  const claimed = new Map(owners);
  const strategies: StrategyOutcome[] = [];

  const sectorOutlook = report.outlook.map((s) => ({
    sector: s.sector_ko ?? s.sector,
    direction: s.direction,
    confidence: s.confidence,
    rationale: s.rationale,
  }));

  if (state === "entries-open") {
    for (const registered of activeStrategies()) {
      const name = registered.strategy.name;
      const mine = (ticker: string) => claimed.get(ticker) === name;

      // Its own positions, its own entries, and only the names nobody else has
      // taken. A strategy is never shown a ticker it cannot act on.
      const myPositions = positions.filter((p) => mine(p.ticker));
      const myEntries = orders.filter(
        (o) =>
          o.side === "buy" &&
          o.tick_id !== null &&
          tickStrategy.get(o.tick_id) === name,
      ).length;

      const candidates: Candidate[] = screened
        .filter((c) => !claimed.has(c.ticker))
        .map((c) => ({
          ticker: c.ticker,
          name: c.name,
          price: c.price,
          changePct: c.changePct,
          turnover: c.turnover,
          turnoverToMarketCapPct: c.turnoverToMarketCapPct,
        }));

      const context: TickContext = {
        tradeDate,
        previousTradeDate: previousTradeDate(),
        runId,
        observedAt: seoulClock(),
        minutesToLastEntry: minutesToLastEntry(),
        candidates,
        positions: myPositions,
        sectorOutlook,
        entriesUsed: myEntries,
        entryBudget: TRADING_CONFIG.limits.maxEntriesPerDay,
        ordersSoFar: orders.length,
        maxOrderValueKrw: orderCap,
        budgetKrw: budget,
      };

      // One strategy's failure must not take the tick down with it. A desk
      // where an exhausted API key on one strategy stops another from running
      // its stop-losses is a worse failure than the one it started with, and
      // the recorded reason is what makes the cause findable afterwards.
      let proposal: StrategyProposal;
      try {
        proposal = await registered.strategy.propose(context);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        console.error(`strategy ${name} failed: ${detail}`);
        proposal = { orders: [], reasoning: `Strategy failed: ${detail.slice(0, 500)}` };
      }

      const tickId = await recordTick(
        runId,
        name,
        {
          observedAt: context.observedAt,
          windowState: state,
          live: registered.live,
          priority: registered.priority,
          budgetKrw: budget,
          maxOrderValueKrw: orderCap,
          candidates,
          positions: myPositions,
          entriesUsed: myEntries,
          sectorOutlook,
        },
        proposal.orders,
        proposal.reasoning,
      );

      // A shadow strategy is recorded and stops there: it has said what it
      // would do, which is the whole point of running it without money.
      if (!registered.live) {
        strategies.push({
          strategy: name,
          live: false,
          submitted: 0,
          rejected: 0,
          reasoning: proposal.reasoning,
        });
        continue;
      }

      const verdicts = screenEntries({
        context,
        proposals: proposal.orders,
        strategyLossPct: lossPctOf(myPositions, budget),
        accountLossPct,
        claimedByOthers: new Set(
          [...claimed.entries()].filter(([, owner]) => owner !== name).map(([t]) => t),
        ),
        ordersSoFar: submitted + rejected,
      });

      const result = await submitVerdicts(runId, tickId, verdicts);
      submitted += result.submitted;
      rejected += result.rejected;

      // Claimed on submission, not on fill: an unfilled buy still belongs to
      // whoever placed it, and leaving the name open would let a second
      // strategy buy into the same position.
      for (const verdict of verdicts) {
        if (verdict.allowed) claimed.set(verdict.order.ticker, name);
      }

      strategies.push({
        strategy: name,
        live: true,
        submitted: result.submitted,
        rejected: result.rejected,
        reasoning: proposal.reasoning,
      });
    }
  }

  return { submitted, rejected, exits: exitCount, candidates: screened.length, strategies };
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

  const [{ data: orderRows }, { data: tickRows }] = await Promise.all([
    supabase
      .from("orders")
      .select("tick_id, ticker, side, quantity, status, filled_quantity, rejected_reason, created_at")
      .eq("run_id", runId)
      .order("created_at", { ascending: true }),
    supabase.from("strategy_ticks").select("id, strategy").eq("run_id", runId),
  ]);

  const strategyOf = new Map((tickRows ?? []).map((t) => [t.id as string, t.strategy as string]));
  const orders = orderRows ?? [];
  const submitted = orders.filter((o) => o.status === "submitted" || o.status === "filled");
  const buys = submitted.filter((o) => o.side === "buy");
  const sells = submitted.filter((o) => o.side === "sell");
  const rejected = orders.filter((o) => o.status === "rejected");

  // Who owned what, so the day's profit can be credited. A ticker belongs to
  // whoever bought it, which is what makes per-strategy profit meaningful.
  const ownerByTicker = new Map<string, string>();
  for (const order of buys) {
    const owner = order.tick_id ? strategyOf.get(order.tick_id) : undefined;
    if (owner && !ownerByTicker.has(order.ticker)) ownerByTicker.set(order.ticker, owner);
  }

  // Captured after the flatten and before anything can forget it: the broker
  // keeps no record of what a closed position sold for.
  const result = await captureSession(runId, tradeDate, ownerByTicker);

  const byStrategy = new Map<string, string[]>();
  for (const order of submitted) {
    const owner = order.tick_id ? (strategyOf.get(order.tick_id) ?? "?") : "?";
    const arrow = order.side === "buy" ? "🟢 매수" : "🔴 매도";
    const filled =
      order.side === "buy" && order.filled_quantity < order.quantity
        ? ` (체결 ${order.filled_quantity}/${order.quantity})`
        : "";
    const line = `${arrow} ${order.ticker} × ${order.quantity}${filled}
    ${String(order.rejected_reason ?? "").slice(0, 160)}`;
    byStrategy.set(owner, [...(byStrategy.get(owner) ?? []), line]);
  }

  const lines: string[] = [];
  for (const [strategy, entries] of byStrategy) {
    const realised = result.byStrategy[strategy];
    const pnl =
      realised === undefined
        ? ""
        : ` · 실현 ${realised >= 0 ? "+" : ""}${Math.round(realised).toLocaleString()}원`;
    lines.push(`— ${strategy}${pnl} —`, ...entries);
  }

  await notify({
    type: "trading.session-closed",
    tradeDate,
    entries: buys.length,
    exits: sells.length,
    rejected: rejected.length,
    ticks: (tickRows ?? []).filter((t) => t.strategy !== RISK_GATE).length,
    unrealisedPnl: result.unrealisedPnl,
    holdingsValue: result.holdingsValue,
    lines,
  });
}
