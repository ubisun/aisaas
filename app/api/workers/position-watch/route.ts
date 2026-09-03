import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { enqueue } from "@/lib/queue";
import { TRADING_CONFIG } from "@/lib/teams/trading/config";
import { watchPositions } from "@/lib/teams/trading/watch";

/**
 * Minds open positions between ticks.
 *
 * Runs for a few minutes, polling the balance, then hands to the next in the
 * chain. It never buys: entries belong to the tick, where the screening and the
 * strategies are. This exists only so that a stop means what it says.
 */
export const maxDuration = 300;

async function handle(request: Request) {
  const { runId, tradeDate, generation } = (await request.json()) as {
    runId: string;
    tradeDate: string;
    generation: number;
  };
  const next = (generation ?? 0) + 1;

  try {
    const outcome = await watchPositions(runId, tradeDate, generation ?? 0);

    if (outcome.stopped === "handed-on") {
      await enqueue("/api/workers/position-watch", { runId, tradeDate, generation: next });
    }

    return Response.json({ tradeDate, generation, ...outcome }, { status: 200 });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(`position watch failed for ${tradeDate}: ${detail}`);

    // Hand on anyway, unless the chain has run its course. A watcher that gave
    // up on one bad poll would leave the desk unwatched for the rest of the
    // session, which is the thing this worker exists to prevent.
    if (next < TRADING_CONFIG.watch.maxGenerations) {
      await enqueue("/api/workers/position-watch", { runId, tradeDate, generation: next });
    }

    // 200 on purpose: the chain has already continued, so a retry would only
    // duplicate it.
    return Response.json({ status: "watch-failed", detail }, { status: 200 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
