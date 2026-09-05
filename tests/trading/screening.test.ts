import { describe, expect, it } from "vitest";

import { selectFrom } from "@/lib/teams/trading/candidates";
import { TRADING_CONFIG } from "@/lib/teams/trading/config";
import { toRanked, type RankedStock } from "@/lib/teams/trading/kis";

/**
 * Choosing the shortlist.
 *
 * The screen looks for turnover large relative to a company's size, but the
 * endpoint that feeds it ranks by absolute traded value -- so the sourcing
 * contradicts the filter. Asking within price bands is the partial fix, and
 * these are the cases that decide whether the merging and filtering of six
 * separate answers is right.
 *
 * The size figures come from the ranking rather than from a quote per name.
 * That is checked here against arithmetic, because it is the claim the whole
 * change rests on.
 */

const { screening, limits } = TRADING_CONFIG;

const ranked = (over: Partial<RankedStock> = {}): RankedStock => ({
  ticker: "005930",
  name: "삼성전자",
  rank: 1,
  price: 10_000,
  changePct: 5,
  turnover: 50_000_000_000,
  volume: 1_000_000,
  sharesOutstanding: 10_000_000,
  marketCapEok: 1_000,
  turnoverToMarketCapPct: 50,
  ...over,
});

describe("reading a ranking row", () => {
  /** A real row, trimmed to the fields the screen uses. */
  const row = {
    hts_kor_isnm: "스카이랩스",
    mksc_shrn_iscd: "386380",
    data_rank: "1",
    stck_prpr: "23500",
    n_befr_clpr_vrss_prpr_rate: "135.00",
    acml_vol: "86928032",
    lstn_stcn: "18761977",
    acml_tr_pbmn: "1691342882935",
    tr_pbmn_tnrt: "383.61",
  };

  it("works out market capitalisation from price and shares", () => {
    // 18,761,977 shares at ₩23,500 is ₩440.9bn, or 4,409억.
    expect(Math.round(toRanked(row).marketCapEok)).toBe(4_409);
  });

  it("takes the ratio KIS already computed", () => {
    expect(toRanked(row).turnoverToMarketCapPct).toBeCloseTo(383.61, 2);
  });

  it("agrees with the ratio derived from its own figures", () => {
    // This is the claim that removed the per-ticker quote call: KIS's number
    // and the arithmetic behind it are the same number.
    const parsed = toRanked(row);
    const derived = (parsed.turnover / (parsed.marketCapEok * 100_000_000)) * 100;
    expect(derived).toBeCloseTo(parsed.turnoverToMarketCapPct, 1);
  });

  it("falls back to arithmetic when KIS omits its own ratio", () => {
    const parsed = toRanked({ ...row, tr_pbmn_tnrt: "0" });
    expect(parsed.turnoverToMarketCapPct).toBeCloseTo(383.6, 0);
  });

  it("does not divide by a market cap it could not work out", () => {
    const parsed = toRanked({ ...row, lstn_stcn: "0", tr_pbmn_tnrt: "0" });
    expect(parsed.turnoverToMarketCapPct).toBe(0);
    expect(parsed.marketCapEok).toBe(0);
  });
});

describe("merging six answers into one shortlist", () => {
  it("keeps a name once when it appears in several bands", () => {
    const picked = selectFrom([
      ranked({ ticker: "005930", turnover: 50_000_000_000 }),
      ranked({ ticker: "005930", turnover: 60_000_000_000 }),
    ]);
    expect(picked).toHaveLength(1);
  });

  it("keeps the reading that saw the most trading", () => {
    const picked = selectFrom([
      ranked({ ticker: "005930", turnover: 50_000_000_000 }),
      ranked({ ticker: "005930", turnover: 60_000_000_000 }),
    ]);
    expect(picked[0].turnover).toBe(60_000_000_000);
  });

  it("keeps names that differ", () => {
    const picked = selectFrom([ranked({ ticker: "A" }), ranked({ ticker: "B" })]);
    expect(picked.map((c) => c.ticker).sort()).toEqual(["A", "B"]);
  });

  it("ignores a row with no ticker", () => {
    expect(selectFrom([ranked({ ticker: "" })])).toHaveLength(0);
  });
});

describe("what gets through", () => {
  it("refuses a name traded too thinly to exit", () => {
    const thin = ranked({ turnover: screening.minTurnoverKrw - 1 });
    expect(selectFrom([thin])).toHaveLength(0);
  });

  it("accepts one exactly on the liquidity floor", () => {
    const atFloor = ranked({ turnover: screening.minTurnoverKrw });
    expect(selectFrom([atFloor])).toHaveLength(1);
  });

  it("refuses a large company ticking over on ordinary volume", () => {
    // The whole point of the screen: a blue chip's billions say nothing.
    const blueChip = ranked({
      turnover: 500_000_000_000,
      marketCapEok: 5_000_000,
      turnoverToMarketCapPct: screening.minTurnoverToMarketCapPct - 0.01,
    });
    expect(selectFrom([blueChip])).toHaveLength(0);
  });

  it("accepts a mid cap being repriced", () => {
    const repriced = ranked({
      turnover: 60_000_000_000,
      marketCapEok: 400,
      turnoverToMarketCapPct: 150,
    });
    expect(selectFrom([repriced])).toHaveLength(1);
  });

  it("refuses a row whose size could not be established", () => {
    expect(selectFrom([ranked({ marketCapEok: 0 })])).toHaveLength(0);
  });
});

describe("ordering and the cap", () => {
  it("puts the most repriced first, not the largest", () => {
    const picked = selectFrom([
      ranked({ ticker: "BIG", turnover: 900_000_000_000, turnoverToMarketCapPct: 2 }),
      ranked({ ticker: "SMALL", turnover: 6_000_000_000, turnoverToMarketCapPct: 90 }),
    ]);
    expect(picked.map((c) => c.ticker)).toEqual(["SMALL", "BIG"]);
  });

  it("never returns more than the cap", () => {
    const many = Array.from({ length: limits.maxCandidates + 20 }, (_, i) =>
      ranked({ ticker: `T${i}`, turnoverToMarketCapPct: 100 - i }),
    );
    expect(selectFrom(many)).toHaveLength(limits.maxCandidates);
  });

  it("drops the least repriced when it has to choose", () => {
    const many = Array.from({ length: limits.maxCandidates + 1 }, (_, i) =>
      ranked({ ticker: `T${i}`, turnoverToMarketCapPct: 100 - i }),
    );
    const picked = selectFrom(many);
    expect(picked.map((c) => c.ticker)).not.toContain(`T${limits.maxCandidates}`);
  });
});

describe("the pool is wide enough to be worth the filters", () => {
  it("asks each market for each price band", () => {
    // Six answers of thirty rows is the ceiling the endpoint imposes; asking
    // once per market returned sixty, of which the smallest name had already
    // traded sixteen times the liquidity floor.
    const asks = screening.markets.length * screening.priceBands.length;
    expect(asks).toBeGreaterThanOrEqual(6);
    expect(asks * screening.rankPoolSize).toBeGreaterThanOrEqual(limits.maxCandidates * 3);
  });

  it("starts its lowest band at the price floor, not below it", () => {
    // Below ₩2,000 a 2% stop sits inside the tick spread, so the exit rules
    // stop meaning what they say.
    expect(screening.priceBands[0][0]).toBeGreaterThanOrEqual(screening.minPriceKrw);
  });

  it("covers the price axis without a gap", () => {
    const bands = screening.priceBands;
    for (let i = 1; i < bands.length; i += 1) {
      expect(bands[i][0]).toBe(bands[i - 1][1]);
    }
    expect(bands[bands.length - 1][1]).toBeNull();
  });
});
