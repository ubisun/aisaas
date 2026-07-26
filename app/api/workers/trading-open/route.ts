import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { finishRun } from "@/lib/runs";
import { openSession } from "@/lib/teams/trading/session";

export const maxDuration = 60;

/** Screens the day's candidates and leaves the run armed for the ticks. */
async function handle(request: Request) {
  const { runId, tradeDate } = (await request.json()) as { runId: string; tradeDate: string };

  try {
    const count = await openSession(runId);
    return Response.json({ tradeDate, candidates: count }, { status: 200 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "failed", detail);
    return Response.json({ status: "failed", detail }, { status: 500 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
