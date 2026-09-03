import { auth } from "@clerk/nextjs/server";

import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * What the desk has made, and what each day was made of.
 *
 * Two things are kept apart throughout, because conflating them is how an
 * estimate ends up quoted as a return a month later. The account figure is the
 * broker's own and is exact; the per-strategy split is arithmetic over the last
 * mark of each position, which on the paper account is the only thing available.
 * Period returns quote the first. The strategy table is labelled as the second.
 */

type PositionDetail = {
  ticker: string;
  name: string;
  strategy: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  costKrw: number;
  pnlKrw: number;
  pnlPct: number;
};

type Snapshot = {
  trade_date: string;
  environment: string;
  cash_krw: number | null;
  holdings_value_krw: number | null;
  total_equity_krw: number | null;
  realised_pnl_krw: number | null;
  by_strategy: Record<string, number>;
  account_realised_krw: number | null;
  attribution_source: string | null;
  unattributed_krw: number | null;
  capital_krw: number | null;
  positions: PositionDetail[];
};

const won = (v: number) =>
  `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v)).toLocaleString("ko-KR")}원`;
const plain = (v: number) => `${Math.round(v).toLocaleString("ko-KR")}원`;
const pct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;

/** KRX convention: gains are red, losses blue. */
const tone = (v: number) =>
  v > 0
    ? "text-rose-600 dark:text-rose-400"
    : v < 0
      ? "text-blue-600 dark:text-blue-400"
      : "text-zinc-500 dark:text-zinc-400";

const dayResult = (row: Snapshot) => row.account_realised_krw ?? row.realised_pnl_krw ?? 0;

/**
 * Returns are summed rather than compounded. Every position is flattened before
 * the close and the same capital goes back to work the next morning, so a day's
 * result is a fraction of that fixed capital, not of a balance that carries
 * forward. Compounding would describe a different desk.
 */
function summarise(rows: Snapshot[], capital: number) {
  const realised = rows.reduce((sum, r) => sum + dayResult(r), 0);
  return {
    realised,
    pct: capital > 0 ? (realised / capital) * 100 : 0,
    days: rows.length,
    wins: rows.filter((r) => dayResult(r) > 0).length,
  };
}

const within = (rows: Snapshot[], days: number) => {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return rows.filter((r) => r.trade_date >= cutoff);
};

export default async function PerformancePage() {
  await auth.protect();

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("equity_snapshots")
    .select(
      "trade_date, environment, cash_krw, holdings_value_krw, total_equity_krw, realised_pnl_krw, by_strategy, account_realised_krw, attribution_source, unattributed_krw, capital_krw, positions",
    )
    .order("trade_date", { ascending: false })
    .limit(180);

  const rows = (data ?? []) as Snapshot[];
  const capital = rows[0]?.capital_krw ?? 0;
  const latest = rows[0];
  const estimatedOnly = rows.length > 0 && rows.every((r) => r.attribution_source === "marks");

  const periods = [
    { label: "1일", rows: rows.slice(0, 1) },
    { label: "1주", rows: within(rows, 7) },
    { label: "1개월", rows: within(rows, 30) },
    { label: "전체", rows },
  ];

  // Per strategy: each day's result and the running total behind it.
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.by_strategy ?? {})))].sort();
  const perStrategy = names.map((name) => {
    const daily = rows
      .map((r) => ({ date: r.trade_date, pnl: r.by_strategy?.[name] ?? 0 }))
      .filter((d) => d.pnl !== 0 || rows.length <= 30);
    const total = daily.reduce((sum, d) => sum + d.pnl, 0);
    const traded = rows.filter((r) => (r.positions ?? []).some((p) => p.strategy === name)).length;
    return { name, daily, total, traded };
  });

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Trading performance
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        세션 마감 직후에 기록됩니다. 매일 전량 청산하고 같은 자본으로 다시 시작하므로,
        기간 수익률은 복리가 아니라 일별 손익의 합을 자본으로 나눈 값입니다.
      </p>

      {error && (
        <p className="mt-6 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
          기록을 읽지 못했습니다: {error.message}
        </p>
      )}

      {!rows.length && !error && (
        <p className="mt-6 rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          아직 기록된 세션이 없습니다. 첫 마감 이후에 나타납니다.
        </p>
      )}

      {rows.length > 0 && (
        <>
          {/* ---- Account ---- */}
          <section className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 sm:grid-cols-4 dark:border-zinc-800 dark:bg-zinc-800">
            {periods.map(({ label, rows: slice }) => {
              const s = summarise(slice, capital);
              return (
                <div key={label} className="bg-white px-4 py-3 dark:bg-black">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
                  <div className={`mt-1 text-lg font-semibold tabular-nums ${tone(s.realised)}`}>
                    {s.days ? pct(s.pct) : "—"}
                  </div>
                  <div className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                    {s.days ? `${won(s.realised)} · ${s.days}일 중 ${s.wins}일 수익` : "기록 없음"}
                  </div>
                </div>
              );
            })}
          </section>

          <section className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 sm:grid-cols-3 dark:border-zinc-800 dark:bg-zinc-800">
            <div className="bg-white px-4 py-3 dark:bg-black">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">계좌 잔고</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-black dark:text-zinc-50">
                {latest?.total_equity_krw === null || latest?.total_equity_krw === undefined
                  ? "—"
                  : plain(latest.total_equity_krw)}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {latest?.environment === "demo" ? "모의계좌" : "실계좌"} · {latest?.trade_date} 마감
              </div>
            </div>
            <div className="bg-white px-4 py-3 dark:bg-black">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">데스크 자본</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-black dark:text-zinc-50">
                {plain(capital)}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                수익률의 분모 · 계좌 잔고와 무관한 설정값
              </div>
            </div>
            <div className="bg-white px-4 py-3 dark:bg-black">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">누적 실현손익</div>
              <div
                className={`mt-1 text-lg font-semibold tabular-nums ${tone(summarise(rows, capital).realised)}`}
              >
                {won(summarise(rows, capital).realised)}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {rows.length}거래일 누적
              </div>
            </div>
          </section>

          {/* ---- Per strategy ---- */}
          {perStrategy.length > 0 && (
            <section className="mt-10">
              <h2 className="text-sm font-semibold text-black dark:text-zinc-50">
                전략별{estimatedOnly ? " (추정)" : ""}
              </h2>
              {estimatedOnly && (
                <p className="mt-1 max-w-2xl text-xs text-zinc-500 dark:text-zinc-400">
                  모의투자는 체결 내역을 제공하지 않아, 청산 직전 평가손익으로 추정한 값입니다.
                  두 전략이 같은 방식으로 측정되므로 비교에는 쓸 수 있지만 수익률로 인용할 수는
                  없습니다 — 위의 기간 수익률은 계좌 실측입니다.
                </p>
              )}

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {perStrategy.map((s) => (
                  <div
                    key={s.name}
                    className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium text-black dark:text-zinc-100">{s.name}</span>
                      <span className={`text-lg font-semibold tabular-nums ${tone(s.total)}`}>
                        {won(s.total)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                      누적 {pct(capital > 0 ? (s.total / capital) * 100 : 0)} · {s.traded}일 진입
                    </div>

                    <ol className="mt-3 flex flex-col gap-1 text-xs">
                      {s.daily.slice(0, 10).map((d) => (
                        <li key={d.date} className="flex justify-between tabular-nums">
                          <span className="text-zinc-500 dark:text-zinc-400">{d.date}</span>
                          <span className={tone(d.pnl)}>{d.pnl === 0 ? "—" : won(d.pnl)}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ---- Day by day, expandable ---- */}
          <section className="mt-10">
            <h2 className="text-sm font-semibold text-black dark:text-zinc-50">일별</h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              날짜를 누르면 그날 진입한 종목이 펼쳐집니다.
            </p>

            <div className="mt-3 flex flex-col gap-2">
              {rows.map((row) => {
                const result = dayResult(row);
                const positions = row.positions ?? [];
                return (
                  <details
                    key={`${row.trade_date}-${row.environment}`}
                    className="group rounded-lg border border-zinc-200 dark:border-zinc-800"
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm">
                      <span className="flex items-center gap-3">
                        <span className="text-zinc-400 transition-transform group-open:rotate-90">
                          ▸
                        </span>
                        <span className="font-medium tabular-nums text-black dark:text-zinc-100">
                          {row.trade_date}
                        </span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          {positions.length ? `${positions.length}종목` : "진입 없음"}
                        </span>
                      </span>
                      <span className="flex items-baseline gap-3 tabular-nums">
                        <span className={`font-semibold ${tone(result)}`}>{won(result)}</span>
                        <span className={`text-xs ${tone(result)}`}>
                          {capital > 0 ? pct((result / capital) * 100) : "—"}
                        </span>
                      </span>
                    </summary>

                    <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
                      {positions.length === 0 ? (
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          이날은 어느 전략도 진입하지 않았습니다.
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[40rem] text-xs">
                            <thead className="text-zinc-500 dark:text-zinc-400">
                              <tr className="text-left">
                                <th className="pb-2 pr-3 font-medium">종목</th>
                                <th className="pb-2 pr-3 font-medium">전략</th>
                                <th className="pb-2 pr-3 text-right font-medium">수량</th>
                                <th className="pb-2 pr-3 text-right font-medium">진입가</th>
                                <th className="pb-2 pr-3 text-right font-medium">매수금액</th>
                                <th className="pb-2 pr-3 text-right font-medium">청산가</th>
                                <th className="pb-2 pr-3 text-right font-medium">손익</th>
                                <th className="pb-2 text-right font-medium">수익률</th>
                              </tr>
                            </thead>
                            <tbody>
                              {positions.map((p) => (
                                <tr
                                  key={p.ticker}
                                  className="border-t border-zinc-100 dark:border-zinc-900"
                                >
                                  <td className="py-2 pr-3">
                                    <span className="text-black dark:text-zinc-100">{p.name}</span>
                                    <span className="ml-1.5 tabular-nums text-zinc-400">
                                      {p.ticker}
                                    </span>
                                  </td>
                                  <td className="py-2 pr-3 text-zinc-500 dark:text-zinc-400">
                                    {p.strategy}
                                  </td>
                                  <td className="py-2 pr-3 text-right tabular-nums">{p.quantity}</td>
                                  <td className="py-2 pr-3 text-right tabular-nums">
                                    {plain(p.entryPrice)}
                                  </td>
                                  <td className="py-2 pr-3 text-right tabular-nums">
                                    {plain(p.costKrw)}
                                  </td>
                                  <td className="py-2 pr-3 text-right tabular-nums">
                                    {plain(p.exitPrice)}
                                  </td>
                                  <td className={`py-2 pr-3 text-right tabular-nums ${tone(p.pnlKrw)}`}>
                                    {won(p.pnlKrw)}
                                  </td>
                                  <td className={`py-2 text-right tabular-nums ${tone(p.pnlPct)}`}>
                                    {pct(p.pnlPct)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {row.unattributed_krw !== null && Math.abs(row.unattributed_krw) > 0 && (
                        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                          계좌 실측과의 차이 {won(row.unattributed_krw)} — 수수료·세금과 마지막
                          관측 이후의 슬리피지입니다.
                        </p>
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
