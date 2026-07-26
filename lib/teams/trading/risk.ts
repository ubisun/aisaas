import { TRADING_CONFIG } from "./config";
import type { ProposedOrder, TickContext } from "./types";

/**
 * The gate between a strategy's opinion and a real order.
 *
 * Everything here is a hard invariant. A proposal that fails any check is not
 * clamped or corrected -- it is rejected with a reason and recorded, because a
 * strategy that keeps asking for things it cannot have is itself the finding.
 */

export type Verdict =
  | { allowed: true; order: ProposedOrder }
  | { allowed: false; order: ProposedOrder; reason: string };

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

export type GateInput = {
  context: TickContext;
  proposals: ProposedOrder[];
  /** Session-level loss so far, positive percent. */
  lossPct: number;
  at?: Date;
};

/**
 * Screen a batch of proposals. Order matters: earlier allowances count against
 * the budgets seen by later ones, so a strategy cannot slip past the entry cap
 * by proposing several at once.
 */
export function screen({ context, proposals, lossPct, at = new Date() }: GateInput): Verdict[] {
  const state = windowState(at);
  const verdicts: Verdict[] = [];

  const held = new Set(context.positions.map((p) => p.ticker));
  let entries = context.entriesUsed;
  let submitted = context.ordersSoFar;
  const tradeable = new Set(context.candidates.map((c) => c.ticker));

  const deny = (order: ProposedOrder, reason: string) =>
    verdicts.push({ allowed: false, order, reason });

  for (const order of proposals) {
    if (state === "before") {
      deny(
        order,
        `Outside the window: trading opens at ${w.openHour}:${String(w.openMinute).padStart(2, "0")} KST`,
      );
      continue;
    }
    if (state === "closed") {
      deny(order, "Outside the window: the session is closed");
      continue;
    }
    if (state === "exits-only" && order.side === "buy") {
      deny(order, "New entries are closed; only exits are permitted before the flatten");
      continue;
    }
    if (lossPct >= limits.dailyLossLimitPct) {
      deny(order, `Daily loss limit reached (${lossPct.toFixed(2)}% >= ${limits.dailyLossLimitPct}%)`);
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

    if (order.side === "buy") {
      if (entries >= limits.maxEntriesPerDay) {
        deny(order, `Entry budget spent (${limits.maxEntriesPerDay} for the day)`);
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
      if (notional > limits.maxOrderValueKrw) {
        deny(
          order,
          `Order value ${Math.round(notional).toLocaleString()} KRW exceeds the ${limits.maxOrderValueKrw.toLocaleString()} KRW cap`,
        );
        continue;
      }
      if (!held.has(order.ticker) && held.size >= limits.maxConcurrentPositions) {
        deny(order, `Already holding ${held.size} positions (cap ${limits.maxConcurrentPositions})`);
        continue;
      }

      held.add(order.ticker);
      entries += 1;
    } else {
      const position = context.positions.find((p) => p.ticker === order.ticker);
      if (!position) {
        deny(order, `Cannot sell ${order.ticker}: no position held`);
        continue;
      }
      if (order.quantity > position.sellableQuantity) {
        deny(
          order,
          `Cannot sell ${order.quantity} of ${order.ticker}: only ${position.sellableQuantity} sellable`,
        );
        continue;
      }
    }

    submitted += 1;
    verdicts.push({ allowed: true, order });
  }

  return verdicts;
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
export function mandatoryExits(context: TickContext, at: Date = new Date()): ProposedOrder[] {
  const state = windowState(at);
  if (state === "before") return [];

  const orders: ProposedOrder[] = [];

  for (const position of context.positions) {
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
