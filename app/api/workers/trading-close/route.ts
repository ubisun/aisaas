import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { notify } from "@/lib/notify";
import { finishRun } from "@/lib/runs";
import { closeSession } from "@/lib/teams/trading/session";

export const maxDuration = 60;

/** Flattens whatever is left and sends the day's briefing. */
async function handle(request: Request) {
  const { runId, tradeDate } = (await request.json()) as { runId: string; tradeDate: string };

  try {
    await closeSession(runId, tradeDate);
    await finishRun(runId, "succeeded");
    return Response.json({ tradeDate, status: "closed" }, { status: 200 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "failed", detail);
    await notify({ type: "job.exhausted", step: "trading-close", key: tradeDate, detail });
    return Response.json({ status: "failed", detail }, { status: 500 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
