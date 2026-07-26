import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { notify } from "@/lib/notify";
import { finishRun } from "@/lib/runs";
import { runTranslateJob } from "@/lib/teams/market-report/run";

type TranslatePayload = {
  runId: string;
  sessionDate: string;
  /** When the whole run started, so the notification reports end-to-end time. */
  startedAtMs: number;
};

// The Korean pass.
// Hobby allows up to 300s; the earlier 60 here was a mistaken limit,
// not a platform one.
export const maxDuration = 180;

/**
 * Translates the stored English report into Korean and marks the run done.
 *
 * A failure here leaves the English report in place and the run `failed`, so
 * the session is re-claimable; the report is still readable in the meantime.
 */
async function handle(request: Request) {
  const { runId, sessionDate, startedAtMs } = (await request.json()) as TranslatePayload;

  try {
    await runTranslateJob(runId, sessionDate, startedAtMs);
    await finishRun(runId, "succeeded");
    return Response.json({ status: "succeeded", sessionDate }, { status: 200 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "failed", detail);
    await notify({ type: "market-report.failed", sessionDate, detail });
    return Response.json({ status: "failed", detail }, { status: 500 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
