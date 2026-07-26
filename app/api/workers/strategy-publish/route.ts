import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { notify } from "@/lib/notify";
import { finishRun } from "@/lib/runs";
import { publishIdea } from "@/lib/teams/strategy/session";

// Translation plus delivery.
// Hobby allows up to 300s; the earlier 60 here was a mistaken limit,
// not a platform one.
export const maxDuration = 180;

/** Translates the filed idea and sends it to the CEO. */
async function handle(request: Request) {
  const { runId, ideaDate, ideaId } = (await request.json()) as {
    runId: string;
    ideaDate: string;
    ideaId: string;
  };

  try {
    await publishIdea(runId, ideaId);
    await finishRun(runId, "succeeded");
    return Response.json({ ideaDate, status: "published" }, { status: 200 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "failed", detail);
    await notify({ type: "job.exhausted", step: "strategy-publish", key: ideaDate, detail });
    return Response.json({ status: "failed", detail }, { status: 500 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
