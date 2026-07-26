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
  | { type: "market-report.failed"; sessionDate: string; detail: string };

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
  }
}
