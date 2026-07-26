import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { enqueue } from "@/lib/queue";
import { claimRun } from "@/lib/runs";
import { cycleDate } from "@/lib/teams/strategy/cycle";

/**
 * A four-hourly meeting. Several run against the same cycle, so the run key
 * carries the meeting slot as well as the date -- claiming per cycle would
 * make every meeting after the first look like a redelivery.
 */
async function handle() {
  const ideaDate = cycleDate();
  const slot = new Date().toISOString().slice(11, 13);

  const claim = await claimRun("strategy", "meeting", `${ideaDate}-${slot}`);
  if (!claim.claimed) {
    return Response.json({ ideaDate, enqueued: false, reason: claim.reason }, { status: 200 });
  }

  await enqueue("/api/workers/strategy-meeting", { runId: claim.run.id, ideaDate });
  return Response.json({ ideaDate, runId: claim.run.id, enqueued: true }, { status: 202 });
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
