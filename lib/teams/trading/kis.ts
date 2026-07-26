import { createAdminClient } from "@/lib/supabase/admin";

import { TRADING_CONFIG } from "./config";

/**
 * Korea Investment Open API.
 *
 * Only the paper environment is reachable. The real host and its credentials
 * are never read here, so a mistake in the strategy or the risk gate cannot
 * place a live order -- the address simply is not in the code.
 */

const HOSTS = {
  demo: "https://openapivts.koreainvestment.com:29443",
  real: "https://openapi.koreainvestment.com:9443",
} as const;

/**
 * Transaction ids differ between environments, which is a second safety net:
 * a paper id sent to the live host is rejected outright.
 *
 * Note the pairing is not what intuition suggests -- 0011 is sell and 0012 is
 * buy. Taken from Korea Investment's own examples, not from the many blog
 * posts still quoting the retired VTTC0802U.
 */
const TR = {
  demo: { sell: "VTTC0011U", buy: "VTTC0012U", balance: "VTTC8434R" },
  real: { sell: "TTTC0011U", buy: "TTTC0012U", balance: "TTTC8434R" },
} as const;

const PRICE_TR = "FHKST01010100";
const VOLUME_RANK_TR = "FHPST01710000";

function env(): "demo" | "real" {
  return TRADING_CONFIG.environment;
}

function credentials() {
  if (env() === "real") {
    throw new Error(
      "Live trading is not enabled. Set TRADING_CONFIG.environment deliberately, and only then supply live credentials.",
    );
  }

  const appKey = process.env.KIS_PAPER_APP_KEY;
  const appSecret = process.env.KIS_PAPER_APP_SECRET;
  const account = process.env.KIS_PAPER_ACCOUNT_NO;
  const product = process.env.KIS_ACCOUNT_PRODUCT ?? "01";

  if (!appKey || !appSecret || !account) {
    throw new Error(
      "KIS_PAPER_APP_KEY, KIS_PAPER_APP_SECRET and KIS_PAPER_ACCOUNT_NO are required",
    );
  }
  return { appKey, appSecret, account, product, host: HOSTS[env()] };
}

/**
 * Access tokens are valid for a day and their issuance is rate limited, so a
 * serverless function must never mint one per invocation. Cached in Postgres,
 * refreshed a few minutes before expiry.
 */
async function accessToken(): Promise<string> {
  const supabase = createAdminClient();
  const { appKey, appSecret, host } = credentials();

  const { data: cached } = await supabase
    .from("kis_tokens")
    .select("access_token, expires_at")
    .eq("environment", env())
    .maybeSingle();

  const safetyMarginMs = 10 * 60 * 1000;
  if (cached && new Date(cached.expires_at).getTime() - safetyMarginMs > Date.now()) {
    return cached.access_token as string;
  }

  const response = await fetch(`${host}/oauth2/tokenP`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: appKey,
      appsecret: appSecret,
    }),
  });

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(
      `KIS token request failed (${response.status}): ${payload.error_description ?? "no token returned"}`,
    );
  }

  const expiresAt = new Date(Date.now() + (payload.expires_in ?? 86400) * 1000);
  await supabase.from("kis_tokens").upsert(
    {
      environment: env(),
      access_token: payload.access_token,
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "environment" },
  );

  return payload.access_token;
}

/**
 * Korea Investment rejects bursts with "초당 거래건수를 초과하였습니다" -- the
 * paper environment in particular allows only a couple of calls a second.
 * Screening thirty tickers back to back trips it immediately, so every call
 * goes through a single queue that keeps a minimum gap between them.
 *
 * A module-level chain is enough: each function invocation is its own process,
 * and the loops that matter all run inside one.
 */
/**
 * Measured against the paper environment rather than guessed: 800ms between
 * calls was still rejected on the third, 1200ms held. The published limit is
 * looser than what the environment actually tolerates.
 */
const MIN_CALL_GAP_MS = { demo: 1200, real: 100 } as const;

let callChain: Promise<void> = Promise.resolve();
let lastCallAt = 0;

function throttle(): Promise<void> {
  const gap = MIN_CALL_GAP_MS[env()];
  callChain = callChain.then(async () => {
    const wait = lastCallAt + gap - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
  });
  return callChain;
}

async function call<T>(
  path: string,
  trId: string,
  init: { method: "GET" | "POST"; query?: Record<string, string>; body?: unknown },
): Promise<T> {
  await throttle();

  const { appKey, appSecret, host } = credentials();
  const token = await accessToken();

  const url = new URL(`${host}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: init.method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: trId,
      custtype: "P",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  const payload = (await response.json()) as { rt_cd?: string; msg1?: string } & T;

  // KIS answers 200 with rt_cd "1" on a rejected request, so the HTTP status
  // alone is not enough to tell success from failure.
  if (!response.ok || (payload.rt_cd !== undefined && payload.rt_cd !== "0")) {
    throw new Error(
      `KIS ${path} failed: rt_cd=${payload.rt_cd ?? "-"} ${payload.msg1 ?? response.statusText}`,
    );
  }
  return payload;
}

const num = (value: string | undefined): number => Number(value ?? 0) || 0;

export type KisQuote = {
  ticker: string;
  price: number;
  changePct: number;
  /** Cumulative traded value today, in KRW. */
  turnover: number;
  volume: number;
  /** Market capitalisation as KIS reports it, in 억원. */
  marketCapEok: number;
  /** Share turnover ratio -- traded volume against shares outstanding. */
  volumeTurnoverRate: number;
};

export async function fetchQuote(ticker: string): Promise<KisQuote> {
  const payload = await call<{
    output?: Record<string, string>;
  }>("/uapi/domestic-stock/v1/quotations/inquire-price", PRICE_TR, {
    method: "GET",
    query: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: ticker },
  });

  const o = payload.output ?? {};
  return {
    ticker,
    price: num(o.stck_prpr),
    changePct: num(o.prdy_ctrt),
    turnover: num(o.acml_tr_pbmn),
    volume: num(o.acml_vol),
    marketCapEok: num(o.hts_avls),
    volumeTurnoverRate: num(o.vol_tnrt),
  };
}

export type RankedStock = {
  ticker: string;
  name: string;
  rank: number;
  price: number;
  changePct: number;
  turnover: number;
  volume: number;
};

/**
 * Stocks ranked by traded value so far today. This is the raw pool candidates
 * are drawn from -- what is actually moving, before any view about sectors.
 */
export async function fetchVolumeRank(): Promise<RankedStock[]> {
  const payload = await call<{ output?: Record<string, string>[] }>(
    "/uapi/domestic-stock/v1/quotations/volume-rank",
    VOLUME_RANK_TR,
    {
      method: "GET",
      query: {
        FID_COND_MRKT_DIV_CODE: "J",
        FID_COND_SCR_DIV_CODE: "20171",
        FID_INPUT_ISCD: "0000", // whole market
        FID_DIV_CLS_CODE: "0",
        FID_BLNG_CLS_CODE: "3", // rank by traded value
        FID_TRGT_CLS_CODE: "111111111",
        FID_TRGT_EXLS_CLS_CODE: "0000000000",
        FID_INPUT_PRICE_1: "",
        FID_INPUT_PRICE_2: "",
        FID_VOL_CNT: "",
        FID_INPUT_DATE_1: "",
      },
    },
  );

  return (payload.output ?? []).map((row) => ({
    ticker: row.mksc_shrn_iscd,
    name: row.hts_kor_isnm,
    rank: num(row.data_rank),
    price: num(row.stck_prpr),
    changePct: num(row.n_befr_clpr_vrss_prpr_rate),
    turnover: num(row.acml_tr_pbmn),
    volume: num(row.acml_vol),
  }));
}

export type Holding = {
  ticker: string;
  name: string;
  quantity: number;
  /** Quantity free to sell today. */
  sellableQuantity: number;
  averagePrice: number;
  currentPrice: number;
  pnlPct: number;
};

export async function fetchHoldings(): Promise<Holding[]> {
  const { account, product } = credentials();

  const payload = await call<{ output1?: Record<string, string>[] }>(
    "/uapi/domestic-stock/v1/trading/inquire-balance",
    TR[env()].balance,
    {
      method: "GET",
      query: {
        CANO: account,
        ACNT_PRDT_CD: product,
        AFHR_FLPR_YN: "N",
        OFL_YN: "",
        INQR_DVSN: "02",
        UNPR_DVSN: "01",
        FUND_STTL_ICLD_YN: "N",
        FNCG_AMT_AUTO_RDPT_YN: "N",
        PRCS_DVSN: "00",
        CTX_AREA_FK100: "",
        CTX_AREA_NK100: "",
      },
    },
  );

  return (payload.output1 ?? [])
    .filter((row) => num(row.hldg_qty) > 0)
    .map((row) => ({
      ticker: row.pdno,
      name: row.prdt_name,
      quantity: num(row.hldg_qty),
      sellableQuantity: num(row.ord_psbl_qty),
      averagePrice: num(row.pchs_avg_pric),
      currentPrice: num(row.prpr),
      pnlPct: num(row.evlu_pfls_rt),
    }));
}

export type AccountSummary = {
  /** Total valuation of holdings, in KRW. */
  holdingsValue: number;
  /** Unrealised profit and loss across holdings, in KRW. */
  unrealisedPnl: number;
  /** Deposit balance, in KRW. */
  cash: number;
};

/** The account-level totals KIS returns alongside the holdings list. */
export async function fetchAccountSummary(): Promise<AccountSummary> {
  const { account, product } = credentials();

  const payload = await call<{ output2?: Record<string, string>[] }>(
    "/uapi/domestic-stock/v1/trading/inquire-balance",
    TR[env()].balance,
    {
      method: "GET",
      query: {
        CANO: account,
        ACNT_PRDT_CD: product,
        AFHR_FLPR_YN: "N",
        OFL_YN: "",
        INQR_DVSN: "02",
        UNPR_DVSN: "01",
        FUND_STTL_ICLD_YN: "N",
        FNCG_AMT_AUTO_RDPT_YN: "N",
        PRCS_DVSN: "00",
        CTX_AREA_FK100: "",
        CTX_AREA_NK100: "",
      },
    },
  );

  const summary = payload.output2?.[0] ?? {};
  return {
    holdingsValue: num(summary.scts_evlu_amt),
    unrealisedPnl: num(summary.evlu_pfls_smtl_amt),
    cash: num(summary.dnca_tot_amt),
  };
}

export type OrderResult = { orderNo: string; raw: unknown };

/**
 * Place a cash order.
 *
 * Market orders use ORD_DVSN "01" with an empty price, which is what Korea
 * Investment expects; a limit order is "00" with the price as a string.
 */
export async function placeOrder(params: {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  limitPrice?: number;
}): Promise<OrderResult> {
  const { account, product } = credentials();
  const isLimit = typeof params.limitPrice === "number" && params.limitPrice > 0;

  const payload = await call<{ output?: { ODNO?: string } }>(
    "/uapi/domestic-stock/v1/trading/order-cash",
    TR[env()][params.side],
    {
      method: "POST",
      body: {
        CANO: account,
        ACNT_PRDT_CD: product,
        PDNO: params.ticker,
        ORD_DVSN: isLimit ? "00" : "01",
        ORD_QTY: String(params.quantity),
        ORD_UNPR: isLimit ? String(Math.round(params.limitPrice!)) : "0",
        EXCG_ID_DVSN_CD: "KRX",
      },
    },
  );

  return { orderNo: payload.output?.ODNO ?? "", raw: payload };
}
