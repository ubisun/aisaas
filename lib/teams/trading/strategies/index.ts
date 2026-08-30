import type { Strategy } from "../types";

import { agentStrategy } from "./agent";

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
  { strategy: agentStrategy, priority: 100, live: true },
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
