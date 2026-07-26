/**
 * US trading session dates.
 *
 * The pipeline runs after the US close, which is already the next calendar day
 * in KST, so the session date can never be derived from the server's local
 * clock. Everything here is computed in America/New_York, which also absorbs
 * the EST/EDT shift without a hardcoded offset.
 */

const NEW_YORK = "America/New_York";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: NEW_YORK,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const weekdayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: NEW_YORK,
  weekday: "short",
});

/** The calendar date in New York, as YYYY-MM-DD. */
export function newYorkDate(at: Date = new Date()): string {
  return dateFormatter.format(at);
}

function isWeekend(at: Date): boolean {
  const day = weekdayFormatter.format(at);
  return day === "Sat" || day === "Sun";
}

/**
 * The trading session this run is reporting on: the New York date at run time,
 * walked back to Friday if the job fires over a weekend.
 *
 * Market holidays are not encoded here on purpose -- a static calendar would
 * need editing every year. They are detected from the data instead, by
 * comparing the quote timestamp against the expected date (see isStale).
 */
export function sessionDate(at: Date = new Date()): string {
  const cursor = new Date(at);
  while (isWeekend(cursor)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return newYorkDate(cursor);
}

/**
 * Whether a quote's last-trade timestamp predates the session we expect to be
 * reporting on -- the signal that the market was closed for a holiday and the
 * provider is still serving the previous session.
 *
 * Finnhub returns `t` as epoch seconds. It is absent from some documented
 * client models, so a missing timestamp is treated as "cannot tell" and the run
 * proceeds rather than skipping on incomplete evidence.
 */
export function isStale(quoteTimestamp: number | undefined, expected: string): boolean {
  if (!quoteTimestamp) return false;
  return newYorkDate(new Date(quoteTimestamp * 1000)) < expected;
}
