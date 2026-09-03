import { setPhase } from "@/lib/runs";
import { createAdminClient } from "@/lib/supabase/admin";

import { TRADING_CONFIG } from "./config";
import { fetchHoldings } from "./kis";
import { markPositions } from "./performance";
import { mandatoryExits, screenExits, seoulClock, windowState } from "./risk";
import { buildPositions, submitVerdicts, type OrderRow } from "./session";
import type { ProposedOrder } from "./types";

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
 * Tickers sold recently enough that selling again would be a mistake.
 *
 * The tick and the watcher both generate exits from the same positions, and a
 * fill takes a moment to leave the balance. Without this, whichever ran second
 * would see the position still held and sell it a second time.
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

  if (generation >= watch.maxGenerations) {
    return { polls, exits, stopped: "generations" };
  }

  await heartbeat(runId, generation);

  while (Date.now() < deadline) {
    // The close job flattens what is left; a watcher still running past it
    // would be a second thing selling the same position.
    if (windowState() === "closed") return { polls, exits, stopped: "closed" };

    polls += 1;
    const holdings = await fetchHoldings();
    if (!holdings.length) return { polls, exits, stopped: "flat" };

    const orders = await loadOrders(runId);
    const positions = buildPositions(holdings, orders);

    // Marked on every poll, so the last reading before a sale is seconds old
    // rather than minutes. On the paper account this mark is what the day's
    // profit is estimated from.
    await markPositions(runId, positions);

    const cooling = recentlyExited(orders);
    const due: ProposedOrder[] = mandatoryExits(positions).filter(
      (order) => !cooling.has(order.ticker),
    );

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
  return { polls, exits, stopped: "handed-on" };
}
