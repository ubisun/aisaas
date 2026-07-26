import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { runTick } from "@/lib/teams/trading/session";

// Quotes, a model call, and any orders.
// Hobby allows up to 300s; the earlier 60 here was a mistaken limit,
// not a platform one.
export const maxDuration = 180;

/**
 * One decision point inside the window.
 *
 * A failing tick does not fail the day: the next one is a few minutes away and
 * the mandatory exits will be re-evaluated then. Only the close is allowed to
 * end the run.
 */
async function handle(request: Request) {
  const { runId, tradeDate } = (await request.json()) as { runId: string; tradeDate: string };

  try {
    const outcome = await runTick(runId, tradeDate);
    return Response.json({ tradeDate, ...outcome }, { status: 200 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`trading tick failed for ${tradeDate}: ${detail}`);
    // 200 on purpose: retrying a stale market snapshot is worse than waiting
    // for the next scheduled tick.
    return Response.json({ status: "tick-failed", detail }, { status: 200 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
