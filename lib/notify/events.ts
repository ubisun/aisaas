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
  | {
      type: "strategy.idea-filed";
      ideaDate: string;
      title: string;
      titleEn: string;
      summary: string;
      firstTest: string;
      revenue: string;
      risks: string;
      carriedForward: boolean;
      meetings: number;
      detailEn: string;
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

function appUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return `${base.replace(/\/$/, "")}${path}`;
}

export function render(event: AppEvent): RenderedEvent {
  switch (event.type) {
    case "market-report.published":
      return {
        html:
          `<b>📈 Market report ready</b>\n` +
          `US session <b>${escapeHtml(event.sessionDate)}</b>\n` +
          `${event.sectorCount} KRX sectors · ${(event.durationMs / 1000).toFixed(0)}s\n\n` +
          `<a href="${escapeHtml(appUrl("/reports"))}">Open the report</a>`,
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
          // The link is the point of this message on a phone: the briefing
          // says what happened, the page says what it was made of.
          `<a href="${escapeHtml(appUrl("/performance"))}">종목별 상세 보기</a>\n\n` +
          `<i>모의투자 · 체결은 실제보다 낙관적입니다</i>`,
      };
    }

    case "strategy.idea-filed":
      return {
        html:
          `<b>💡 사업 아이디어 · ${escapeHtml(event.ideaDate)}</b>\n` +
          `${event.carriedForward ? "어제 피드백 반영" : "신규 아이디어"} · 회의 ${event.meetings}회\n\n` +
          `<b>${escapeHtml(event.title)}</b>\n` +
          `<i>${escapeHtml(event.titleEn)}</i>\n\n` +
          `${escapeHtml(event.summary)}\n\n` +
          `<b>수익 구조</b>\n${escapeHtml(event.revenue)}\n\n` +
          `<b>가장 큰 위험</b>\n${escapeHtml(event.risks)}\n\n` +
          `<b>첫 검증</b>\n${escapeHtml(event.firstTest)}\n\n` +
          `<i>이 메시지에 그냥 답장하시면 피드백으로 기록됩니다. 답장이 없으면 내일은 새 아이디어를 찾습니다.</i>`,
      };

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
