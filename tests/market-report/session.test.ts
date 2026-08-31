import { describe, expect, it } from "vitest";

import { isStale, newYorkDate, sessionDate } from "@/lib/teams/market-report/session";

/**
 * Which US session a run is reporting on.
 *
 * The pipeline fires after the New York close, which is already the next
 * calendar day in Seoul, so the session date can never come from the server's
 * clock. Everything here is computed in America/New_York, which also absorbs
 * the daylight-saving shift without a hardcoded offset -- so the suite checks
 * both sides of it.
 */

describe("the New York date", () => {
  it("is the previous day when UTC has already rolled over", () => {
    // 02:00 UTC is 22:00 the evening before in New York.
    expect(newYorkDate(new Date("2026-08-29T02:00:00Z"))).toBe("2026-08-28");
  });

  it("is the same day during New York trading hours", () => {
    expect(newYorkDate(new Date("2026-08-28T18:00:00Z"))).toBe("2026-08-28");
  });

  it("holds across the daylight-saving change", () => {
    // Summer: UTC-4. 23:00 UTC is still the same day in New York.
    expect(newYorkDate(new Date("2026-07-15T23:00:00Z"))).toBe("2026-07-15");
    // Winter: UTC-5. 04:00 UTC is the previous evening.
    expect(newYorkDate(new Date("2026-01-15T04:00:00Z"))).toBe("2026-01-14");
  });
});

describe("the session being reported", () => {
  it("is the New York date when the job fires on a weekday evening", () => {
    // 22:00 UTC Friday is 18:00 Friday in New York.
    expect(sessionDate(new Date("2026-08-28T22:00:00Z"))).toBe("2026-08-28");
  });

  it("walks back to Friday when the job fires over a weekend", () => {
    // 22:00 UTC Saturday: no session that day, so Friday's is the one to report.
    expect(sessionDate(new Date("2026-08-29T22:00:00Z"))).toBe("2026-08-28");
    expect(sessionDate(new Date("2026-08-30T22:00:00Z"))).toBe("2026-08-28");
  });

  it("does not walk back on a Monday", () => {
    expect(sessionDate(new Date("2026-08-31T22:00:00Z"))).toBe("2026-08-31");
  });
});

describe("detecting a session that never happened", () => {
  it("calls a quote stale when its last trade predates the expected session", () => {
    // 2026-08-27 18:00 UTC, reported against the 28th.
    expect(isStale(Date.parse("2026-08-27T18:00:00Z") / 1000, "2026-08-28")).toBe(true);
  });

  it("accepts a quote from the expected session", () => {
    expect(isStale(Date.parse("2026-08-28T18:00:00Z") / 1000, "2026-08-28")).toBe(false);
  });

  it("proceeds rather than skipping when the provider sent no timestamp", () => {
    // A missing timestamp is "cannot tell", and a run is not abandoned on
    // incomplete evidence.
    expect(isStale(undefined, "2026-08-28")).toBe(false);
  });
});
