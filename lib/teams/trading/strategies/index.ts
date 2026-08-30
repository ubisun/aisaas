import type { Strategy } from "../types";

import { agentStrategy } from "./agent";
import { orbStrategy } from "./orb";

/**
 * Who is trading today.
 *
 * Strategies run side by side against the same shortlist. Each gets an equal
 * share of the day's capital and its own entry budget, and each records its own
 * tick row, so two strategies can be compared on the same morning rather than
 * on two different ones.
 */

export type RegisteredStrategy = {
  strategy: Strategy;
  /**
   * Higher wins when two strategies ask for the same ticker in one tick.
   *
   * Configuration rather than array order, because array order is an accident
   * of how the file was edited and this is a decision. Ties are broken by name
   * so the outcome never depends on ordering.
   */
  priority: number;
  /**
   * Live strategies place real orders and count toward the capital divisor.
   *
   * A strategy that is not live still runs and still records what it would
   * have done -- which is the cheap way to judge a new idea against a morning
   * that actually happened, without giving it money first.
   */
  live: boolean;
};

export const REGISTRY: RegisteredStrategy[] = [
  /**
   * Ranked above the discretionary desk on purpose. Its entries are tied to a
   * specific bar -- a confirmation candle at the range line happens once and is
   * gone -- whereas a model reading a shortlist can simply pick another name.
   * Losing a ticker costs it the trade; losing one costs the other a choice.
   */
  //
  // Both shadow as of 2026-08-30. The multi-strategy dispatch, the ticker
  // claim and the opening-range state machine have all type-checked and none
  // of them has ever run. A shadow session exercises every one of those paths
  // and records what each strategy would have done, without an order being the
  // thing that discovers the bug.
  //
  // Promote by flipping `live` once a session's tick records read correctly.
  { strategy: orbStrategy, priority: 110, live: false },
  { strategy: agentStrategy, priority: 100, live: false },
];

/** Live strategies, highest priority first. */
export function liveStrategies(): RegisteredStrategy[] {
  return REGISTRY.filter((r) => r.live).sort(
    (a, b) => b.priority - a.priority || a.strategy.name.localeCompare(b.strategy.name),
  );
}

/** Everything that runs this tick, live or shadow, highest priority first. */
export function activeStrategies(): RegisteredStrategy[] {
  return [...REGISTRY].sort(
    (a, b) => b.priority - a.priority || a.strategy.name.localeCompare(b.strategy.name),
  );
}
