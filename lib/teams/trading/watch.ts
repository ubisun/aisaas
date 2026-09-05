import { setPhase } from "@/lib/runs";
import { createAdminClient } from "@/lib/supabase/admin";

import { TRADING_CONFIG } from "./config";
import { fetchHoldings } from "./kis";
import { markPositions } from "./performance";
import { mandatoryExits, screenExits, seoulClock, windowState } from "./risk";
import { buildPositions, submitVerdicts, type OrderRow } from "./session";
import type { Position, ProposedOrder } from "./types";

/**
 * Watching a position between ticks.
 *
 * The five-minute tick decides what to buy. It is far too coarse for deciding
 * when to sell: on 2026-09-03 a position read -1.55% at 09:16 and -5.21% at
 * 09:20, having crossed its -2% stop somewhere in between with nothing looking.
 * A stop checked every five minutes is not a stop.
 *
 * So while anything is held, this runs -- polling the balance every fifteen
 * seconds and acting on the exits itself. It never buys. Entries stay with the
 * tick, where the screening and the strategies are.
 *
 * It is a chain rather than a schedule because QStash crons are minute-grained
 * at best. Each invocation runs for a few minutes and queues the next, and the
 * chain ends when the desk is flat, when the session closes, or when the
 * generation cap is reached -- whichever comes first. All three matter: the
 * first is the normal exit, the second stops it outliving the day, and the
 * third means a bug cannot leave a function re-queueing itself forever.
 */

const { watch } = TRADING_CONFIG;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tickers sold so recently that the balance has probably not caught up.
 *
 * Narrow on purpose. `sellableQuantity` is what actually stops an oversell --
 * Korea Investment excludes shares already working in an order -- and this only
 * covers the seconds before that figure updates.
 *
 * Suppression is the expensive kind of safety: it leaves no record and it
 * blocks the whole ticker, so a profit ladder clearing its second rung inside
 * the window would miss it silently. A duplicate that gets through is refused
 * by the broker, recorded with a reason, and retried on the next poll. The
 * window is therefore kept to about one poll rather than to a comfortable
 * margin.
 */
export function recentlyExited(
  orders: { ticker: string; side: string; status: string; created_at?: string }[],
  now: number = Date.now(),
): Set<string> {
  const cutoff = now - watch.exitCooldownSeconds * 1000;
  return new Set(
    orders
      .filter(
        (o) =>
          o.side === "sell" &&
          (o.status === "submitted" || o.status === "filled") &&
          Date.parse(o.created_at ?? "") >= cutoff,
      )
      .map((o) => o.ticker),
  );
}

export type ExitDecision = {
  /** Exits to place now. */
  due: ProposedOrder[];
  /**
   * Exits the cooldown held back, and why. Returned rather than discarded: a
   * suppression nobody can see is how the profit ladder lost its second rung
   * without anyone noticing.
   */
  heldBack: { order: ProposedOrder; soldSecondsAgo: number }[];
};

/**
 * What the desk owes on its positions right now.
 *
 * Pure, and separated from the loop that calls it, because this is the part
 * that decides whether a stop is honoured. `mandatoryExits` says what the rules
 * demand; this subtracts only what is already in flight.
 */
export function exitsDueNow(
  positions: Position[],
  orders: { ticker: string; side: string; status: string; created_at?: string }[],
  at: Date = new Date(),
): ExitDecision {
  const cooling = recentlyExited(orders, at.getTime());
  const due: ProposedOrder[] = [];
  const heldBack: ExitDecision["heldBack"] = [];

  for (const order of mandatoryExits(positions, at)) {
    if (!cooling.has(order.ticker)) {
      due.push(order);
      continue;
    }

    const last = orders
      .filter((o) => o.ticker === order.ticker && o.side === "sell" && o.created_at)
      .map((o) => Date.parse(o.created_at as string))
      .sort((a, b) => b - a)[0];

    heldBack.push({
      order,
      soldSecondsAgo: last ? Math.round((at.getTime() - last) / 1000) : 0,
    });
  }

  return { due, heldBack };
}

export type WatchStep = "poll" | "flat" | "closed" | "generations" | "handed-on";

/**
 * What the loop should do next.
 *
 * Every way the chain can end, in one place that can be read and tested. The
 * order matters: the generation cap is checked before anything else so a
 * runaway chain stops even if the rest of the state looks normal.
 */
export function nextStep(state: {
  generation: number;
  now: number;
  deadline: number;
  holdings: number;
  closed: boolean;
}): WatchStep {
  if (state.generation >= watch.maxGenerations) return "generations";
  if (state.closed) return "closed";
  if (state.now >= state.deadline) return "handed-on";
  if (state.holdings === 0) return "flat";
  return "poll";
}

async function loadOrders(runId: string): Promise<OrderRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("orders")
    .select(
      "id, tick_id, ticker, side, quantity, status, filled_quantity, kis_order_no, stop_loss, take_profit, created_at",
    )
    .eq("run_id", runId)
    .in("status", ["submitted", "filled"]);

  return (data ?? []) as OrderRow[];
}

/**
 * Open the record for this generation.
 *
 * Written before any work, so a generation that dies immediately still leaves a
 * row saying it existed. The count of those is what tells a fast-failure loop
 * apart from a long, healthy session.
 */
async function openGeneration(runId: string, generation: number): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("watch_generations").upsert(
    { run_id: runId, generation, started_at: new Date().toISOString(), polls: 0, exits: 0 },
    { onConflict: "run_id,generation" },
  );
  if (error) console.warn(`watcher could not open generation ${generation}: ${error.message}`);
}

/** Close it, with what it managed to do and what ended it. */
export async function closeGeneration(
  runId: string,
  generation: number,
  outcome: { polls: number; exits: number; stopped: string; detail?: string },
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("watch_generations")
    .update({
      ended_at: new Date().toISOString(),
      polls: outcome.polls,
      exits: outcome.exits,
      stopped: outcome.stopped,
      detail: outcome.detail ?? null,
    })
    .match({ run_id: runId, generation });

  if (error) console.warn(`watcher could not close generation ${generation}: ${error.message}`);
}

/** Record that a watcher is alive, so a tick can tell whether to start one. */
async function heartbeat(runId: string, generation: number): Promise<void> {
  const supabase = createAdminClient();
  const { data } = await supabase.from("runs").select("metadata").eq("id", runId).maybeSingle();
  const metadata = (data?.metadata ?? {}) as Record<string, unknown>;

  await supabase
    .from("runs")
    .update({
      metadata: {
        ...metadata,
        watcherGeneration: generation,
        watcherHeartbeat: new Date().toISOString(),
      },
    })
    .eq("id", runId);
}

/** Whether a watcher is currently minding the desk. */
export function watcherIsAlive(metadata: Record<string, unknown> | null): boolean {
  const beat = metadata?.watcherHeartbeat;
  if (typeof beat !== "string") return false;
  return Date.now() - Date.parse(beat) < watch.staleHeartbeatSeconds * 1000;
}

export type WatchOutcome = {
  polls: number;
  exits: number;
  stopped: "flat" | "closed" | "generations" | "handed-on";
};

/**
 * Poll the balance and act on what it says, until there is nothing left to
 * watch or it is time to hand on.
 */
export async function watchPositions(
  runId: string,
  tradeDate: string,
  generation: number,
): Promise<WatchOutcome> {
  const supabase = createAdminClient();
  const deadline = Date.now() + watch.invocationSeconds * 1000;

  let polls = 0;
  let exits = 0;

  await Promise.all([heartbeat(runId, generation), openGeneration(runId, generation)]);

  const finish = async (stopped: WatchOutcome["stopped"]): Promise<WatchOutcome> => {
    await closeGeneration(runId, generation, { polls, exits, stopped });
    return { polls, exits, stopped };
  };

  while (true) {
    const step = nextStep({
      generation,
      now: Date.now(),
      deadline,
      holdings: 1, // unknown until the balance is read; the read follows
      closed: windowState() === "closed",
    });
    if (step !== "poll") return finish(step as WatchOutcome["stopped"]);

    polls += 1;
    const holdings = await fetchHoldings();
    if (!holdings.length) return finish("flat");

    const orders = await loadOrders(runId);
    const positions = buildPositions(holdings, orders);

    // Marked on every poll, so the last reading before a sale is seconds old
    // rather than minutes. On the paper account this mark is what the day's
    // profit is estimated from.
    await markPositions(runId, positions);

    const { due, heldBack } = exitsDueNow(positions, orders);

    for (const held of heldBack) {
      // Logged rather than dropped in silence: a suppression that keeps
      // happening is the signal that the window is too wide.
      console.warn(
        `watcher: holding back ${held.order.side} ${held.order.ticker} — sold ${held.soldSecondsAgo}s ago (${held.order.reason})`,
      );
    }

    if (due.length) {
      const { data: tick, error } = await supabase
        .from("strategy_ticks")
        .insert({
          run_id: runId,
          strategy: "risk-gate",
          snapshot: { observedAt: seoulClock(), windowState: windowState(), positions, watcher: true },
          proposals: due,
          reasoning: `Watcher generation ${generation}, poll ${polls}.`,
        })
        .select("id")
        .single();

      if (error) {
        console.warn(`watcher could not record its tick: ${error.message}`);
      } else {
        const result = await submitVerdicts(runId, tick.id as string, screenExits(positions, due));
        exits += result.submitted;
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(watch.intervalSeconds * 1000, remaining));
  }

  await setPhase(runId, "watching");
  void tradeDate;
  return finish("handed-on");
}
