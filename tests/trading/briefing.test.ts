import { describe, expect, it } from "vitest";

import {
  renderStrategyReports,
  summariseVerdict,
  type StrategyReport,
} from "@/lib/teams/trading/briefing";

/**
 * The closing report.
 *
 * One rule carries this file: a strategy that traded nothing still appears. The
 * briefing used to group by submitted order, so on 2026-09-01 the
 * opening-range strategy tracked five breakouts, reached the retest line three
 * times, declined all of them -- and did not appear in the report at all. From
 * the CEO's side that is indistinguishable from a strategy that has stopped
 * running, which is a much worse thing to not notice.
 */

const report = (over: Partial<StrategyReport> = {}): StrategyReport => ({
  name: "orb-v1",
  live: true,
  ticks: 26,
  realised: null,
  orders: [],
  verdict: null,
  ...over,
});

describe("a strategy that traded nothing is still reported", () => {
  it("names it and says how many times it was asked", () => {
    const lines = renderStrategyReports([report()], true);
    expect(lines.join("\n")).toContain("orb-v1");
    expect(lines.join("\n")).toContain("26회 판단, 주문 없음");
  });

  it("distinguishes deciding not to trade from never running", () => {
    const decided = renderStrategyReports([report({ ticks: 26 })], true).join("\n");
    const absent = renderStrategyReports([report({ ticks: 0 })], true).join("\n");

    expect(decided).toContain("주문 없음");
    expect(absent).toContain("실행되지 않았습니다");
    expect(absent).not.toContain("26회");
  });

  it("carries its last word when it has one", () => {
    const lines = renderStrategyReports(
      [report({ verdict: "레인지 내 12 · 리테스트 대기 5" })],
      true,
    );
    expect(lines.join("\n")).toContain("레인지 내 12");
  });

  it("appears alongside a strategy that did trade", () => {
    const lines = renderStrategyReports(
      [
        report({ name: "orb-v1" }),
        report({ name: "agent-v1", realised: -135_460, orders: ["🟢 매수 003160 × 180"] }),
      ],
      true,
    );
    const text = lines.join("\n");
    expect(text).toContain("orb-v1");
    expect(text).toContain("agent-v1");
    // Whoever traded is read first.
    expect(text.indexOf("agent-v1")).toBeLessThan(text.indexOf("orb-v1"));
  });

  it("marks a shadow strategy as one, so its silence is expected", () => {
    const lines = renderStrategyReports([report({ live: false })], true);
    expect(lines.join("\n")).toContain("(관찰)");
  });
});

describe("profit is labelled by how it was arrived at", () => {
  it("says 추정 when attribution came from marks", () => {
    const lines = renderStrategyReports([report({ realised: -135_460 })], true);
    expect(lines.join("\n")).toContain("추정 −135,460원");
  });

  it("says 실현 when it came from fills", () => {
    const lines = renderStrategyReports([report({ realised: 3_000 })], false);
    expect(lines.join("\n")).toContain("실현 +3,000원");
  });

  it("shows no figure for a strategy that traded nothing", () => {
    const lines = renderStrategyReports([report({ realised: null })], true);
    expect(lines.join("\n")).not.toMatch(/추정|실현/);
  });
});

describe("condensing a strategy's last word", () => {
  it("tallies per-ticker states rather than listing them", () => {
    const reasoning = [
      "005930: inside the range",
      "000660: inside the range",
      "035720: has not come back to the line",
      "005380: opening range still forming",
    ].join("\n");

    const summary = summariseVerdict(reasoning);
    expect(summary).toContain("inside the range 2");
    expect(summary).toContain("has not come back to the line 1");
  });

  it("collapses variants that carry a reason after a dash", () => {
    const reasoning = [
      "005930: broke out without momentum — waiting for a retest",
      "000660: broke out without momentum — waiting for a retest",
    ].join("\n");
    expect(summariseVerdict(reasoning)).toBe("broke out without momentum 2");
  });

  it("collapses a parenthesised detail into its state", () => {
    const reasoning = [
      "005930: bars unavailable (KIS failed: rt_cd=1 초당 거래건수를 초과하였습니다)",
      "000660: bars unavailable (KIS failed: something else entirely)",
    ].join("\n");
    expect(summariseVerdict(reasoning)).toBe("bars unavailable 2");
  });

  it("keeps only the busiest few states", () => {
    const reasoning = Array.from({ length: 8 }, (_, i) => `00000${i}: state ${i}`).join("\n");
    expect(summariseVerdict(reasoning).split(" · ")).toHaveLength(4);
  });

  it("truncates prose rather than tallying it", () => {
    const prose = "There is no overnight sector read at all this morning, ".repeat(10);
    const summary = summariseVerdict(prose, 60);
    expect(summary).toHaveLength(61); // 60 plus the ellipsis
    expect(summary.endsWith("…")).toBe(true);
  });

  it("passes a failure through whole, because the detail is the point", () => {
    const failure = "Strategy failed: 400 credit balance is too low";
    expect(summariseVerdict(failure)).toBe(failure);
  });

  it("says so plainly when there is nothing to summarise", () => {
    expect(summariseVerdict("")).toBe("기록 없음");
  });
});
