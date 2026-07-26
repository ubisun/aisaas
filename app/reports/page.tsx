import { auth } from "@clerk/nextjs/server";

import type { SectorOutlook } from "@/lib/report/generate";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type ReportRow = {
  id: string;
  session_date: string;
  us_summary: string;
  us_summary_ko: string | null;
  kr_sector_outlook: SectorOutlook[];
  model: string;
};

const DIRECTION_STYLES: Record<SectorOutlook["direction"], string> = {
  positive:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  neutral: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  negative: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

export default async function ReportsPage() {
  await auth.protect();

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("reports")
    .select("id, session_date, us_summary, us_summary_ko, kr_sector_outlook, model")
    .order("session_date", { ascending: false })
    .limit(30);

  const reports = (data ?? []) as ReportRow[];

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Daily market reports
      </h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        US session summary and the KRX sectors it is likely to move. Generated after
        each US close — a reasoned projection, not investment advice.
      </p>

      {error && (
        <p className="mt-8 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
          Could not load reports: {error.message}
        </p>
      )}

      {!error && reports.length === 0 && (
        <p className="mt-8 rounded-lg border border-black/[.08] px-4 py-8 text-center text-sm text-zinc-500 dark:border-white/[.145] dark:text-zinc-400">
          No reports yet. The first one appears after the next US close.
        </p>
      )}

      <div className="mt-8 flex flex-col gap-10">
        {reports.map((report) => (
          <article key={report.id} className="border-t border-black/[.08] pt-6 dark:border-white/[.145]">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-medium text-black dark:text-zinc-50">
                {report.session_date}
              </h2>
              <span className="text-xs text-zinc-500 dark:text-zinc-500">{report.model}</span>
            </div>

            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
              {report.us_summary}
            </p>

            {report.us_summary_ko && (
              <details className="group mt-3">
                <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-300">
                  한국어로 보기
                </summary>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                  {report.us_summary_ko}
                </p>
              </details>
            )}

            <ul className="mt-6 flex flex-col gap-3">
              {report.kr_sector_outlook.map((outlook) => (
                <li
                  key={outlook.sector}
                  className="rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-black dark:text-zinc-50">
                      {outlook.sector}
                      {outlook.sector_ko && (
                        <span className="ml-1.5 font-normal text-zinc-500 dark:text-zinc-500">
                          {outlook.sector_ko}
                        </span>
                      )}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${DIRECTION_STYLES[outlook.direction]}`}
                    >
                      {outlook.direction}
                    </span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-500">
                      confidence: {outlook.confidence}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {outlook.rationale}
                  </p>
                  {outlook.rationale_ko && (
                    <p className="mt-2 border-l-2 border-black/[.08] pl-3 text-sm leading-relaxed text-zinc-500 dark:border-white/[.145] dark:text-zinc-500">
                      {outlook.rationale_ko}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </main>
  );
}
