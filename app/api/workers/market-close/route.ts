import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { notify } from "@/lib/notify";
import { enqueue } from "@/lib/queue";
import { runMarketCloseJob } from "@/lib/report/run";
import { createAdminClient } from "@/lib/supabase/admin";

type JobPayload = {
  runId: string;
  sessionDate: string;
};

// 60s is the Hobby ceiling. Collection plus the English report fits; the
// Korean translation is queued separately rather than raising this.
export const maxDuration = 60;

/**
 * Collects the session and writes the English report, then hands the
 * translation to its own queued step.
 */
async function handle(request: Request) {
  const { runId, sessionDate } = (await request.json()) as JobPayload;
  const supabase = createAdminClient();
  const startedAtMs = Date.now();

  try {
    const { outcome, needsTranslation } = await runMarketCloseJob(runId, sessionDate);

    if (!needsTranslation) {
      await supabase
        .from("report_runs")
        .update({
          status: outcome.status,
          detail: outcome.detail ?? null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
      return Response.json(outcome, { status: 200 });
    }

    await enqueue("/api/workers/translate", { runId, sessionDate, startedAtMs });
    return Response.json({ status: "translating", sessionDate }, { status: 202 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await supabase
      .from("report_runs")
      .update({ status: "failed", detail, finished_at: new Date().toISOString() })
      .eq("id", runId);
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
