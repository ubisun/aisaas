import { auth } from "@clerk/nextjs/server";

import { createServerSupabaseClient } from "@/lib/supabase/server";

type Snapshot = {
  trade_date: string;
  environment: string;
  cash_krw: number | null;
  holdings_value_krw: number | null;
  total_equity_krw: number | null;
  /** Per-strategy arithmetic: exact from fills, estimated from marks. */
  realised_pnl_krw: number | null;
  by_strategy: Record<string, number>;
  /** The broker's own figure for the account. Exact, fees included. */
  account_realised_krw: number | null;
  attribution_source: string | null;
  unattributed_krw: number | null;
  capital_krw: number | null;
};

const won = (value: number) =>
  `${value >= 0 ? "+" : "−"}${Math.abs(Math.round(value)).toLocaleString("ko-KR")}원`;

const pct = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;

/**
 * Returns are additive rather than compounded, because the desk is not a fund.
 * Every position is flattened before the close and the same capital is put back
 * to work the next morning, so a day's result is a fraction of that fixed
 * capital -- not of a balance that carries forward. Summing is the honest
 * arithmetic for that arrangement; compounding would describe a different desk.
 */
function summarise(rows: Snapshot[]) {
  // The account figure, not the per-strategy sum. The two differ by fees and
  // by whatever the estimate missed, and a return quoted from an estimate is
  // the kind of number that gets believed later.
  const realised = rows.reduce(
    (sum, r) => sum + (r.account_realised_krw ?? r.realised_pnl_krw ?? 0),
    0,
  );
  const capital = rows[0]?.capital_krw ?? 0;
  return {
    realised,
    pct: capital > 0 ? (realised / capital) * 100 : 0,
    days: rows.length,
    wins: rows.filter((r) => (r.account_realised_krw ?? r.realised_pnl_krw ?? 0) > 0).length,
  };
}

function within(rows: Snapshot[], days: number) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return rows.filter((r) => r.trade_date >= cutoff);
}

export default async function PerformancePage() {
  await auth.protect();

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("equity_snapshots")
    .select(
      "trade_date, environment, cash_krw, holdings_value_krw, total_equity_krw, realised_pnl_krw, by_strategy, account_realised_krw, attribution_source, unattributed_krw, capital_krw",
    )
    .order("trade_date", { ascending: false })
    .limit(180);

  const rows = (data ?? []) as Snapshot[];
  const periods = [
    { label: "최근 1일", rows: rows.slice(0, 1) },
    { label: "최근 1주", rows: within(rows, 7) },
    { label: "최근 1개월", rows: within(rows, 30) },
    { label: "전체", rows },
  ];

  // Realised profit per strategy across everything on the page.
  // Every row on the page attributed by estimate rather than by fills.
  const estimatedOnly =
    rows.length > 0 && rows.every((r) => r.attribution_source === "marks");

  const byStrategy = new Map<string, { realised: number; days: number }>();
  for (const row of rows) {
    for (const [strategy, amount] of Object.entries(row.by_strategy ?? {})) {
      const entry = byStrategy.get(strategy) ?? { realised: 0, days: 0 };
      entry.realised += amount;
      entry.days += 1;
      byStrategy.set(strategy, entry);
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Trading performance
      </h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        세션마다 마감 직후에 기록된 실현손익입니다. 매일 전량 청산하고 같은 자본으로 다시
        시작하므로, 기간 수익률은 복리가 아니라 일별 손익의 합을 자본으로 나눈 값입니다.
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
          <section className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 sm:grid-cols-4 dark:border-zinc-800 dark:bg-zinc-800">
            {periods.map(({ label, rows: slice }) => {
              const s = summarise(slice);
              return (
                <div key={label} className="bg-white px-4 py-3 dark:bg-black">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
                  <div
                    className={`mt-1 text-lg font-semibold tabular-nums ${
                      s.realised >= 0
                        ? "text-rose-600 dark:text-rose-400"
                        : "text-blue-600 dark:text-blue-400"
                    }`}
                  >
                    {s.days ? pct(s.pct) : "—"}
                  </div>
                  <div className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                    {s.days ? `${won(s.realised)} · ${s.days}일 중 ${s.wins}일 수익` : "기록 없음"}
                  </div>
                </div>
              );
            })}
          </section>

          {byStrategy.size > 0 && (
            <section className="mt-10">
              <h2 className="text-sm font-semibold text-black dark:text-zinc-50">
                전략별{estimatedOnly ? " (추정)" : ""}
              </h2>
              {estimatedOnly && (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  모의투자는 체결 내역을 제공하지 않아, 청산 직전 평가손익으로 추정한
                  값입니다. 두 전략이 같은 방식으로 측정되므로 비교에는 쓸 수 있지만
                  수익률로 인용할 수는 없습니다 — 위의 기간 수익률은 계좌 실측입니다.
                </p>
              )}
              <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full min-w-[28rem] text-sm">
                  <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">전략</th>
                      <th className="px-4 py-2 text-right font-medium">실현손익</th>
                      <th className="px-4 py-2 text-right font-medium">거래일</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...byStrategy.entries()]
                      .sort((a, b) => b[1].realised - a[1].realised)
                      .map(([strategy, s]) => (
                        <tr
                          key={strategy}
                          className="border-t border-zinc-200 dark:border-zinc-800"
                        >
                          <td className="px-4 py-2 font-medium text-black dark:text-zinc-100">
                            {strategy}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${
                              s.realised >= 0
                                ? "text-rose-600 dark:text-rose-400"
                                : "text-blue-600 dark:text-blue-400"
                            }`}
                          >
                            {won(s.realised)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                            {s.days}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="mt-10">
            <h2 className="text-sm font-semibold text-black dark:text-zinc-50">일별</h2>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">날짜</th>
                    <th className="px-4 py-2 text-left font-medium">계좌</th>
                    <th className="px-4 py-2 text-right font-medium">실현손익</th>
                    <th className="px-4 py-2 text-right font-medium">수익률</th>
                    <th className="px-4 py-2 text-right font-medium">평가금액</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const realised = row.account_realised_krw ?? row.realised_pnl_krw ?? 0;
                    const capital = row.capital_krw ?? 0;
                    return (
                      <tr
                        key={`${row.trade_date}-${row.environment}`}
                        className="border-t border-zinc-200 dark:border-zinc-800"
                      >
                        <td className="px-4 py-2 tabular-nums text-black dark:text-zinc-100">
                          {row.trade_date}
                        </td>
                        <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">
                          {row.environment === "demo" ? "모의" : "실계좌"}
                        </td>
                        <td
                          className={`px-4 py-2 text-right tabular-nums ${
                            realised >= 0
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-blue-600 dark:text-blue-400"
                          }`}
                        >
                          {won(realised)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                          {capital > 0 ? pct((realised / capital) * 100) : "—"}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                          {row.total_equity_krw === null
                            ? "—"
                            : `${Math.round(row.total_equity_krw).toLocaleString("ko-KR")}원`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
