import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { enqueue } from "@/lib/queue";
import { windowState } from "@/lib/teams/trading/risk";
import { closeGeneration, shouldHandOn, watchPositions } from "@/lib/teams/trading/watch";

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

  const handOn = async (stopped: Parameters<typeof shouldHandOn>[0]["stopped"]) => {
    const carryOn = shouldHandOn({
      stopped,
      nextGeneration: next,
      closed: windowState() === "closed",
    });
    if (carryOn) {
      await enqueue("/api/workers/position-watch", { runId, tradeDate, generation: next });
    }
    return carryOn;
  };

  try {
    const outcome = await watchPositions(runId, tradeDate, current);
    const handedOn = await handOn(outcome.stopped);
    return Response.json({ tradeDate, generation: current, handedOn, ...outcome }, { status: 200 });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(`position watch failed for ${tradeDate}: ${detail}`);
    await closeGeneration(runId, current, { polls: 0, exits: 0, stopped: "failed", detail });

    const handedOn = await handOn("failed");

    // 200 on purpose: the chain has already continued where it should, so a
    // retry would only duplicate it.
    return Response.json({ status: "watch-failed", detail, handedOn }, { status: 200 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
