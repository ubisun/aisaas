const seoulDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const seoulWeekday = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  weekday: "short",
});

/** The KRX trading date, as YYYY-MM-DD in Asia/Seoul. */
export function seoulTradeDate(at: Date = new Date()): string {
  return seoulDate.format(at);
}

/**
 * Whether KRX is plausibly open.
 *
 * Weekends only. Korean market holidays are not encoded: a static list needs
 * editing every year and rots silently. The morning screen catches a closed
 * market anyway -- no turnover means no candidates, and the session ends
 * having done nothing, which is the correct outcome.
 */
export function isLikelyTradingDay(at: Date = new Date()): boolean {
  const day = seoulWeekday.format(at);
  return day !== "Sat" && day !== "Sun";
}
