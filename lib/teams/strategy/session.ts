import { notify } from "@/lib/notify";
import { setPhase } from "@/lib/runs";
import { createAdminClient } from "@/lib/supabase/admin";

import { cycleDate, previousCycleDate } from "./cycle";
import {
  draftIdea,
  holdMeeting,
  searchForEvidence,
  translateIdea,
  type MeetingNotes,
} from "./research";

/**
 * The strategy department's day.
 *
 * Meetings accumulate notes against a cycle; the filing at 17:00 KST writes
 * them up as one idea and sends it to the CEO. What happens the next morning
 * depends entirely on whether a reply arrived: with one, the idea is carried
 * forward; without, the department starts fresh.
 */

type PriorIdea = {
  id: string;
  title: string;
  summary: string;
  detail: Record<string, unknown>;
  feedback: string[];
};

/**
 * Yesterday's idea, and any reply to it that has not yet been taken into
 * account.
 *
 * Feedback is marked consumed once a cycle has used it, so the same note
 * cannot steer two days running -- otherwise a single "make it cheaper" would
 * be re-applied every morning until something else arrived.
 */
async function priorIdea(currentCycle: string): Promise<PriorIdea | null> {
  const supabase = createAdminClient();

  const { data: idea } = await supabase
    .from("strategy_ideas")
    .select("id, title, summary, detail")
    .lt("idea_date", currentCycle)
    .order("idea_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!idea) return null;

  const { data: feedback } = await supabase
    .from("idea_feedback")
    .select("body")
    .eq("idea_id", idea.id)
    .is("consumed_at", null)
    .order("received_at", { ascending: true });

  return {
    id: idea.id as string,
    title: idea.title as string,
    summary: idea.summary as string,
    detail: (idea.detail ?? {}) as Record<string, unknown>,
    feedback: (feedback ?? []).map((f) => f.body as string),
  };
}

function describeHistory(prior: PriorIdea | null, notes: MeetingNotes[]): string {
  const parts: string[] = [];

  if (prior && prior.feedback.length) {
    parts.push(
      `Yesterday's idea — "${prior.title}"\n${prior.summary}\n\nThe CEO replied:\n${prior.feedback
        .map((f) => `- ${f}`)
        .join("\n")}\n\nCarry this forward: address the reply directly. If the reply rejects the idea, say what you took from it and move to something else rather than defending it.`,
    );
  } else if (prior) {
    parts.push(
      `Yesterday's idea was "${prior.title}". No reply came, so it is not being carried forward — find something new rather than restating it. You may reuse anything you learned, but the idea itself should be different.`,
    );
  } else {
    parts.push("There is no previous idea. This is the first.");
  }

  if (notes.length) {
    parts.push(
      `Research so far this cycle, oldest first:\n${notes
        .map((n, i) => {
          const findings = n.findings.length
            ? n.findings
                .map((f) => `  · ${f.what} — ${f.who}. Evidence: ${f.evidence} (${f.source})`)
                .join("\n")
            : "  · nothing new";
          return `Meeting ${i + 1}:\n${findings}\n  Development: ${n.development}\n  Open: ${n.open_questions.join("; ") || "none"}`;
        })
        .join("\n\n")}`,
    );
  } else {
    parts.push("No meetings have been held for this cycle yet.");
  }

  return parts.join("\n\n");
}

async function meetingNotesFor(ideaDate: string): Promise<MeetingNotes[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("strategy_meetings")
    .select("notes")
    .eq("idea_date", ideaDate)
    .order("sequence", { ascending: true });

  return (data ?? []).map((row) => row.notes as MeetingNotes);
}

/**
 * The search half of a meeting.
 *
 * Kept apart from the write-up because doing both in one request ran past the
 * 60s function ceiling -- measured, not guessed: the first attempt timed out
 * with the search still going.
 */
export async function runSearch(runId: string): Promise<{ sequence: number; output: string }> {
  const ideaDate = cycleDate();
  await setPhase(runId, "searching");

  const [prior, notes] = await Promise.all([priorIdea(ideaDate), meetingNotesFor(ideaDate)]);
  const sequence = notes.length + 1;

  const output = await searchForEvidence(
    `Cycle for ${ideaDate}. This is meeting ${sequence}.\n\n${describeHistory(prior, notes)}`,
  );

  return { sequence, output };
}

/** The write-up half: turn what the search found into notes. */
export async function runMeeting(
  runId: string,
  searchOutput: string,
): Promise<{ sequence: number; findings: number }> {
  const supabase = createAdminClient();
  const ideaDate = cycleDate();
  await setPhase(runId, "meeting");

  const [prior, notes] = await Promise.all([priorIdea(ideaDate), meetingNotesFor(ideaDate)]);
  const sequence = notes.length + 1;

  const fresh = await holdMeeting(
    `Cycle for ${ideaDate}. This is meeting ${sequence}.\n\n${describeHistory(prior, notes)}`,
    searchOutput,
  );

  const { error } = await supabase.from("strategy_meetings").upsert(
    { run_id: runId, idea_date: ideaDate, sequence, notes: fresh },
    { onConflict: "idea_date,sequence" },
  );
  if (error) throw new Error(`Recording the meeting failed: ${error.message}`);

  return { sequence, findings: fresh.findings.length };
}

/** The 17:00 filing: write the idea up in English and store it. */
export async function fileIdea(runId: string): Promise<{ ideaId: string; title: string }> {
  const supabase = createAdminClient();
  const ideaDate = cycleDate();
  await setPhase(runId, "drafting");

  const [prior, notes] = await Promise.all([priorIdea(ideaDate), meetingNotesFor(ideaDate)]);
  const carriedForward = Boolean(prior && prior.feedback.length);

  const draft = await draftIdea(
    `File the idea for ${ideaDate}.\n\n${describeHistory(prior, notes)}`,
  );

  const { data, error } = await supabase
    .from("strategy_ideas")
    .upsert(
      {
        run_id: runId,
        idea_date: ideaDate,
        parent_id: carriedForward ? prior!.id : null,
        title: draft.title,
        summary: draft.summary,
        detail: draft.detail,
        status: "drafting",
        model: "claude-opus-5",
      },
      { onConflict: "idea_date" },
    )
    .select("id")
    .single();

  if (error) throw new Error(`Storing the idea failed: ${error.message}`);

  // The reply has now shaped an idea, so it should not shape the next one too.
  if (carriedForward) {
    await supabase
      .from("idea_feedback")
      .update({ consumed_at: new Date().toISOString() })
      .eq("idea_id", prior!.id)
      .is("consumed_at", null);

    await supabase.from("strategy_ideas").update({ status: "superseded" }).eq("id", prior!.id);
  }

  return { ideaId: data.id as string, title: draft.title };
}

/** Second step: translate the filed idea and send it to the CEO. */
export async function publishIdea(runId: string, ideaId: string): Promise<void> {
  const supabase = createAdminClient();
  await setPhase(runId, "translating");

  const { data: idea, error } = await supabase
    .from("strategy_ideas")
    .select("idea_date, title, summary, detail, parent_id")
    .eq("id", ideaId)
    .single();

  if (error || !idea) throw new Error(`No idea to publish: ${error?.message}`);

  const translation = await translateIdea({
    title: idea.title as string,
    summary: idea.summary as string,
    detail: idea.detail as never,
  });

  const { error: updateError } = await supabase
    .from("strategy_ideas")
    .update({
      summary_ko: translation.summary_ko,
      detail_ko: { ...translation.detail_ko, title_ko: translation.title_ko },
      status: "reported",
      reported_at: new Date().toISOString(),
    })
    .eq("id", ideaId);

  if (updateError) throw new Error(`Storing the translation failed: ${updateError.message}`);

  const detail = idea.detail as Record<string, string>;
  await notify({
    type: "strategy.idea-filed",
    ideaDate: idea.idea_date as string,
    title: translation.title_ko,
    titleEn: idea.title as string,
    summary: translation.summary_ko,
    firstTest: translation.detail_ko.first_test,
    revenue: translation.detail_ko.revenue,
    risks: translation.detail_ko.risks,
    carriedForward: Boolean(idea.parent_id),
    meetings: (await meetingNotesFor(idea.idea_date as string)).length,
    detailEn: detail.first_test ?? "",
  });
}

/**
 * Record a reply from the CEO against the most recent filed idea.
 *
 * Returns what it was attached to so the acknowledgement can name it -- a
 * reply that silently lands on the wrong idea is worse than one that bounces.
 */
export async function recordFeedback(body: string): Promise<{ title: string } | null> {
  const supabase = createAdminClient();

  const { data: idea } = await supabase
    .from("strategy_ideas")
    .select("id, title")
    .eq("status", "reported")
    .order("idea_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!idea) return null;

  const { error } = await supabase
    .from("idea_feedback")
    .insert({ idea_id: idea.id, body, via: "telegram" });

  if (error) throw new Error(`Storing feedback failed: ${error.message}`);
  return { title: idea.title as string };
}

export { cycleDate, previousCycleDate };
