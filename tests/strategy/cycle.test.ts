import { describe, expect, it } from "vitest";

import { cycleDate, previousCycleDate, REPORT_HOUR_KST } from "@/lib/teams/strategy/cycle";

import { kst } from "../helpers/builders";

/**
 * Which day's idea a meeting belongs to.
 *
 * Not the calendar date. The department files at 17:00, so a meeting held at
 * 21:00 is already researching tomorrow's idea -- taking the calendar date
 * would attach those notes to a cycle that has been reported and closed.
 *
 * The department is stood down as of 2026-08-29, but the rule is load-bearing
 * whenever it comes back, and it is exactly the kind of off-by-one that is
 * invisible until a day's research lands on the wrong row.
 */

describe("the cycle a meeting belongs to", () => {
  it("is today for a meeting before the filing", () => {
    expect(cycleDate(kst("2026-08-31", "09:00"))).toBe("2026-08-31");
    expect(cycleDate(kst("2026-08-31", "13:00"))).toBe("2026-08-31");
  });

  it("is still today in the minute before the filing hour", () => {
    expect(cycleDate(kst("2026-08-31", `${REPORT_HOUR_KST - 1}:59`))).toBe("2026-08-31");
  });

  it("rolls to tomorrow from the filing hour onwards", () => {
    expect(cycleDate(kst("2026-08-31", `${REPORT_HOUR_KST}:00`))).toBe("2026-09-01");
    expect(cycleDate(kst("2026-08-31", "21:00"))).toBe("2026-09-01");
  });

  it("crosses a month boundary", () => {
    expect(cycleDate(kst("2026-08-31", "18:00"))).toBe("2026-09-01");
  });

  it("is computed in Seoul, not on the server clock", () => {
    // 23:00 UTC on the 30th is 08:00 KST on the 31st: before the filing, so
    // the 31st's cycle -- a UTC reading would say the 30th.
    expect(cycleDate(new Date("2026-08-30T23:00:00Z"))).toBe("2026-08-31");
  });
});

describe("the cycle before this one", () => {
  it("is the day before, for picking up the idea a reply refers to", () => {
    expect(previousCycleDate(kst("2026-08-31", "09:00"))).toBe("2026-08-30");
  });

  it("follows the same roll as the current cycle", () => {
    // After the filing the current cycle is 09-01, so the previous is 08-31.
    expect(previousCycleDate(kst("2026-08-31", "18:00"))).toBe("2026-08-31");
  });
});
