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

const SEOUL = "Asia/Seoul";

const seoulTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: SEOUL,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Minutes since midnight in Seoul. */
export function seoulMinutes(at: Date = new Date()): number {
  const [hour, minute] = seoulTime.format(at).split(":").map(Number);
  return hour * 60 + minute;
}

const { window: w, limits } = TRADING_CONFIG;
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

export type GateInput = {
  context: TickContext;
  proposals: ProposedOrder[];
  /** Tickers currently held, for position-count and sell-validity checks. */
  heldTickers: Set<string>;
  /** Session-level loss so far, positive percent. */
  lossPct: number;
  at?: Date;
};

/**
 * Screen a batch of proposals. Order matters: earlier allowances count against
 * the limits seen by later ones, so a strategy cannot slip past the position
 * cap by proposing several at once.
 */
export function screen({
  context,
  proposals,
  heldTickers,
  lossPct,
  at = new Date(),
}: GateInput): Verdict[] {
  const state = windowState(at);
  const verdicts: Verdict[] = [];

  const held = new Set(heldTickers);
  let submitted = context.ordersSoFar;
  const candidates = new Set(context.quotes.map((q) => q.ticker));

  const deny = (order: ProposedOrder, reason: string) =>
    verdicts.push({ allowed: false, order, reason });

  for (const order of proposals) {
    if (state === "before") {
      deny(order, `Outside the window: trading opens at ${w.openHour}:${String(w.openMinute).padStart(2, "0")} KST`);
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

    if (!candidates.has(order.ticker) && !held.has(order.ticker)) {
      deny(order, `${order.ticker} is not a candidate for this session and is not held`);
      continue;
    }

    const quote = context.quotes.find((q) => q.ticker === order.ticker);
    const reference = order.limitPrice ?? quote?.price;
    if (!reference || reference <= 0) {
      deny(order, `No usable price for ${order.ticker}`);
      continue;
    }

    if (order.side === "buy") {
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
    } else {
      const position = context.positions.find((p) => p.ticker === order.ticker);
      if (!position) {
        deny(order, `Cannot sell ${order.ticker}: no position held`);
        continue;
      }
      if (order.quantity > position.quantity) {
        deny(order, `Cannot sell ${order.quantity} of ${order.ticker}: only ${position.quantity} held`);
        continue;
      }
      if (order.quantity === position.quantity) held.delete(order.ticker);
    }

    submitted += 1;
    verdicts.push({ allowed: true, order });
  }

  return verdicts;
}

/**
 * Exits the gate requires regardless of what the strategy proposed: stops,
 * targets, and the end-of-window flatten. These are generated rather than
 * screened -- a strategy cannot decline to take a stop.
 */
export function mandatoryExits(
  context: TickContext,
  at: Date = new Date(),
): ProposedOrder[] {
  const state = windowState(at);
  if (state === "before") return [];

  const flatten = state === "closed" || state === "exits-only";

  return context.positions
    .filter((position) => {
      if (flatten && state === "closed") return true;
      if (position.pnlPct <= -limits.stopLossPct) return true;
      if (position.pnlPct >= limits.takeProfitPct) return true;
      return false;
    })
    .map((position) => ({
      ticker: position.ticker,
      side: "sell" as const,
      quantity: position.quantity,
      reason:
        state === "closed"
          ? "End of window: flattening"
          : position.pnlPct <= -limits.stopLossPct
            ? `Stop loss at ${position.pnlPct.toFixed(2)}%`
            : `Take profit at ${position.pnlPct.toFixed(2)}%`,
    }));
}
