import { describe, expect, it } from "vitest";

import { render, type AppEvent } from "@/lib/notify/events";
import { costOf, type UsageRow } from "@/lib/telegram/commands";

/**
 * What reaches the CEO, and what it says it cost.
 *
 * Telegram parses these as HTML, so an unescaped angle bracket in a company
 * name or a model's prose does not merely look wrong -- the message is rejected
 * and the report is silently lost. That is the failure mode worth a test: the
 * desk works, and nobody hears about it.
 */

const usage = (over: Partial<UsageRow> = {}): UsageRow => ({
  team: "trading",
  purpose: "tick",
  model: "claude-opus-5",
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  web_searches: 0,
  ...over,
});

describe("event rendering", () => {
  const events: AppEvent[] = [
    { type: "market-report.published", sessionDate: "2026-08-28", sectorCount: 11, durationMs: 42_000 },
    { type: "market-report.skipped", sessionDate: "2026-08-28", detail: "holiday" },
    { type: "market-report.failed", sessionDate: "2026-08-28", detail: "boom" },
    {
      type: "trading.session-closed",
      tradeDate: "2026-08-31",
      entries: 2,
      exits: 2,
      rejected: 1,
      ticks: 28,
      unrealisedPnl: 0,
      holdingsValue: 0,
      lines: [],
    },
    { type: "job.exhausted", step: "trading-tick", key: "2026-08-31", detail: "gone" },
    { type: "job.retrying", step: "translate", key: "2026-08-28", detail: "again" },
  ];

  it("renders every event to non-empty HTML", () => {
    for (const event of events) {
      expect(render(event).html.length).toBeGreaterThan(0);
    }
  });

  it("escapes markup that arrives in a detail string", () => {
    const { html } = render({
      type: "market-report.failed",
      sessionDate: "2026-08-28",
      detail: "<script>alert(1)</script> & co",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("escapes a company name carrying an ampersand", () => {
    const { html } = render({
      type: "trading.session-closed",
      tradeDate: "2026-08-31",
      entries: 1,
      exits: 1,
      rejected: 0,
      ticks: 10,
      unrealisedPnl: 1_000,
      holdingsValue: 0,
      lines: ["🟢 매수 A & B <주의>"],
    });
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;주의&gt;");
  });

  it("says so plainly when the account could not be read", () => {
    const { html } = render({
      type: "trading.session-closed",
      tradeDate: "2026-08-31",
      entries: 0,
      exits: 0,
      rejected: 0,
      ticks: 0,
      unrealisedPnl: null,
      holdingsValue: null,
      lines: [],
    });
    expect(html).toContain("계좌 조회 실패");
  });

  it("carries a link to the detail, because the briefing is read on a phone", () => {
    const { html } = render({
      type: "trading.session-closed",
      tradeDate: "2026-09-04",
      entries: 1,
      exits: 1,
      rejected: 0,
      ticks: 10,
      unrealisedPnl: 0,
      holdingsValue: 0,
      lines: [],
    });
    expect(html).toContain("/performance");
    expect(html).toContain("종목별 상세");
  });

  it("does not pretend a session with no fills was a session with fills", () => {
    const { html } = render({
      type: "trading.session-closed",
      tradeDate: "2026-08-31",
      entries: 0,
      exits: 0,
      rejected: 3,
      ticks: 28,
      unrealisedPnl: 0,
      holdingsValue: 0,
      lines: [],
    });
    expect(html).toContain("체결된 주문 없음");
  });
});

describe("model cost", () => {
  it("prices input and output at the model's rates", () => {
    // 1M input at $5 and 1M output at $25.
    const cost = costOf(usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }));
    expect(cost).toBeCloseTo(30, 6);
  });

  it("prices a cache read at a tenth of input", () => {
    expect(costOf(usage({ cache_read_tokens: 1_000_000 }))).toBeCloseTo(0.5, 6);
  });

  it("prices a cache write at a premium over input", () => {
    expect(costOf(usage({ cache_write_tokens: 1_000_000 }))).toBeCloseTo(6.25, 6);
  });

  it("charges per web search on top of tokens", () => {
    expect(costOf(usage({ web_searches: 10 }))).toBeCloseTo(0.1, 6);
  });

  it("charges the cheaper model less for the same work", () => {
    const work = { input_tokens: 100_000, output_tokens: 100_000 };
    const opus = costOf(usage({ ...work, model: "claude-opus-5" }));
    const sonnet = costOf(usage({ ...work, model: "claude-sonnet-5" }));
    expect(sonnet).toBeLessThan(opus);
  });

  it("falls back to the dearest rate for a model it does not know", () => {
    // An unknown model must not be billed as free, or a new one would quietly
    // vanish from the accounting.
    const unknown = costOf(usage({ input_tokens: 1_000_000, model: "claude-something-new" }));
    expect(unknown).toBeCloseTo(5, 6);
  });

  it("costs nothing for a call that used nothing", () => {
    expect(costOf(usage())).toBe(0);
  });
});
