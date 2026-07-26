import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { notify } from "@/lib/notify";
import { runMarketCloseJob } from "@/lib/report/run";
import { createAdminClient } from "@/lib/supabase/admin";

// Collection plus a bilingual report from Opus 5 runs well past the default.
// 60s is the ceiling on Hobby; if generation outgrows it the work has to be
// split rather than raised.
export const maxDuration = 60;

type JobPayload = {
  runId: string;
  sessionDate: string;
};

/**
 * Runs one session's report. Reached only through QStash, so the signature
 * check is the authentication; the work itself lives in runMarketCloseJob.
 */
async function handle(request: Request) {
  const { runId, sessionDate } = (await request.json()) as JobPayload;
  const supabase = createAdminClient();

  const finish = async (status: string, detail?: string) => {
    await supabase
      .from("report_runs")
      .update({ status, detail: detail ?? null, finished_at: new Date().toISOString() })
      .eq("id", runId);
  };

  try {
    const outcome = await runMarketCloseJob(runId, sessionDate);
    await finish(outcome.status, outcome.detail);
    return Response.json(outcome, { status: 200 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finish("failed", detail);
    await notify({ type: "report.failed", sessionDate, detail });

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
