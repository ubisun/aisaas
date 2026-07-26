/**
 * The contract every strategy implements.
 *
 * A strategy sees a snapshot and returns proposals. It does not place orders,
 * does not know about Korea Investment, and cannot bypass the risk gate --
 * which is what makes a human's idea droppable in beside the model-driven one
 * and testable against the same recorded ticks.
 */

export type Quote = {
  ticker: string;
  name: string;
  price: number;
  /** Change against the previous close, in percent. */
  changePct: number;
  /** Cumulative traded value so far today, in KRW. */
  turnover: number;
  volume: number;
};

export type Position = {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  /** Unrealised, in percent of cost. */
  pnlPct: number;
};

export type TickContext = {
  /** KRX trading date, Asia/Seoul. */
  tradeDate: string;
  /** Seoul wall-clock time of this tick, HH:mm. */
  observedAt: string;
  /** Minutes remaining before new entries are refused. */
  minutesToLastEntry: number;
  quotes: Quote[];
  positions: Position[];
  /** Sector view carried over from the morning's US market report. */
  sectorOutlook: { sector: string; direction: string; confidence: string }[];
  /** Orders already submitted today, against the daily cap. */
  ordersSoFar: number;
};

export type ProposedOrder = {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  /** Omit for a market order. */
  limitPrice?: number;
  /** Why. Recorded whether or not the order survives the gate. */
  reason: string;
};

export type StrategyProposal = {
  orders: ProposedOrder[];
  /** Free-form account of what the strategy made of this tick. */
  reasoning: string;
};

export type Strategy = {
  name: string;
  description: string;
  propose(context: TickContext): Promise<StrategyProposal>;
};
