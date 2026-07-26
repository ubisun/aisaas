import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { notify } from "@/lib/notify";
import { enqueue } from "@/lib/queue";
import { finishRun } from "@/lib/runs";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Called by QStash once a message has exhausted its retries.
 *
 * This exists because of the one failure the workers cannot report on
 * themselves. A thrown error is caught, recorded and announced; a function
 * killed at the 60s ceiling is not -- the process is gone before the catch
 * block runs. The run would sit in `running` forever, no notification would go
 * out, and nothing would revisit it until the next day's schedule.
 *
 * It also decides whether the work is worth resuming. The two steps fail very
 * differently: losing collection and the English report means redoing
 * everything, while losing only the translation means the expensive half
 * already survived in the database and just needs finishing.
 */

type FailureCallback = {
  /** Status the endpoint returned on the final attempt. 0 when it never did. */
  status: number;
  /** The original request body, base64 encoded. */
  body?: string;
  /** Endpoint that was being called. */
  url?: string;
  retried?: number;
  dlqId?: string;
};

/**
 * How many times a repair may be re-queued. Carried in the payload rather than
 * stored, so it is self-limiting: a repair that keeps failing runs out on its
 * own instead of looping.
 */
const MAX_REPAIR_ATTEMPTS = 2;

function decodeBody(encoded: string | undefined): Record<string, unknown> | null {
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function handle(request: Request) {
  const callback = (await request.json()) as FailureCallback;
  const payload = decodeBody(callback.body);

  const runId = typeof payload?.runId === "string" ? payload.runId : null;
  const sessionDate =
    typeof payload?.sessionDate === "string" ? payload.sessionDate : "unknown";
  const attempt = typeof payload?.attempt === "number" ? payload.attempt : 0;
  const startedAtMs =
    typeof payload?.startedAtMs === "number" ? payload.startedAtMs : Date.now();

  const step = callback.url?.split("/").pop() ?? "unknown";
  const attempts = `${(callback.retried ?? 0) + 1} attempt(s)`;
  const detail =
    callback.status === 0
      ? `${step} never responded after ${attempts} (likely a function timeout)`
      : `${step} failed with HTTP ${callback.status} after ${attempts}`;

  if (!runId) {
    console.error("failure callback: could not identify a run", callback);
    await notify({ type: "job.exhausted", step, key: sessionDate, detail });
    return Response.json({ ok: true }, { status: 200 });
  }

  // Ask the database what actually survived rather than inferring it from
  // which endpoint failed.
  const supabase = createAdminClient();
  const { data: report } = await supabase
    .from("reports")
    .select("us_summary, us_summary_ko")
    .eq("run_id", runId)
    .maybeSingle();

  const englishStored = Boolean(report?.us_summary);
  const koreanMissing = !report?.us_summary_ko;

  // The English report is the expensive half and it is already stored, so the
  // run is not worth failing outright -- only the translation is missing.
  if (englishStored && koreanMissing && attempt < MAX_REPAIR_ATTEMPTS) {
    await enqueue("/api/workers/translate", {
      runId,
      sessionDate,
      startedAtMs,
      attempt: attempt + 1,
    });

    await notify({
      type: "job.retrying",
      step,
      key: sessionDate,
      detail: `${detail}. The English report survived, so only the translation is being retried (attempt ${attempt + 2}).`,
    });

    return Response.json({ ok: true, repaired: "translate" }, { status: 200 });
  }

  await finishRun(runId, "failed", detail);

  const note = englishStored
    ? koreanMissing
      ? "The English report is stored and readable; the Korean translation could not be produced."
      : "The report is complete; the failure was after it was stored."
    : "Nothing was stored for this session.";

  await notify({
    type: "job.exhausted",
    step,
    key: sessionDate,
    detail: `${detail}. ${note}`,
  });

  if (callback.dlqId) {
    console.error(`failure callback: message parked in the DLQ as ${callback.dlqId}`);
  }

  // 200: the failure has been recorded. Anything else and QStash retries the
  // callback itself.
  return Response.json({ ok: true }, { status: 200 });
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
