import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The lock on the live account.
 *
 * `kis.ts` refuses to assemble credentials at all when the environment is
 * "real". That is the difference between a simulated fill and one that spends
 * money, and it is the single assertion in this repository whose failure would
 * matter most -- so it is checked rather than trusted.
 *
 * The config is replaced per test rather than mutated, because the module under
 * test reads it through a function on every call. A test that flipped a shared
 * constant would leak into whatever ran next.
 */

async function kisWith(environment: "demo" | "real") {
  vi.resetModules();
  const actual = await vi.importActual<typeof import("@/lib/teams/trading/config")>(
    "@/lib/teams/trading/config",
  );

  vi.doMock("@/lib/teams/trading/config", () => ({
    ...actual,
    TRADING_CONFIG: { ...actual.TRADING_CONFIG, environment },
  }));

  // The admin client is only reached after credentials succeed; stubbing it
  // keeps the failure that does happen attributable to the lock.
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: () => {
      throw new Error("reached the database, which means the lock did not hold");
    },
  }));

  return import("@/lib/teams/trading/kis");
}

afterEach(() => {
  vi.doUnmock("@/lib/teams/trading/config");
  vi.doUnmock("@/lib/supabase/admin");
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("with the environment set to real", () => {
  it("refuses to place an order", async () => {
    const kis = await kisWith("real");
    await expect(
      kis.placeOrder({ ticker: "005930", side: "buy", quantity: 1 }),
    ).rejects.toThrow(/Live trading is not enabled/);
  });

  it("refuses to read the balance", async () => {
    const kis = await kisWith("real");
    await expect(kis.fetchHoldings()).rejects.toThrow(/Live trading is not enabled/);
  });

  it("refuses to read a quote", async () => {
    const kis = await kisWith("real");
    await expect(kis.fetchQuote("005930")).rejects.toThrow(/Live trading is not enabled/);
  });

  it("refuses to cancel", async () => {
    const kis = await kisWith("real");
    // cancelOrder reports rather than throws, so the refusal arrives as a
    // failed result -- what matters is that nothing was sent.
    const result = await kis.cancelOrder({ orderNo: "1", ticker: "005930", quantity: 1 });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Live trading is not enabled/);
  });

  it("refuses before reading any credential from the environment", async () => {
    // Even with live-looking credentials present, the refusal comes first.
    vi.stubEnv("KIS_PAPER_APP_KEY", "key");
    vi.stubEnv("KIS_PAPER_APP_SECRET", "secret");
    vi.stubEnv("KIS_PAPER_ACCOUNT_NO", "00000000");

    const kis = await kisWith("real");
    await expect(kis.fetchQuote("005930")).rejects.toThrow(/Live trading is not enabled/);
  });
});

describe("with the environment set to demo", () => {
  it("gets past the lock and fails on the missing credentials instead", async () => {
    vi.stubEnv("KIS_PAPER_APP_KEY", "");
    vi.stubEnv("KIS_PAPER_APP_SECRET", "");
    vi.stubEnv("KIS_PAPER_ACCOUNT_NO", "");

    const kis = await kisWith("demo");
    await expect(kis.fetchQuote("005930")).rejects.toThrow(/KIS_PAPER_APP_KEY/);
  });
});

describe("the shipped configuration", () => {
  it("is demo", async () => {
    const { TRADING_CONFIG } = await import("@/lib/teams/trading/config");
    // Promoting to a live account is a deliberate, reviewed change. This test
    // failing is the review asking to happen.
    expect(TRADING_CONFIG.environment).toBe("demo");
  });
});
