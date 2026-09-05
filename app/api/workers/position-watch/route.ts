import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { enqueue } from "@/lib/queue";
import { TRADING_CONFIG } from "@/lib/teams/trading/config";
import { windowState } from "@/lib/teams/trading/risk";
import { closeGeneration, watchPositions } from "@/lib/teams/trading/watch";

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
  const current = generation ?? 0;
  const next = current + 1;

  try {
    const outcome = await watchPositions(runId, tradeDate, current);

    if (outcome.stopped === "handed-on") {
      await enqueue("/api/workers/position-watch", { runId, tradeDate, generation: next });
    }

    return Response.json({ tradeDate, generation: current, ...outcome }, { status: 200 });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(`position watch failed for ${tradeDate}: ${detail}`);
    await closeGeneration(runId, current, { polls: 0, exits: 0, stopped: "failed", detail });

    // Hand on anyway: a watcher that gave up on one bad response would leave
    // the desk unwatched for the rest of the session, which is the thing this
    // worker exists to prevent.
    //
    // But not past the closing bell, and not past the cap. A failure hands on
    // immediately rather than after four minutes, so an endpoint failing in a
    // loop burns generations at the speed of the queue -- and without the
    // window check it would keep doing so all evening. That is how a session
    // that needed 92 generations used 99.
    const stillTrading = windowState() !== "closed";
    if (stillTrading && next < TRADING_CONFIG.watch.maxGenerations) {
      await enqueue("/api/workers/position-watch", { runId, tradeDate, generation: next });
    }

    // 200 on purpose: the chain has already continued, so a retry would only
    // duplicate it.
    return Response.json({ status: "watch-failed", detail, handedOn: stillTrading }, { status: 200 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
