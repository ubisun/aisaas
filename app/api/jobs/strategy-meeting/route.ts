import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { enqueue } from "@/lib/queue";
import { claimRun } from "@/lib/runs";
import { onDuty, standbyResponse } from "@/lib/teams/roster";
import { cycleDate } from "@/lib/teams/strategy/cycle";

/**
 * A research meeting. Several run against the same cycle, so the run key
 * carries the meeting slot as well as the date -- claiming per cycle would
 * make every meeting after the first look like a redelivery.
 *
 * The schedule fires twice a day, at 00:00 and 04:00 UTC.
 */
async function handle() {
  // Declined before the run is claimed, so a stood-down department leaves no
  // trail of skipped runs behind it.
  if (!onDuty("strategy")) return standbyResponse("strategy");

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
