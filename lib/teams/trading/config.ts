/**
 * Every limit the trading side obeys, in one place.
 *
 * These are code, not prompt. A strategy -- including the model-driven one --
 * can propose whatever it likes; nothing here is negotiable at runtime, and
 * changing a limit means changing this file and shipping it.
 *
 * Values are deliberate starting points for the paper account, sized so a
 * broken strategy is cheap. Tune them once there is enough recorded history to
 * argue from.
 */
export const TRADING_CONFIG = {
  /**
   * Which Korea Investment environment orders may reach. Only ever flip this
   * as a deliberate, reviewed change -- it is the difference between a
   * simulated fill and a real one.
   */
  environment: "demo" as "demo" | "real",

  /** Asia/Seoul wall-clock bounds of the trading window, inclusive of start. */
  window: {
    /** No order may be submitted before this. */
    openHour: 9,
    openMinute: 10,
    /** No new position may be opened at or after this. */
    lastEntryHour: 10,
    lastEntryMinute: 15,
    /** Everything still held is flattened at this time. */
    closeHour: 10,
    closeMinute: 30,
  },

  limits: {
    /** Notional cap for a single order, in KRW. */
    maxOrderValueKrw: 1_000_000,
    /** Distinct tickers that may be held at once. */
    maxConcurrentPositions: 3,
    /** Ceiling on submitted orders per trading day, both sides counted. */
    maxOrdersPerDay: 20,
    /** Candidates the strategy is allowed to consider. */
    maxCandidates: 8,
    /**
     * Session is halted when the day's realised plus unrealised loss reaches
     * this fraction of starting equity. Expressed positive.
     */
    dailyLossLimitPct: 3,
    /** Per-position stop, as a fraction of entry price. */
    stopLossPct: 2,
    /** Per-position target. */
    takeProfitPct: 3,
  },

  /** How often the window is evaluated, in minutes. */
  tickIntervalMinutes: 5,
} as const;

export type TradingConfig = typeof TRADING_CONFIG;
