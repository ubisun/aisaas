import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Today's trading run, if one was opened.
 *
 * The tick and close schedules fire on a clock and know nothing about run ids,
 * so they resolve the day's run here rather than carrying state.
 */
export async function findTodayRun(tradeDate: string): Promise<{ id: string } | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("runs")
    .select("id, status")
    .match({ team: "trading", kind: "morning-session", key: tradeDate })
    .maybeSingle();

  if (!data) return null;
  // A finished or failed day is not resumed by a later tick.
  if (data.status === "succeeded" || data.status === "failed" || data.status === "skipped") {
    return null;
  }
  return { id: data.id as string };
}
