/**
 * The contract every strategy implements.
 *
 * A strategy sees a snapshot and returns proposals. It does not place orders,
 * does not know about Korea Investment, and cannot bypass the risk gate --
 * which is what makes a human's idea droppable in beside the model-driven one
 * and testable against the same recorded ticks.
 */

export type Candidate = {
  ticker: string;
  name: string;
  price: number;
  /** Change against the previous close, in percent. */
  changePct: number;
  /** Cumulative traded value today, in KRW. */
  turnover: number;
  /** Traded value as a percentage of market capitalisation. */
  turnoverToMarketCapPct: number;
  /** Sector the morning report flagged, when the candidate came from one. */
  sector?: string;
};

export type Position = {
  ticker: string;
  name: string;
  quantity: number;
  /** Quantity free to sell right now. */
  sellableQuantity: number;
  /** Total bought today, used to work out how much of the ladder is done. */
  boughtQuantity: number;
  averagePrice: number;
  currentPrice: number;
  /** Unrealised, in percent of cost. */
  pnlPct: number;
  /**
   * Exit levels the entry was placed with, in KRW.
   *
   * Null means the house rules govern this position. When set, they replace the
   * percentage stop and the profit ladder for this position only -- a strategy
   * whose edge is its risk-to-reward cannot be held to exits priced as a
   * percentage of cost.
   */
  stopLoss: number | null;
  takeProfit: number | null;
};

export type TickContext = {
  /** KRX trading date, Asia/Seoul. */
  tradeDate: string;
  /** The session before this one, for indicators that need warming up. */
  previousTradeDate: string;
  /** The run this tick belongs to, for strategies that keep state. */
  runId: string;
  /** Seoul wall-clock time of this tick, HH:mm. */
  observedAt: string;
  /** Minutes remaining before new entries are refused. */
  minutesToLastEntry: number;
  candidates: Candidate[];
  positions: Position[];
  /** Sector view carried over from the most recent US market report. */
  sectorOutlook: {
    sector: string;
    direction: string;
    confidence: string;
    rationale: string;
  }[];
  /** Entries used so far today, against the daily budget. */
  entriesUsed: number;
  entryBudget: number;
  /** Orders of any kind submitted today. */
  ordersSoFar: number;
  /** Notional ceiling for a single order, in KRW. */
  maxOrderValueKrw: number;
  /** This strategy's whole share of the day's capital, in KRW. */
  budgetKrw: number;
};

export type ProposedOrder = {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  /** Omit for a market order. */
  limitPrice?: number;
  /** Why. Recorded whether or not the order survives the gate. */
  reason: string;
  /**
   * What this entry is worth risking, in KRW. Optional: a strategy with no
   * opinion about its exit gets the house rules.
   *
   * Setting these is not the same as proposing a sell. The strategy still
   * cannot ask to close anything -- it is stating the terms of the position it
   * is opening, and the risk gate is what acts on them later.
   */
  stopLoss?: number;
  takeProfit?: number;
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

/** What the risk gate decided about one proposed order. */
export type Verdict =
  | { allowed: true; order: ProposedOrder }
  | { allowed: false; order: ProposedOrder; reason: string };
