const seoulParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
});

/** Filing time, Seoul. Meetings after this belong to the next cycle. */
export const REPORT_HOUR_KST = 17;

/**
 * The KST date an idea is being worked on for.
 *
 * Not simply today: the department files at 17:00, so a meeting held at 21:00
 * is already researching tomorrow's idea. Taking the calendar date would put
 * those notes on a cycle that has already been reported and closed.
 */
export function cycleDate(at: Date = new Date()): string {
  const parts = Object.fromEntries(
    seoulParts.formatToParts(at).map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour);
  const date = `${parts.year}-${parts.month}-${parts.day}`;

  if (hour < REPORT_HOUR_KST) return date;

  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Yesterday's cycle, for picking up the idea a reply refers to. */
export function previousCycleDate(at: Date = new Date()): string {
  const current = new Date(`${cycleDate(at)}T00:00:00Z`);
  current.setUTCDate(current.getUTCDate() - 1);
  return current.toISOString().slice(0, 10);
}
