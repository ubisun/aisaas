import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { enqueue } from "@/lib/queue";
import { finishRun } from "@/lib/runs";
import { fileIdea } from "@/lib/teams/strategy/session";

// Composing the day's idea from the cycle's notes.
// Hobby allows up to 300s; the earlier 60 here was a mistaken limit,
// not a platform one.
export const maxDuration = 180;

/**
 * Writes the idea in English and hands the translation to its own step, the
 * same split the market report uses -- one call doing both outgrows the 60s
 * ceiling.
 */
async function handle(request: Request) {
  const { runId, ideaDate } = (await request.json()) as { runId: string; ideaDate: string };

  try {
    const { ideaId, title } = await fileIdea(runId);
    await enqueue("/api/workers/strategy-publish", { runId, ideaDate, ideaId });
    return Response.json({ ideaDate, ideaId, title }, { status: 202 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "failed", detail);
    return Response.json({ status: "failed", detail }, { status: 500 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
