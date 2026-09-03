import { describe, expect, it } from "vitest";

import { TRADING_CONFIG } from "@/lib/teams/trading/config";
import { exitsDueNow, nextStep } from "@/lib/teams/trading/watch";

import { kst, position } from "../helpers/builders";

/**
 * What the watcher owes on its positions, case by case.
 *
 * The watcher exists because a stop checked every five minutes is not a stop.
 * The cooldown exists because two things now generate exits from the same
 * positions. Between them sits the case that matters most and had no test: a
 * profit ladder whose second rung falls inside the cooldown of its first.
 *
 * Everything here is the decision, not the loop -- what to sell and when to
 * hold off. The loop's own endings are at the bottom.
 */

const { exits: rules, watch } = TRADING_CONFIG;
const AT = kst("2026-09-04", "10:00");

const soldAt = (secondsAgo: number, over: Record<string, unknown> = {}) => ({
  ticker: "005930",
  side: "sell",
  status: "submitted",
  created_at: new Date(AT.getTime() - secondsAgo * 1000).toISOString(),
  ...over,
});

describe("a stop is honoured the moment it is seen", () => {
  it("sells everything held once the loss reaches the stop", () => {
    const { due } = exitsDueNow([position({ pnlPct: rules.stopLossPct })], [], AT);
    expect(due).toHaveLength(1);
    expect(due[0].quantity).toBe(10);
    expect(due[0].reason).toMatch(/Stop loss/);
  });

  it("sells everything when the price gapped well past the stop", () => {
    // The case that prompted the watcher: -1.55% at one look, -5.21% at the
    // next. Whatever it has reached, the whole position goes.
    const { due } = exitsDueNow([position({ pnlPct: -5.21 })], [], AT);
    expect(due[0].quantity).toBe(10);
  });

  it("does nothing a hair above the stop", () => {
    const { due } = exitsDueNow([position({ pnlPct: rules.stopLossPct + 0.01 })], [], AT);
    expect(due).toHaveLength(0);
  });

  it("uses the strategy's own stop when the entry carried one", () => {
    const held = position({ currentPrice: 9_800, stopLoss: 9_900, takeProfit: 10_400, pnlPct: -2 });
    const { due } = exitsDueNow([held], [], AT);
    expect(due[0].reason).toMatch(/Stop at/);
  });
});

describe("the profit ladder survives the cooldown", () => {
  /** Half sold at the first rung; five left, now worth the second. */
  const afterFirstRung = position({
    quantity: 5,
    sellableQuantity: 5,
    boughtQuantity: 10,
    pnlPct: 5,
  });

  it("takes the second rung once the cooldown has passed", () => {
    const { due, heldBack } = exitsDueNow(
      [afterFirstRung],
      [soldAt(watch.exitCooldownSeconds + 5)],
      AT,
    );
    expect(heldBack).toHaveLength(0);
    expect(due).toHaveLength(1);
    expect(due[0].quantity).toBe(5);
  });

  it("holds it back inside the cooldown, but says so", () => {
    const { due, heldBack } = exitsDueNow([afterFirstRung], [soldAt(5)], AT);
    expect(due).toHaveLength(0);
    expect(heldBack).toHaveLength(1);
    expect(heldBack[0].soldSecondsAgo).toBe(5);
    expect(heldBack[0].order.reason).toMatch(/Take profit/);
  });

  it("delays the second rung by at most one poll after the window", () => {
    // The cooldown must not outlast a poll by much, or a rung that came due
    // inside it waits noticeably. This is the property that was violated when
    // the window was sixty seconds.
    expect(watch.exitCooldownSeconds).toBeLessThanOrEqual(watch.intervalSeconds * 2);
  });

  it("takes the first rung with nothing sold yet", () => {
    const { due } = exitsDueNow([position({ pnlPct: rules.ladder[0].atPct })], [], AT);
    expect(due[0].quantity).toBe(5);
  });

  it("closes a remainder that gave back what the first rung proved", () => {
    const stalled = position({
      quantity: 5,
      sellableQuantity: 5,
      boughtQuantity: 10,
      pnlPct: rules.giveBackPct,
    });
    const { due } = exitsDueNow([stalled], [soldAt(120)], AT);
    expect(due[0].reason).toMatch(/Gave back/);
  });
});

describe("what the cooldown does and does not hold back", () => {
  it("holds back a repeat of a sale still settling", () => {
    const { due } = exitsDueNow([position({ pnlPct: -3 })], [soldAt(5)], AT);
    expect(due).toHaveLength(0);
  });

  it("releases it once the broker has had time to update", () => {
    const { due } = exitsDueNow(
      [position({ pnlPct: -3 })],
      [soldAt(watch.exitCooldownSeconds + 1)],
      AT,
    );
    expect(due).toHaveLength(1);
  });

  it("ignores a sale that was refused — nothing was sold", () => {
    const { due } = exitsDueNow(
      [position({ pnlPct: -3 })],
      [soldAt(5, { status: "rejected" })],
      AT,
    );
    expect(due).toHaveLength(1);
  });

  it("does not let one name's sale hold back another's stop", () => {
    const { due } = exitsDueNow(
      [position({ ticker: "005930", pnlPct: -3 }), position({ ticker: "000660", pnlPct: -3 })],
      [soldAt(5, { ticker: "005930" })],
      AT,
    );
    expect(due.map((o) => o.ticker)).toEqual(["000660"]);
  });

  it("never holds back the close-of-session flatten for long", () => {
    // Even at the flatten the cooldown applies -- but the close job runs after
    // the window and the watcher has stopped by then, so the tick retries.
    const at = kst("2026-09-04", "15:20");
    const { due } = exitsDueNow([position()], [], at);
    expect(due[0].reason).toMatch(/flattening/);
  });
});

describe("a position that will not clear", () => {
  it("is offered again on the next poll after the cooldown", () => {
    // A sale that was submitted but never filled leaves the position held. The
    // watcher must keep trying rather than treat it as done.
    const held = position({ pnlPct: -3 });
    const inside = exitsDueNow([held], [soldAt(5)], AT);
    const outside = exitsDueNow([held], [soldAt(watch.exitCooldownSeconds + 1)], AT);

    expect(inside.due).toHaveLength(0);
    expect(outside.due).toHaveLength(1);
  });
});

describe("how the loop ends", () => {
  const base = { generation: 0, now: 1_000, deadline: 10_000, holdings: 1, closed: false };

  it("keeps polling while something is held and time remains", () => {
    expect(nextStep(base)).toBe("poll");
  });

  it("stops when the desk is flat", () => {
    expect(nextStep({ ...base, holdings: 0 })).toBe("flat");
  });

  it("stops when the session closes, leaving the flatten to the close job", () => {
    expect(nextStep({ ...base, closed: true })).toBe("closed");
  });

  it("hands on when its time is up", () => {
    expect(nextStep({ ...base, now: 10_000 })).toBe("handed-on");
  });

  it("stops at the generation cap before anything else", () => {
    // Checked first on purpose: a runaway chain must stop even when every other
    // signal says carry on.
    expect(
      nextStep({ ...base, generation: watch.maxGenerations, holdings: 5, closed: false }),
    ).toBe("generations");
  });

  it("prefers closing to handing on, so the chain does not outlive the day", () => {
    expect(nextStep({ ...base, now: 10_000, closed: true })).toBe("closed");
  });
});

describe("timings taken from what actually happened", () => {
  /**
   * Absolute seconds on purpose. The scenarios above express their timings
   * relative to the configured cooldown, so they move with it and cannot catch
   * a badly chosen value. These are the intervals a real session produced, and
   * they fail if the window grows back.
   */

  it("takes a second rung 25 seconds after the first", () => {
    // A fast move clearing +3% and then +5% inside half a minute. At the 60s
    // window this file was written against, this rung vanished in silence.
    const afterFirstRung = position({
      quantity: 5,
      sellableQuantity: 5,
      boughtQuantity: 10,
      pnlPct: 5,
    });

    const { due, heldBack } = exitsDueNow([afterFirstRung], [soldAt(25)], AT);
    expect(heldBack).toHaveLength(0);
    expect(due).toHaveLength(1);
  });

  it("retries a stop 30 seconds after a sale that did not clear", () => {
    const { due } = exitsDueNow([position({ pnlPct: -3 })], [soldAt(30)], AT);
    expect(due).toHaveLength(1);
  });

  it("still holds back a repeat 5 seconds later", () => {
    // The window has to be wide enough to cover the broker's own lag, or the
    // guard does nothing at all.
    const { due } = exitsDueNow([position({ pnlPct: -3 })], [soldAt(5)], AT);
    expect(due).toHaveLength(0);
  });

  it("would have caught the 2026-09-03 stop within one poll of it crossing", () => {
    // The position read -1.55% at 09:16:04 and -5.21% at 09:20:12: 248 seconds
    // apart, with the -2% line crossed somewhere between. At this interval the
    // gap is looked at many times over, so the exit is raised on the first look
    // after the crossing rather than four minutes later.
    const observedGapSeconds = 248;
    const looks = Math.floor(observedGapSeconds / watch.intervalSeconds);
    expect(looks).toBeGreaterThanOrEqual(16);

    // And crossing is all it takes -- there is no confirmation, no second look.
    const { due } = exitsDueNow([position({ pnlPct: -2.01 })], [], AT);
    expect(due).toHaveLength(1);
  });
});
