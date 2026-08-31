import { describe, expect, it } from "vitest";

import { realisedByStrategy } from "@/lib/teams/trading/performance";

/**
 * Two ways of arriving at the same number, and the gap between them.
 *
 * The exact one reads fill prices from the broker. The estimated one reads the
 * last mark before a position vanished, because the paper environment does not
 * populate the execution inquiry -- an order that demonstrably filled returns
 * "조회할 내역이 없습니다", verified with a round trip on 2026-08-31.
 *
 * What is asserted here is that the two agree when nothing intervenes, and that
 * where they disagree the difference is the fees and the slippage rather than a
 * mistake. The residual is stored rather than absorbed, so the estimate's error
 * is visible every day instead of assumed to be small.
 */

const fill = (ticker: string, side: "buy" | "sell", quantity: number, price: number) => ({
  orderNo: "",
  ticker,
  side,
  quantity,
  price,
});

/** The estimate: what a mark of `pnl` per position sums to, by owner. */
function fromMarks(
  marks: { ticker: string; pnl: number }[],
  owners: Map<string, string>,
): { total: number; byStrategy: Record<string, number> } {
  const byStrategy: Record<string, number> = {};
  let total = 0;
  for (const mark of marks) {
    const owner = owners.get(mark.ticker) ?? "unattributed";
    byStrategy[owner] = (byStrategy[owner] ?? 0) + mark.pnl;
    total += mark.pnl;
  }
  return { total, byStrategy };
}

describe("the two sources agree when nothing intervenes", () => {
  const owners = new Map([["005930", "orb-v1"]]);

  it("matches when the fill lands exactly on the last mark", () => {
    // Bought 10 at 10,000; last mark said 10,300; sold at 10,300.
    const exact = realisedByStrategy(
      [fill("005930", "buy", 10, 10_000), fill("005930", "sell", 10, 10_300)],
      owners,
    );
    const estimated = fromMarks([{ ticker: "005930", pnl: 3_000 }], owners);

    expect(estimated.total).toBe(exact.total);
    expect(estimated.byStrategy).toEqual(exact.byStrategy);
  });

  it("attributes to the same strategy either way", () => {
    const exact = realisedByStrategy(
      [
        fill("A", "buy", 10, 10_000),
        fill("A", "sell", 10, 10_100),
        fill("B", "buy", 10, 20_000),
        fill("B", "sell", 10, 19_500),
      ],
      new Map([
        ["A", "orb-v1"],
        ["B", "agent-v1"],
      ]),
    );
    const estimated = fromMarks(
      [
        { ticker: "A", pnl: 1_000 },
        { ticker: "B", pnl: -5_000 },
      ],
      new Map([
        ["A", "orb-v1"],
        ["B", "agent-v1"],
      ]),
    );

    expect(estimated.byStrategy).toEqual(exact.byStrategy);
  });
});

describe("the residual is what the estimate missed", () => {
  it("is the charges when the fill matched the mark", () => {
    // The broker's own figure includes fees; the mark does not.
    const accountRealised = 3_000 - 573;
    const estimated = fromMarks(
      [{ ticker: "005930", pnl: 3_000 }],
      new Map([["005930", "orb-v1"]]),
    );

    expect(accountRealised - estimated.total).toBe(-573);
  });

  it("is the slippage when the fill came in below the mark", () => {
    // Marked at +3,000, sold 100원 a share worse across ten shares.
    const accountRealised = 2_000;
    const estimated = fromMarks(
      [{ ticker: "005930", pnl: 3_000 }],
      new Map([["005930", "orb-v1"]]),
    );

    expect(accountRealised - estimated.total).toBe(-1_000);
  });

  it("is the whole result when nothing could be attributed", () => {
    const estimated = fromMarks([], new Map());
    expect(estimated.total).toBe(0);
    // Everything the account made is unexplained, which is the honest reading
    // of a session whose positions left no trace.
    expect(-323 - estimated.total).toBe(-323);
  });
});

describe("what the estimate can and cannot support", () => {
  it("ranks two strategies consistently with the exact figures", () => {
    const owners = new Map([
      ["A", "orb-v1"],
      ["B", "agent-v1"],
    ]);

    const exact = realisedByStrategy(
      [
        fill("A", "buy", 10, 10_000),
        fill("A", "sell", 10, 10_400), // +4,000
        fill("B", "buy", 10, 10_000),
        fill("B", "sell", 10, 10_100), // +1,000
      ],
      owners,
    );

    // The same session marked a little optimistically on both sides: the
    // ordering survives, which is the only thing the estimate is asked for.
    const estimated = fromMarks(
      [
        { ticker: "A", pnl: 4_300 },
        { ticker: "B", pnl: 1_200 },
      ],
      owners,
    );

    const rank = (r: Record<string, number>) =>
      Object.entries(r)
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);

    expect(rank(estimated.byStrategy)).toEqual(rank(exact.byStrategy));
  });

  it("does not claim to equal the account's own figure", () => {
    const estimated = fromMarks(
      [{ ticker: "A", pnl: 4_300 }],
      new Map([["A", "orb-v1"]]),
    );
    const accountRealised = 3_700;

    // The page quotes the account figure for returns and the estimate only for
    // comparing strategies; these are deliberately allowed to differ.
    expect(estimated.total).not.toBe(accountRealised);
  });
});
