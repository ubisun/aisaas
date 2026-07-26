/**
 * The instruments a daily report is built from.
 *
 * Finnhub's free tier quotes tradable symbols rather than index values, so the
 * benchmarks are their ETF proxies. The sector list is the eleven SPDR funds,
 * which map one-to-one onto the GICS sectors.
 */

export type Instrument = {
  symbol: string;
  kind: "index" | "sector";
  label: string;
};

export const INSTRUMENTS: Instrument[] = [
  { symbol: "SPY", kind: "index", label: "S&P 500" },
  { symbol: "QQQ", kind: "index", label: "Nasdaq 100" },
  { symbol: "DIA", kind: "index", label: "Dow Jones Industrial Average" },

  { symbol: "XLK", kind: "sector", label: "Information Technology" },
  { symbol: "XLC", kind: "sector", label: "Communication Services" },
  { symbol: "XLY", kind: "sector", label: "Consumer Discretionary" },
  { symbol: "XLP", kind: "sector", label: "Consumer Staples" },
  { symbol: "XLE", kind: "sector", label: "Energy" },
  { symbol: "XLF", kind: "sector", label: "Financials" },
  { symbol: "XLV", kind: "sector", label: "Health Care" },
  { symbol: "XLI", kind: "sector", label: "Industrials" },
  { symbol: "XLB", kind: "sector", label: "Materials" },
  { symbol: "XLRE", kind: "sector", label: "Real Estate" },
  { symbol: "XLU", kind: "sector", label: "Utilities" },
];
