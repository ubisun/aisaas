import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

import { finishRun } from "@/lib/runs";
import { runMeeting } from "@/lib/teams/strategy/session";

// Writing up what the search found.
// Hobby allows up to 300s; the earlier 60 here was a mistaken limit,
// not a platform one.
export const maxDuration = 180;

/** Turns the search output into meeting notes and closes the run. */
async function handle(request: Request) {
  const { runId, searchOutput } = (await request.json()) as {
    runId: string;
    searchOutput: string;
  };

  try {
    const outcome = await runMeeting(runId, searchOutput);
    await finishRun(runId, "succeeded");
    return Response.json(outcome, { status: 200 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "failed", detail);
    return Response.json({ status: "failed", detail }, { status: 500 });
  }
}

export function POST(request: Request) {
  return verifySignatureAppRouter(handle)(request);
}
