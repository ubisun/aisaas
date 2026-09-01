/**
 * Turning a session into something the CEO can act on.
 *
 * The rule this file exists for: **every strategy on duty gets a line, whether
 * it traded or not.** The briefing used to group by submitted order, so a
 * strategy that bought nothing simply vanished from it -- which made "it ran
 * and found no setup" indistinguishable from "it is dead". On 2026-09-01 the
 * opening-range strategy tracked five breakouts, reached the retest line three
 * times, declined all of them, and was invisible in the report.
 *
 * That is the wrong way round for a desk whose own prompt says a day with no
 * trades is a good day if nothing met the bar. A silence has to say what kind
 * of silence it is.
 */

export type StrategyReport = {
  name: string;
  live: boolean;
  /** How many times it was asked. Zero means it never ran at all. */
  ticks: number;
  /** Realised profit credited to it, or null when it traded nothing. */
  realised: number | null;
  /** One formatted line per submitted order. */
  orders: string[];
  /** Its final word, when it placed no orders. */
  verdict: string | null;
};

/**
 * Condense a strategy's last word into something that fits a phone.
 *
 * Two shapes arrive here. A rule-based strategy reports one line per ticker
 * (`005930: inside the range`), which is tallied -- twenty-seven tickers is not
 * a message, but "레인지 내 12 · 리테스트 대기 5" is. A model reports prose,
 * which is truncated.
 *
 * A strategy that failed is neither, and is passed through whole: that is the
 * one case where the detail is the entire point.
 */
export function summariseVerdict(reasoning: string, limit = 220): string {
  const text = String(reasoning ?? "").trim();
  if (!text) return "기록 없음";
  if (text.startsWith("Strategy failed")) return text.slice(0, 400);

  const perTicker = text
    .split("\n")
    .map((line) => line.match(/^\s*[0-9A-Z]{6}:\s*(.+?)\s*$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[1]);

  if (perTicker.length < 2) {
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  const tally = new Map<string, number>();
  for (const state of perTicker) {
    // Collapse the variants that carry a reason after a dash, so a tally does
    // not turn into a list of near-identical sentences.
    const key = state.split(" — ")[0].replace(/\s*\(.*\)\s*$/, "");
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([state, count]) => `${state} ${count}`)
    .join(" · ");
}

const won = (value: number) =>
  `${value >= 0 ? "+" : "−"}${Math.abs(Math.round(value)).toLocaleString("ko-KR")}원`;

/**
 * The per-strategy body of the closing briefing.
 *
 * Ordered so that whoever traded is read first and whoever sat out is still
 * accounted for underneath.
 */
export function renderStrategyReports(
  reports: StrategyReport[],
  estimated: boolean,
): string[] {
  const lines: string[] = [];

  const ordered = [...reports].sort(
    (a, b) => b.orders.length - a.orders.length || a.name.localeCompare(b.name),
  );

  for (const report of ordered) {
    const label = report.live ? report.name : `${report.name} (관찰)`;
    const pnl =
      report.realised === null
        ? ""
        : ` · ${estimated ? "추정" : "실현"} ${won(report.realised)}`;

    lines.push(`— ${label}${pnl} —`);

    if (report.orders.length) {
      lines.push(...report.orders);
      continue;
    }

    if (report.ticks === 0) {
      // Distinct from "decided not to trade", and much more interesting.
      lines.push("판단 기록 없음 — 실행되지 않았습니다");
      continue;
    }

    lines.push(`${report.ticks}회 판단, 주문 없음`);
    if (report.verdict) lines.push(`  ${report.verdict}`);
  }

  return lines;
}
