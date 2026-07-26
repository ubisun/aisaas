import { INSTRUMENTS, type Instrument } from "./symbols";

const BASE_URL = "https://api.finnhub.io/api/v1";

/**
 * Finnhub's quote response. Field names are one-letter and come straight from
 * the provider: o/h/l/c are the day's open, high, low and current price, pc is
 * the previous close, d and dp the absolute and percent change. `t` is the
 * last-trade timestamp in epoch seconds -- present on the REST response but
 * absent from some of Finnhub's own client models, so it is optional here.
 */
export type FinnhubQuote = {
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  pc?: number;
  d?: number;
  dp?: number;
  t?: number;
};

export type CollectedQuote = Instrument & {
  close: number;
  previousClose: number;
  changePct: number;
  timestamp?: number;
};

async function fetchQuote(symbol: string): Promise<FinnhubQuote> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) throw new Error("FINNHUB_API_KEY is not set");

  const url = `${BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`;
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Finnhub returned ${response.status} for ${symbol}`);
  }
  return response.json();
}

/**
 * Fetch every instrument in one pass. The free tier allows enough requests per
 * minute for the fourteen symbols to go out concurrently; if that ever changes,
 * this is the one place that needs a rate limiter.
 */
export async function collectQuotes(): Promise<CollectedQuote[]> {
  return Promise.all(
    INSTRUMENTS.map(async (instrument) => {
      const quote = await fetchQuote(instrument.symbol);

      if (quote.c == null || quote.pc == null) {
        throw new Error(`Finnhub returned no price for ${instrument.symbol}`);
      }

      // Prefer the provider's own percent change; fall back to computing it so
      // a missing `dp` doesn't fail the whole run.
      const changePct = quote.dp ?? ((quote.c - quote.pc) / quote.pc) * 100;

      return {
        ...instrument,
        close: quote.c,
        previousClose: quote.pc,
        changePct,
        timestamp: quote.t,
      };
    }),
  );
}
