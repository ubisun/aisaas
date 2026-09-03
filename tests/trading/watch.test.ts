import { describe, expect, it } from "vitest";

import { TRADING_CONFIG } from "@/lib/teams/trading/config";
import { recentlyExited, watcherIsAlive } from "@/lib/teams/trading/watch";

/**
 * The two guards that keep a watcher from becoming a second problem.
 *
 * It exists because a stop checked every five minutes is not a stop -- on
 * 2026-09-03 a position read -1.55% at 09:16 and -5.21% at 09:20. But a second
 * thing looking at the same positions is also a second thing able to sell them,
 * and a chain that re-queues itself is a chain that can run forever. These are
 * the checks that stop both.
 */

const { watch } = TRADING_CONFIG;
const NOW = Date.parse("2026-09-04T01:00:00Z");

const sell = (over: Record<string, unknown> = {}) => ({
  ticker: "005930",
  side: "sell",
  status: "submitted",
  created_at: new Date(NOW - 5_000).toISOString(),
  ...over,
});

describe("a name just sold is left alone", () => {
  it("is named when the sale was inside the cooldown", () => {
    expect(recentlyExited([sell()], NOW).has("005930")).toBe(true);
  });

  it("is released once the cooldown has passed", () => {
    const old = sell({
      created_at: new Date(NOW - (watch.exitCooldownSeconds + 1) * 1000).toISOString(),
    });
    expect(recentlyExited([old], NOW).has("005930")).toBe(false);
  });

  it("counts a filled sale as well as a submitted one", () => {
    expect(recentlyExited([sell({ status: "filled" })], NOW).has("005930")).toBe(true);
  });

  it("ignores a sale that was rejected — nothing was sold", () => {
    expect(recentlyExited([sell({ status: "rejected" })], NOW).size).toBe(0);
  });

  it("ignores a buy, however recent", () => {
    expect(recentlyExited([sell({ side: "buy" })], NOW).size).toBe(0);
  });

  it("ignores a row with no timestamp rather than guessing it is recent", () => {
    expect(recentlyExited([sell({ created_at: undefined })], NOW).size).toBe(0);
  });

  it("holds several names at once", () => {
    const cooling = recentlyExited(
      [sell({ ticker: "005930" }), sell({ ticker: "000660" })],
      NOW,
    );
    expect([...cooling].sort()).toEqual(["000660", "005930"]);
  });
});

describe("deciding whether a watcher is already minding the desk", () => {
  it("is alive on a fresh heartbeat", () => {
    expect(watcherIsAlive({ watcherHeartbeat: new Date().toISOString() })).toBe(true);
  });

  it("is dead once the heartbeat goes stale, so a tick may replace it", () => {
    const stale = new Date(Date.now() - (watch.staleHeartbeatSeconds + 10) * 1000);
    expect(watcherIsAlive({ watcherHeartbeat: stale.toISOString() })).toBe(false);
  });

  it("is dead when nothing has ever beaten", () => {
    expect(watcherIsAlive({})).toBe(false);
    expect(watcherIsAlive(null)).toBe(false);
  });

  it("is dead when the heartbeat is not a timestamp", () => {
    expect(watcherIsAlive({ watcherHeartbeat: 12345 })).toBe(false);
  });
});

describe("the chain cannot outlive the day", () => {
  it("covers a full session several times over before the cap", () => {
    const sessionSeconds =
      (TRADING_CONFIG.window.closeHour * 60 + TRADING_CONFIG.window.closeMinute) * 60 -
      (TRADING_CONFIG.window.openHour * 60 + TRADING_CONFIG.window.openMinute) * 60;

    expect(watch.maxGenerations * watch.invocationSeconds).toBeGreaterThan(sessionSeconds);
  });

  it("polls many times within one invocation", () => {
    // The point of the chain is that the hand-off is rare and the looking is
    // frequent; a ratio near one would mean a queue message per poll.
    expect(watch.invocationSeconds / watch.intervalSeconds).toBeGreaterThanOrEqual(10);
  });

  it("hands on before the function ceiling", () => {
    // The worker declares maxDuration 300; the loop must finish inside it with
    // room for a poll and the hand-off.
    expect(watch.invocationSeconds).toBeLessThan(300);
  });

  it("waits longer than one poll before replacing a watcher", () => {
    // Otherwise a tick would start a second watcher while the first was simply
    // between polls.
    expect(watch.staleHeartbeatSeconds).toBeGreaterThan(watch.intervalSeconds);
  });
});
