/**
 * Application events worth telling someone about.
 *
 * Adding a new event means adding a variant here and a case in `render`.
 * The compiler will point at every place that needs updating, which is the
 * reason this is a discriminated union rather than a loose payload.
 */
export type AppEvent =
  | {
      type: "market-report.published";
      sessionDate: string;
      sectorCount: number;
      durationMs: number;
    }
  | { type: "market-report.skipped"; sessionDate: string; detail: string }
  | { type: "market-report.failed"; sessionDate: string; detail: string }
  /**
   * A queued step that gave up entirely -- reported from outside the dead
   * process, so it belongs to no team in particular.
   */
  | {
      type: "trading.session-closed";
      tradeDate: string;
      entries: number;
      exits: number;
      rejected: number;
      ticks: number;
      unrealisedPnl: number | null;
      holdingsValue: number | null;
      /** One line per submitted order, already formatted. */
      lines: string[];
    }
  | { type: "job.exhausted"; step: string; key: string; detail: string }
  /** A step failed but enough survived to be worth finishing rather than redoing. */
  | { type: "job.retrying"; step: string; key: string; detail: string };

export type RenderedEvent = {
  /** Telegram HTML: only &, < and > need escaping. */
  html: string;
  /** Suppresses the link preview card for events that carry a URL. */
  silent?: boolean;
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function reportsUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return `${base.replace(/\/$/, "")}/reports`;
}

export function render(event: AppEvent): RenderedEvent {
  switch (event.type) {
    case "market-report.published":
      return {
        html:
          `<b>📈 Market report ready</b>\n` +
          `US session <b>${escapeHtml(event.sessionDate)}</b>\n` +
          `${event.sectorCount} KRX sectors · ${(event.durationMs / 1000).toFixed(0)}s\n\n` +
          `<a href="${escapeHtml(reportsUrl())}">Open the report</a>`,
      };

    case "market-report.skipped":
      return {
        html:
          `<b>⏸ No report for ${escapeHtml(event.sessionDate)}</b>\n` +
          `${escapeHtml(event.detail)}`,
        silent: true,
      };

    case "market-report.failed":
      return {
        html:
          `<b>❌ Market report failed</b>\n` +
          `US session <b>${escapeHtml(event.sessionDate)}</b>\n\n` +
          `<code>${escapeHtml(event.detail.slice(0, 500))}</code>`,
      };

    case "trading.session-closed": {
      const pnl =
        event.unrealisedPnl === null
          ? "계좌 조회 실패"
          : `${event.unrealisedPnl >= 0 ? "+" : ""}${Math.round(event.unrealisedPnl).toLocaleString()}원`;

      const body = event.lines.length
        ? event.lines.map(escapeHtml).join("\n")
        : "체결된 주문 없음 — 기준에 맞는 자리가 없었습니다.";

      return {
        html:
          `<b>📊 단타 세션 종료 · ${escapeHtml(event.tradeDate)}</b>\n` +
          `진입 ${event.entries}회 · 청산 ${event.exits}회 · 거부 ${event.rejected}건 · 판단 ${event.ticks}회\n` +
          `평가손익 ${escapeHtml(pnl)}\n\n` +
          `${body}\n\n` +
          `<i>모의투자 · 체결은 실제보다 낙관적입니다</i>`,
      };
    }

    case "job.exhausted":
      return {
        html:
          `<b>🛑 A job gave up</b>\n` +
          `<b>${escapeHtml(event.step)}</b> for <b>${escapeHtml(event.key)}</b>\n\n` +
          `<code>${escapeHtml(event.detail.slice(0, 500))}</code>\n\n` +
          `Retries are exhausted; nothing will run again until the next schedule.`,
      };

    case "job.retrying":
      return {
        html:
          `<b>🔁 Repairing a run</b>\n` +
          `<b>${escapeHtml(event.step)}</b> for <b>${escapeHtml(event.key)}</b>\n\n` +
          `${escapeHtml(event.detail)}`,
        silent: true,
      };
  }
}
