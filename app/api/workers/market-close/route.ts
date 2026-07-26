import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { notify } from "@/lib/notify";
import { enqueue } from "@/lib/queue";
import { finishRun } from "@/lib/runs";
import { runMarketCloseJob } from "@/lib/teams/market-report/run";

type JobPayload = {
  runId: string;
  sessionDate: string;
};

// Collection plus the English report.
// Hobby allows up to 300s; the earlier 60 here was a mistaken limit,
// not a platform one.
export const maxDuration = 180;

/**
 * Collects the session and writes the English report, then hands the
 * translation to its own queued step.
 */
async function handle(request: Request) {
  const { runId, sessionDate } = (await request.json()) as JobPayload;
  const startedAtMs = Date.now();

  try {
    const { outcome, needsTranslation } = await runMarketCloseJob(runId, sessionDate);

    if (!needsTranslation) {
      await finishRun(runId, outcome.status, outcome.detail);
      return Response.json(outcome, { status: 200 });
    }

    await enqueue("/api/workers/translate", { runId, sessionDate, startedAtMs });
    return Response.json({ status: "translating", sessionDate }, { status: 202 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "failed", detail);
    await notify({ type: "market-report.failed", sessionDate, detail });

    // 500 lets QStash retry; the run row is left in `failed` so the scheduled
    // endpoint will re-claim the session rather than treat it as done.
    return Response.json({ status: "failed", detail }, { status: 500 });
  }
}

// Built per request rather than at module scope: the wrapper reads the signing
// keys eagerly, and at module scope a missing key breaks the build instead of
// the request.
export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
