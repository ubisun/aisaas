import { describe, expect, it } from "vitest";

import { TRADING_CONFIG } from "@/lib/teams/trading/config";
import { screenEntries } from "@/lib/teams/trading/risk";

import { candidate, entryGate, kst, order, position, tickContext } from "../helpers/builders";

/**
 * The entry gate.
 *
 * This is the file to read first. Everything here is a promise the desk makes
 * about money it is about to spend, and each test is one of them named out
 * loud. A strategy is allowed to want anything; these are the reasons it does
 * not get it.
 *
 * A rejected proposal is recorded with its reason rather than clamped into
 * something acceptable, so every case below also asserts *why* -- a gate that
 * refuses for the wrong reason is a gate whose next change will be wrong too.
 */

const { limits } = TRADING_CONFIG;
const DURING = kst("2026-08-31", "09:35");

const allowed = (verdicts: ReturnType<typeof screenEntries>) =>
  verdicts.filter((v) => v.allowed);
const reasons = (verdicts: ReturnType<typeof screenEntries>) =>
  verdicts.filter((v) => !v.allowed).map((v) => (v as { reason: string }).reason);

describe("entry gate — the window", () => {
  it("lets a well-formed buy through while entries are open", () => {
    const verdicts = screenEntries(entryGate());
    expect(allowed(verdicts)).toHaveLength(1);
  });

  it("refuses before the session opens", () => {
    const verdicts = screenEntries({ ...entryGate(), at: kst("2026-08-31", "08:45") });
    expect(allowed(verdicts)).toHaveLength(0);
    expect(reasons(verdicts)[0]).toMatch(/Outside the window/);
  });

  it("refuses after the entry deadline, while the desk is still holding", () => {
    const verdicts = screenEntries({ ...entryGate(), at: kst("2026-08-31", "11:31") });
    expect(allowed(verdicts)).toHaveLength(0);
    expect(reasons(verdicts)[0]).toMatch(/entries are closed/i);
  });

  it("refuses after the flatten", () => {
    const verdicts = screenEntries({ ...entryGate(), at: kst("2026-08-31", "15:20") });
    expect(allowed(verdicts)).toHaveLength(0);
  });
});

describe("entry gate — budgets", () => {
  it("refuses once the entry budget is spent", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      context: tickContext({ entriesUsed: limits.maxEntriesPerDay }),
    });
    expect(reasons(verdicts)[0]).toMatch(/Entry budget spent/);
  });

  it("counts allowances within one batch, so several at once cannot slip past", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      context: tickContext({
        candidates: [
          candidate({ ticker: "000001" }),
          candidate({ ticker: "000002" }),
          candidate({ ticker: "000003" }),
        ],
      }),
      proposals: [
        order({ ticker: "000001", quantity: 1 }),
        order({ ticker: "000002", quantity: 1 }),
        order({ ticker: "000003", quantity: 1 }),
      ],
    });

    expect(allowed(verdicts)).toHaveLength(limits.maxEntriesPerDay);
    expect(reasons(verdicts)).toContainEqual(expect.stringMatching(/Entry budget spent/));
  });

  it("refuses an order worth more than the per-order ceiling", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      context: tickContext({ maxOrderValueKrw: 1_000_000 }),
      // 10,000원 × 200주 = 2,000,000원
      proposals: [order({ quantity: 200 })],
    });
    expect(reasons(verdicts)[0]).toMatch(/exceeds the/);
  });

  it("prices the order from the limit price when one is given", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      context: tickContext({ maxOrderValueKrw: 1_000_000 }),
      proposals: [order({ quantity: 50, limitPrice: 30_000 })],
    });
    expect(reasons(verdicts)[0]).toMatch(/exceeds the/);
  });

  it("refuses when the daily order cap is reached", () => {
    const verdicts = screenEntries({ ...entryGate(), ordersSoFar: limits.maxOrdersPerDay });
    expect(reasons(verdicts)[0]).toMatch(/order cap/);
  });
});

describe("entry gate — loss limits", () => {
  it("stops a strategy that has lost its own limit", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      strategyLossPct: limits.strategyLossLimitPct,
    });
    expect(reasons(verdicts)[0]).toMatch(/Strategy loss limit/);
  });

  it("stops every strategy when the account limit is reached", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      accountLossPct: limits.dailyLossLimitPct,
    });
    expect(reasons(verdicts)[0]).toMatch(/Account loss limit/);
  });

  it("leaves a strategy alone while it is inside both limits", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      strategyLossPct: limits.strategyLossLimitPct - 0.01,
      accountLossPct: limits.dailyLossLimitPct - 0.01,
    });
    expect(allowed(verdicts)).toHaveLength(1);
  });
});

describe("entry gate — what may be bought", () => {
  it("refuses a ticker that is not on the shortlist", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      proposals: [order({ ticker: "999999" })],
    });
    expect(reasons(verdicts)[0]).toMatch(/not a candidate/);
  });

  it("refuses a ticker another strategy has already bought", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      claimedByOthers: new Set(["005930"]),
    });
    expect(reasons(verdicts)[0]).toMatch(/already bought by another strategy/);
  });

  it("refuses a second buy of a name it already holds", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      context: tickContext({ positions: [position({ ticker: "005930" })] }),
    });
    expect(reasons(verdicts)[0]).toMatch(/already been bought today/);
  });

  it("refuses the same ticker twice inside one batch", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      proposals: [order({ quantity: 1 }), order({ quantity: 1 })],
    });
    expect(allowed(verdicts)).toHaveLength(1);
    expect(reasons(verdicts)[0]).toMatch(/already been bought today/);
  });

  it("refuses a sell — exits are not a strategy's to propose", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      proposals: [order({ side: "sell" })],
    });
    expect(reasons(verdicts)[0]).toMatch(/may not propose sells/);
  });
});

describe("entry gate — malformed proposals", () => {
  it.each([
    ["a fraction", 1.5],
    ["zero", 0],
    ["a negative", -5],
  ])("refuses %s quantity", (_label, quantity) => {
    const verdicts = screenEntries({ ...entryGate(), proposals: [order({ quantity })] });
    expect(reasons(verdicts)[0]).toMatch(/positive whole number/);
  });

  it("refuses when no usable price can be found", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      context: tickContext({ candidates: [candidate({ price: 0 })] }),
    });
    expect(reasons(verdicts)[0]).toMatch(/No usable price/);
  });
});

describe("entry gate — the deadline is a hard edge", () => {
  it("allows an entry in the last minute before the deadline", () => {
    const verdicts = screenEntries({ ...entryGate(), at: kst("2026-08-31", "11:29") });
    expect(allowed(verdicts)).toHaveLength(1);
  });

  it("refuses on the deadline itself", () => {
    const verdicts = screenEntries({ ...entryGate(), at: kst("2026-08-31", "11:30") });
    expect(allowed(verdicts)).toHaveLength(0);
  });

  it("allows an entry the minute the session opens", () => {
    const verdicts = screenEntries({ ...entryGate(), at: kst("2026-08-31", "09:10") });
    expect(allowed(verdicts)).toHaveLength(1);
  });

  it("refuses the minute before the session opens", () => {
    const verdicts = screenEntries({ ...entryGate(), at: kst("2026-08-31", "09:09") });
    expect(allowed(verdicts)).toHaveLength(0);
  });
});

describe("entry gate — the reason survives", () => {
  it("keeps the strategy's own reason on the order it refused", () => {
    const verdicts = screenEntries({
      ...entryGate(),
      proposals: [order({ ticker: "999999", reason: "breakout on volume" })],
      at: DURING,
    });
    expect(verdicts[0].order.reason).toBe("breakout on volume");
  });
});
