/**
 * Which departments are on duty.
 *
 * The schedules live in QStash and fire regardless of what the code thinks, so
 * this is the in-repo answer to "what is the company currently doing" -- a
 * question that previously could only be answered by opening the Upstash
 * console. A department that is off duty still gets woken by its schedule; its
 * job endpoint simply declines the work and returns, claiming no run and
 * spending nothing.
 *
 * Standing a department down here is deliberately not the same as deleting its
 * schedule. The schedule is the arrangement; this is the assignment. Pausing
 * the schedule as well only saves the wasted delivery.
 *
 * Only the endpoints that *begin* a day's work consult this: market-close,
 * trading and the two strategy jobs. `trading-tick` and `trading-close` do not,
 * on purpose -- they service a session that is already open, and gating them
 * would mean a desk stood down at 09:30 stops running its stop-losses and never
 * flattens what it is holding. A session that was never opened is already a
 * no-op there, because `findTodayRun` finds nothing.
 */

export type Department = "market-report" | "trading" | "strategy";

export type Duty = {
  onDuty: boolean;
  /** KST date the current assignment took effect. */
  since: string;
  /** Why it is in this state. Shown in the job response, so keep it one line. */
  note: string;
};

export const ROSTER: Record<Department, Duty> = {
  /**
   * Back on duty 2026-08-30, after credit was added. It was stood down for one
   * day because it could not produce anything, not because of what it cost --
   * generate and translate come to about $0.11 a session, the cheapest work the
   * company does.
   *
   * It is back first, and deliberately before the trading desk starts placing
   * orders, because the sector view it produces is the only input that tells
   * `agent-v1` apart from the rule-based desk beside it. Without it that
   * strategy is a model re-ranking a table the screen has already ranked, and
   * judging it on that would be judging it at its worst.
   *
   * The next run is 22:00 UTC Monday, which is 07:00 KST Tuesday and reports
   * Monday's US session -- in place for Tuesday's open, which is when the desk
   * first trades for real.
   */
  "market-report": {
    onDuty: true,
    since: "2026-08-30",
    note: "Daily US close report; the trading desk reads its sector view.",
  },

  trading: {
    onDuty: true,
    since: "2026-07-26",
    note: "Paper-account morning session.",
  },

  /**
   * Stood down 2026-08-29, awaiting reassignment.
   *
   * Not a fault -- the department worked, filing an idea a day from 07-27 to
   * 08-05. It is stood down because of what it cost: `strategy/search` was
   * $17.85 of the company's $21.35 total, 84% of all model spend, at $0.85 a
   * call. The web search results come back into context at roughly 127k input
   * tokens per call, which is where the money goes -- the per-search fee is
   * minor next to that.
   *
   * Before it goes back on duty, that call is the thing to change: summarise
   * or truncate the search results before they are fed back, or move the
   * search itself to the cheap model.
   */
  strategy: {
    onDuty: false,
    since: "2026-08-29",
    note: "Stood down pending reassignment; the search step needs to get cheaper first.",
  },
};

export function onDuty(department: Department): boolean {
  return ROSTER[department].onDuty;
}

/** The body a job endpoint returns when its department is off duty. */
export function standbyResponse(department: Department): Response {
  const duty = ROSTER[department];
  return Response.json(
    {
      department,
      status: "standby",
      since: duty.since,
      note: duty.note,
      enqueued: false,
    },
    { status: 200 },
  );
}
