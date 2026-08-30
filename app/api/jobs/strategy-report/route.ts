import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { enqueue } from "@/lib/queue";
import { claimRun } from "@/lib/runs";
import { onDuty, standbyResponse } from "@/lib/teams/roster";
import { cycleDate } from "@/lib/teams/strategy/cycle";

/** The 17:00 KST filing. One per cycle. */
async function handle() {
  if (!onDuty("strategy")) return standbyResponse("strategy");

  const ideaDate = cycleDate();

  const claim = await claimRun("strategy", "daily-idea", ideaDate);
  if (!claim.claimed) {
    return Response.json({ ideaDate, enqueued: false, reason: claim.reason }, { status: 200 });
  }

  await enqueue("/api/workers/strategy-draft", { runId: claim.run.id, ideaDate });
  return Response.json({ ideaDate, runId: claim.run.id, enqueued: true }, { status: 202 });
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
