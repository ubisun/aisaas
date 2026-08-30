import { TRADING_CONFIG } from "./config";
import type { Position, ProposedOrder, TickContext, Verdict } from "./types";

/**
 * The gate between a strategy's opinion and a real order.
 *
 * Everything here is a hard invariant. A proposal that fails any check is not
 * clamped or corrected -- it is rejected with a reason and recorded, because a
 * strategy that keeps asking for things it cannot have is itself the finding.
 */

const seoulTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Minutes since midnight in Seoul. */
export function seoulMinutes(at: Date = new Date()): number {
  const [hour, minute] = seoulTime.format(at).split(":").map(Number);
  return hour * 60 + minute;
}

export function seoulClock(at: Date = new Date()): string {
  return seoulTime.format(at);
}

const { window: w, limits, exits } = TRADING_CONFIG;
const OPEN = w.openHour * 60 + w.openMinute;
const LAST_ENTRY = w.lastEntryHour * 60 + w.lastEntryMinute;
const CLOSE = w.closeHour * 60 + w.closeMinute;

export type WindowState = "before" | "entries-open" | "exits-only" | "closed";

export function windowState(at: Date = new Date()): WindowState {
  const now = seoulMinutes(at);
  if (now < OPEN) return "before";
  if (now < LAST_ENTRY) return "entries-open";
  if (now < CLOSE) return "exits-only";
  return "closed";
}

export function minutesToLastEntry(at: Date = new Date()): number {
  return Math.max(0, LAST_ENTRY - seoulMinutes(at));
}

export type EntryGateInput = {
  /** Scoped to the proposing strategy: its candidates, positions and budget. */
  context: TickContext;
  proposals: ProposedOrder[];
  /** The strategy's own loss, as a positive percent of its allocated budget. */
  strategyLossPct: number;
  /** Account-wide loss, as a positive percent of the day's capital. */
  accountLossPct: number;
  /** Tickers another strategy has already bought today. */
  claimedByOthers: Set<string>;
  /** Strategy-proposed orders submitted account-wide so far today. */
  ordersSoFar: number;
  at?: Date;
};

/**
 * Screen a strategy's entries.
 *
 * Order matters: earlier allowances count against the budgets seen by later
 * ones, so a strategy cannot slip past its entry cap by proposing several at
 * once.
 */
export function screenEntries({
  context,
  proposals,
  strategyLossPct,
  accountLossPct,
  claimedByOthers,
  ordersSoFar,
  at = new Date(),
}: EntryGateInput): Verdict[] {
  const state = windowState(at);
  const verdicts: Verdict[] = [];

  let entries = context.entriesUsed;
  let submitted = ordersSoFar;
  const tradeable = new Set(context.candidates.map((c) => c.ticker));
  // Grows as this batch is allowed, so one tick cannot buy the same name twice.
  const takenThisTick = new Set<string>();
  const ownedToday = new Set(context.positions.map((p) => p.ticker));

  const deny = (order: ProposedOrder, reason: string) =>
    verdicts.push({ allowed: false, order, reason });

  for (const order of proposals) {
    if (order.side !== "buy") {
      deny(order, "Strategies may not propose sells; exits are the risk gate's business");
      continue;
    }
    if (state === "before") {
      deny(
        order,
        `Outside the window: trading opens at ${w.openHour}:${String(w.openMinute).padStart(2, "0")} KST`,
      );
      continue;
    }
    if (state !== "entries-open") {
      deny(order, "New entries are closed");
      continue;
    }
    if (accountLossPct >= limits.dailyLossLimitPct) {
      deny(
        order,
        `Account loss limit reached (${accountLossPct.toFixed(2)}% >= ${limits.dailyLossLimitPct}% of capital)`,
      );
      continue;
    }
    if (strategyLossPct >= limits.strategyLossLimitPct) {
      deny(
        order,
        `Strategy loss limit reached (${strategyLossPct.toFixed(2)}% >= ${limits.strategyLossLimitPct}% of its budget)`,
      );
      continue;
    }
    if (submitted >= limits.maxOrdersPerDay) {
      deny(order, `Daily order cap reached (${limits.maxOrdersPerDay})`);
      continue;
    }
    if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
      deny(order, `Quantity must be a positive whole number, got ${order.quantity}`);
      continue;
    }
    if (entries >= limits.maxEntriesPerDay) {
      deny(order, `Entry budget spent (${limits.maxEntriesPerDay} for the day)`);
      continue;
    }
    if (claimedByOthers.has(order.ticker)) {
      deny(order, `${order.ticker} was already bought by another strategy today`);
      continue;
    }
    // One buy per ticker per day, so the day's holding of a name maps to
    // exactly one order -- which is what makes fills readable from the balance
    // and profit attributable to a single strategy.
    if (ownedToday.has(order.ticker) || takenThisTick.has(order.ticker)) {
      deny(order, `${order.ticker} has already been bought today; no re-entry`);
      continue;
    }
    if (!tradeable.has(order.ticker)) {
      deny(order, `${order.ticker} is not a candidate for this session`);
      continue;
    }

    const candidate = context.candidates.find((c) => c.ticker === order.ticker);
    const reference = order.limitPrice ?? candidate?.price;
    if (!reference || reference <= 0) {
      deny(order, `No usable price for ${order.ticker}`);
      continue;
    }

    const notional = reference * order.quantity;
    if (notional > context.maxOrderValueKrw) {
      deny(
        order,
        `Order value ${Math.round(notional).toLocaleString()} KRW exceeds the ${context.maxOrderValueKrw.toLocaleString()} KRW cap`,
      );
      continue;
    }

    takenThisTick.add(order.ticker);
    entries += 1;
    submitted += 1;
    verdicts.push({ allowed: true, order });
  }

  return verdicts;
}

/**
 * Screen the exits the gate generated for itself.
 *
 * Deliberately thin. Loss limits and the daily order cap do not apply: both
 * exist to stop the desk taking on more risk, and refusing a sell does the
 * opposite by trapping a position the rules have already decided to close.
 * What is left is the checks that decide whether the order can be filled at
 * all.
 */
export function screenExits(
  positions: Position[],
  proposals: ProposedOrder[],
  at: Date = new Date(),
): Verdict[] {
  const state = windowState(at);

  return proposals.map((order): Verdict => {
    if (state === "before") {
      return { allowed: false, order, reason: "Outside the window: the session has not opened" };
    }
    const position = positions.find((p) => p.ticker === order.ticker);
    if (!position) {
      return { allowed: false, order, reason: `Cannot sell ${order.ticker}: no position held` };
    }
    if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
      return { allowed: false, order, reason: `Quantity must be a positive whole number` };
    }
    if (order.quantity > position.sellableQuantity) {
      return {
        allowed: false,
        order,
        reason: `Cannot sell ${order.quantity} of ${order.ticker}: only ${position.sellableQuantity} sellable`,
      };
    }
    return { allowed: true, order };
  });
}

/**
 * Exits the gate imposes regardless of what the strategy proposed: the stop,
 * the profit ladder, and the end-of-window flatten. These are generated rather
 * than screened -- a strategy cannot decline to take a stop.
 *
 * The ladder position is derived from how much of the day's holding has
 * already been sold rather than from a stored rung marker. With the quantity
 * bought and the quantity remaining, the realised fraction is arithmetic, and
 * arithmetic cannot drift out of sync the way a flag can.
 */
export function mandatoryExits(positions: Position[], at: Date = new Date()): ProposedOrder[] {
  const state = windowState(at);
  if (state === "before") return [];

  const orders: ProposedOrder[] = [];

  for (const position of positions) {
    if (position.sellableQuantity <= 0) continue;

    if (state === "closed") {
      orders.push({
        ticker: position.ticker,
        side: "sell",
        quantity: position.sellableQuantity,
        reason: "End of window: flattening",
      });
      continue;
    }

    // A position opened with its own levels is closed on those levels instead.
    // The strategy that set them was sizing its risk against the bar it entered
    // on, and a percentage of cost is a different promise entirely.
    if (position.stopLoss !== null || position.takeProfit !== null) {
      if (position.stopLoss !== null && position.currentPrice <= position.stopLoss) {
        orders.push({
          ticker: position.ticker,
          side: "sell",
          quantity: position.sellableQuantity,
          reason: `Stop at ${position.stopLoss.toLocaleString()} (${position.currentPrice.toLocaleString()} now)`,
        });
        continue;
      }
      if (position.takeProfit !== null && position.currentPrice >= position.takeProfit) {
        orders.push({
          ticker: position.ticker,
          side: "sell",
          quantity: position.sellableQuantity,
          reason: `Take profit at ${position.takeProfit.toLocaleString()} (${position.currentPrice.toLocaleString()} now)`,
        });
      }
      // Neither level reached: this position waits. The house ladder does not
      // apply to it, so there is nothing else to check.
      continue;
    }

    if (position.pnlPct <= exits.stopLossPct) {
      orders.push({
        ticker: position.ticker,
        side: "sell",
        quantity: position.sellableQuantity,
        reason: `Stop loss at ${position.pnlPct.toFixed(2)}%`,
      });
      continue;
    }

    const bought = position.boughtQuantity || position.quantity;
    const alreadySold = Math.max(0, bought - position.quantity);
    const soldFraction = bought > 0 ? alreadySold / bought : 0;

    // Something has already been taken off at a profit and the rest has
    // stalled back to the give-back line. Close it while it is still green.
    if (soldFraction > 0 && position.pnlPct <= exits.giveBackPct) {
      orders.push({
        ticker: position.ticker,
        side: "sell",
        quantity: position.sellableQuantity,
        reason: `Gave back to ${position.pnlPct.toFixed(2)}% after a partial exit — closing the remainder in profit`,
      });
      continue;
    }

    for (const rung of exits.ladder) {
      if (position.pnlPct < rung.atPct) continue;
      if (soldFraction >= rung.sellFraction - 1e-9) continue;

      const wanted = Math.floor(bought * rung.sellFraction) - alreadySold;
      const quantity = Math.min(position.sellableQuantity, Math.max(0, wanted));
      if (quantity <= 0) continue;

      orders.push({
        ticker: position.ticker,
        side: "sell",
        quantity,
        reason: `Take profit ${rung.atPct}% rung at ${position.pnlPct.toFixed(2)}% — ${Math.round(rung.sellFraction * 100)}% of the day's position`,
      });
      break;
    }
  }

  return orders;
}
