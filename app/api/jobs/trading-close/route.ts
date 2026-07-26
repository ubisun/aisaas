import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { enqueue } from "@/lib/queue";
import { seoulTradeDate } from "@/lib/teams/trading/calendar";
import { findTodayRun } from "@/lib/teams/trading/lookup";

/**
 * Clock-driven entry point for the close step. Resolves the day's run and
 * hands off; if no run is open -- a holiday, or a morning that never started
 * -- there is nothing to do and that is not an error.
 */
async function handle() {
  const tradeDate = seoulTradeDate();
  const run = await findTodayRun(tradeDate);

  if (!run) {
    return Response.json({ tradeDate, enqueued: false, reason: "no open run" }, { status: 200 });
  }

  await enqueue("/api/workers/trading-close", { runId: run.id, tradeDate });
  return Response.json({ tradeDate, runId: run.id, enqueued: true }, { status: 202 });
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
