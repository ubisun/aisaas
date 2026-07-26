import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Scheduled execution records, shared by every team.
 *
 * Claiming, recovering and finishing a run lives here rather than in each
 * team's route, because the interesting case -- a run killed mid-flight --
 * is easy to get wrong and was already fixed once.
 */

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

export type Run = {
  id: string;
  team: string;
  kind: string;
  key: string;
  status: RunStatus;
  phase: string | null;
  detail: string | null;
  started_at: string;
};

/**
 * How long a non-terminal run may go without progress before a later delivery
 * may take its slot.
 *
 * A run killed mid-flight -- a function timeout, say -- never gets to write
 * `failed`, so without this it would sit in `running` forever and block its
 * key from ever being retried.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

export type ClaimResult =
  | { claimed: true; run: Run }
  | { claimed: false; reason: "done" | "in-flight"; run: Run };

/**
 * Take ownership of one unit of work, or report that someone already has it.
 *
 * `claimed: false` is the normal answer to a redelivery and should be
 * acknowledged, not retried.
 */
export async function claimRun(
  team: string,
  kind: string,
  key: string,
): Promise<ClaimResult> {
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from("runs")
    .select("id, team, kind, key, status, phase, detail, started_at")
    .match({ team, kind, key })
    .maybeSingle();

  if (existing) {
    const run = existing as Run;
    const done = run.status === "succeeded" || run.status === "skipped";
    const abandoned =
      !done &&
      run.status !== "failed" &&
      Date.now() - new Date(run.started_at).getTime() > STALE_AFTER_MS;

    if (done) return { claimed: false, reason: "done", run };
    if (!abandoned && run.status !== "failed") {
      return { claimed: false, reason: "in-flight", run };
    }
  }

  const { data, error } = await supabase
    .from("runs")
    .upsert(
      {
        team,
        kind,
        key,
        status: "queued",
        phase: null,
        detail: null,
        finished_at: null,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "team,kind,key" },
    )
    .select("id, team, kind, key, status, phase, detail, started_at")
    .single();

  if (error) throw new Error(`Claiming a run failed: ${error.message}`);
  return { claimed: true, run: data as Run };
}

/** Record which step a run is on. Teams name their own phases. */
export async function setPhase(runId: string, phase: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("runs")
    .update({ status: "running", phase, updated_at: new Date().toISOString() })
    .eq("id", runId);
}

export async function finishRun(
  runId: string,
  status: Extract<RunStatus, "succeeded" | "failed" | "skipped">,
  detail?: string,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("runs")
    .update({
      status,
      detail: detail ?? null,
      phase: null,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
}
