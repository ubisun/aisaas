import { Client } from "@upstash/qstash";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { sessionDate } from "@/lib/market/session";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * QStash schedule target, fired after the US close.
 *
 * It claims the session and hands the work to the worker, then returns
 * immediately -- collection and model calls never run inside a request
 * handler (AGENTS.md rule 3). The signature is verified by the wrapper and
 * the claim is idempotent, so a QStash retry cannot produce a second report
 * for the same session (rule 4).
 */
/**
 * How long a non-terminal run may go without progress before a later delivery
 * is allowed to take the session over. Comfortably longer than a full run,
 * which is bounded by two 60s function invocations.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

async function handle() {
  const session = sessionDate();
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from("report_runs")
    .select("id, status, started_at")
    .eq("session_date", session)
    .maybeSingle();

  if (existing) {
    const done = existing.status === "succeeded" || existing.status === "skipped";

    // A run killed mid-flight -- a function timeout, say -- never gets to
    // write `failed`, so it would sit in `analyzing` forever and permanently
    // block its session from being retried. Anything non-terminal that has
    // stopped making progress is treated as abandoned and re-claimed.
    const abandoned =
      !done &&
      existing.status !== "failed" &&
      Date.now() - new Date(existing.started_at).getTime() > STALE_AFTER_MS;

    // A finished or genuinely in-flight run means this is a retry of a
    // delivery we already accepted. Acknowledge it so QStash stops
    // redelivering.
    if (done || (!abandoned && existing.status !== "failed")) {
      return Response.json(
        { session, status: existing.status, enqueued: false },
        { status: 200 },
      );
    }
  }

  const { data: run, error } = await supabase
    .from("report_runs")
    .upsert(
      { session_date: session, status: "queued", detail: null, finished_at: null },
      { onConflict: "session_date" },
    )
    .select("id")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return Response.json({ error: "NEXT_PUBLIC_APP_URL is not set" }, { status: 500 });
  }

  const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
  await qstash.publishJSON({
    url: `${appUrl}/api/workers/market-close`,
    body: { runId: run.id, sessionDate: session },
  });

  return Response.json({ session, runId: run.id, enqueued: true }, { status: 202 });
}

// The wrapper is built per request, not at module scope: it reads the signing
// keys eagerly, and at module scope that turns a missing key into a build
// failure rather than a runtime error.
export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
