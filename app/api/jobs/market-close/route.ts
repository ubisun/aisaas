import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { enqueue } from "@/lib/queue";
import { claimRun } from "@/lib/runs";
import { sessionDate } from "@/lib/teams/market-report/session";

const TEAM = "market-report";
const KIND = "daily-close";

/**
 * QStash schedule target, fired after the US close.
 *
 * It claims the session and hands the work to the worker, then returns
 * immediately -- collection and model calls never run inside a request
 * handler (AGENTS.md rule 3). Idempotent claiming and recovery of runs that
 * died mid-flight both live in lib/runs, shared with every other team.
 */
async function handle() {
  const session = sessionDate();

  const claim = await claimRun(TEAM, KIND, session);
  if (!claim.claimed) {
    // A redelivery of work already finished or still genuinely in flight.
    // Acknowledge so QStash stops retrying.
    return Response.json(
      { session, status: claim.run.status, reason: claim.reason, enqueued: false },
      { status: 200 },
    );
  }

  await enqueue("/api/workers/market-close", {
    runId: claim.run.id,
    sessionDate: session,
  });

  return Response.json({ session, runId: claim.run.id, enqueued: true }, { status: 202 });
}

// The wrapper is built per request, not at module scope: it reads the signing
// keys eagerly, and at module scope that turns a missing key into a build
// failure rather than a runtime error.
export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
