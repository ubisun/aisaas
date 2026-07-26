import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { enqueue } from "@/lib/queue";
import { finishRun } from "@/lib/runs";
import { runSearch } from "@/lib/teams/strategy/session";

// Web search makes several round trips and reads what it finds; this is the slowest step in the company.
// Hobby allows up to 300s; the earlier 60 here was a mistaken limit,
// not a platform one.
export const maxDuration = 300;

/**
 * The search half of a meeting.
 *
 * Searching and writing up in one request timed out at 60s with the search
 * still running, so the write-up is queued separately.
 */
async function handle(request: Request) {
  const { runId, ideaDate } = (await request.json()) as { runId: string; ideaDate: string };

  try {
    const { sequence, output } = await runSearch(runId);
    await enqueue("/api/workers/strategy-notes", { runId, ideaDate, searchOutput: output });
    return Response.json({ ideaDate, sequence, searched: output.length }, { status: 202 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "failed", detail);
    return Response.json({ status: "failed", detail }, { status: 500 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
