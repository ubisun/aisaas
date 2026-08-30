import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { finishRun } from "@/lib/runs";
import { openSession } from "@/lib/teams/trading/session";

// A report lookup and a metadata write. Screening moved into the ticks, so
// this no longer spends nineteen seconds on throttled quote calls.
export const maxDuration = 60;

/**
 * Opens the day and leaves the run armed for the ticks.
 *
 * Picking candidates is not done here: this runs before the opening bell, when
 * the turnover the screen reads is still zero.
 */
async function handle(request: Request) {
  const { runId, tradeDate } = (await request.json()) as { runId: string; tradeDate: string };

  try {
    const report = await openSession(runId, tradeDate);
    return Response.json({ tradeDate, ...report }, { status: 200 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "failed", detail);
    return Response.json({ status: "failed", detail }, { status: 500 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
