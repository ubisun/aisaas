import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { enqueue } from "@/lib/queue";
import { claimRun } from "@/lib/runs";
import { onDuty, standbyResponse } from "@/lib/teams/roster";
import { seoulTradeDate } from "@/lib/teams/trading/calendar";

const TEAM = "trading";
const KIND = "morning-session";

/**
 * Fired once before the window opens. Claims the trading day and hands the
 * candidate screen to a worker; the ticks schedule themselves separately.
 */
async function handle() {
  if (!onDuty("trading")) return standbyResponse("trading");

  const tradeDate = seoulTradeDate();

  const claim = await claimRun(TEAM, KIND, tradeDate);
  if (!claim.claimed) {
    return Response.json(
      { tradeDate, status: claim.run.status, reason: claim.reason, enqueued: false },
      { status: 200 },
    );
  }

  await enqueue("/api/workers/trading-open", { runId: claim.run.id, tradeDate });
  return Response.json({ tradeDate, runId: claim.run.id, enqueued: true }, { status: 202 });
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
