import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Commands the CEO can send the company.
 *
 * A command is a name, a description and a handler returning the reply. New
 * ones are added to the registry; `/help` is generated from it, so a command
 * cannot be added and left undocumented.
 */

export type CommandContext = {
  /** Everything after the command word, already trimmed. */
  args: string;
};

export type Command = {
  name: string;
  description: string;
  handle(context: CommandContext): Promise<string>;
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function appUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return `${base}${path}`;
}

const STATUS_ICON: Record<string, string> = {
  succeeded: "✅",
  failed: "❌",
  skipped: "⏸",
  running: "⏳",
  queued: "🕓",
};

const status: Command = {
  name: "status",
  description: "Recent activity across every team",
  async handle() {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("runs")
      .select("team, kind, key, status, phase, started_at, finished_at")
      .order("started_at", { ascending: false })
      .limit(10);

    if (error) return `Could not read runs: ${escapeHtml(error.message)}`;
    if (!data?.length) return "No runs recorded yet.";

    const lines = data.map((run) => {
      const icon = STATUS_ICON[run.status] ?? "•";
      const detail = run.status === "running" && run.phase ? ` (${run.phase})` : "";
      return `${icon} <b>${escapeHtml(run.team)}</b> ${escapeHtml(run.key)} — ${escapeHtml(run.status)}${escapeHtml(detail)}`;
    });

    return `<b>Recent runs</b>\n${lines.join("\n")}`;
  },
};

const report: Command = {
  name: "report",
  description: "The latest market report",
  async handle() {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("reports")
      .select("session_date, us_summary, us_summary_ko, kr_sector_outlook, model")
      .order("session_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return `Could not read reports: ${escapeHtml(error.message)}`;
    if (!data) return "No report yet. The next one lands after the US close.";

    const outlook = (data.kr_sector_outlook ?? []) as {
      sector: string;
      sector_ko?: string;
      direction: string;
      confidence: string;
    }[];

    const sectors = outlook
      .map((s) => `• ${escapeHtml(s.sector_ko ?? s.sector)} — ${escapeHtml(s.direction)} (${escapeHtml(s.confidence)})`)
      .join("\n");

    // The Korean summary is the one worth reading on a phone; the English is
    // a click away in the dashboard.
    const summary = (data.us_summary_ko ?? data.us_summary ?? "").slice(0, 700);

    return (
      `<b>📈 US session ${escapeHtml(data.session_date)}</b>\n\n` +
      `${escapeHtml(summary)}\n\n` +
      `<b>KRX sectors</b>\n${sectors}\n\n` +
      `<a href="${escapeHtml(appUrl("/reports"))}">Full report</a>`
    );
  },
};

const approvals: Command = {
  name: "approvals",
  description: "Decisions waiting on you",
  async handle() {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("approvals")
      .select("team, kind, title, requested_at, expires_at")
      .eq("status", "pending")
      .order("requested_at", { ascending: false })
      .limit(10);

    if (error) return `Could not read approvals: ${escapeHtml(error.message)}`;
    if (!data?.length) return "Nothing waiting on you.";

    const lines = data.map((a) => {
      const hoursLeft = Math.max(
        0,
        Math.round((new Date(a.expires_at).getTime() - Date.now()) / 3_600_000),
      );
      return `• <b>${escapeHtml(a.team)}</b> — ${escapeHtml(a.title)} (${hoursLeft}h left)`;
    });

    return (
      `<b>Waiting on you</b>\n${lines.join("\n")}\n\n` +
      `<a href="${escapeHtml(appUrl("/approvals"))}">Decide in the dashboard</a>`
    );
  },
};

/**
 * Published list rates, per million tokens. Cache reads bill at about a tenth
 * of input; writes at a premium, which is folded in below.
 *
 * Sonnet 5 carries an introductory discount to 2026-08-31, so a bill using
 * these figures reads slightly high — the right direction for an estimate.
 */
const RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Billed per search, separately from tokens. */
const WEB_SEARCH_USD = 0.01;

export type UsageRow = {
  team: string;
  purpose: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  web_searches: number;
};

export function costOf(row: UsageRow): number {
  const rate = RATES[row.model] ?? { input: 5, output: 25 };
  const perToken = (tokens: number, usdPerMillion: number) => (tokens / 1_000_000) * usdPerMillion;

  return (
    perToken(row.input_tokens, rate.input) +
    perToken(row.output_tokens, rate.output) +
    perToken(row.cache_read_tokens, rate.input * 0.1) +
    perToken(row.cache_write_tokens, rate.input * 1.25) +
    row.web_searches * WEB_SEARCH_USD
  );
}

const cost: Command = {
  name: "cost",
  description: "What the company has spent on models",
  async handle() {
    const supabase = createAdminClient();
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();

    const { data, error } = await supabase
      .from("llm_usage")
      .select("team, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, created_at")
      .gte("created_at", since);

    if (error) return `Could not read usage: ${escapeHtml(error.message)}`;
    if (!data?.length) return "No model calls recorded yet.";

    const dayAgo = Date.now() - 86_400_000;
    const rows = data as (UsageRow & { created_at: string })[];

    const byTeam = new Map<string, { day: number; week: number; calls: number; searches: number }>();
    let dayTotal = 0;
    let weekTotal = 0;

    for (const row of rows) {
      const usd = costOf(row);
      const isToday = new Date(row.created_at).getTime() >= dayAgo;

      const entry = byTeam.get(row.team) ?? { day: 0, week: 0, calls: 0, searches: 0 };
      entry.week += usd;
      entry.calls += 1;
      entry.searches += row.web_searches;
      if (isToday) entry.day += usd;
      byTeam.set(row.team, entry);

      weekTotal += usd;
      if (isToday) dayTotal += usd;
    }

    const lines = [...byTeam.entries()]
      .sort((a, b) => b[1].week - a[1].week)
      .map(([team, e]) => {
        const searches = e.searches ? `, 검색 ${e.searches}회` : "";
        return `<b>${escapeHtml(team)}</b> — 24시간 $${e.day.toFixed(2)} · 7일 $${e.week.toFixed(2)} (호출 ${e.calls}회${searches})`;
      });

    return (
      `<b>💸 모델 사용 비용</b>\n` +
      `최근 24시간 <b>$${dayTotal.toFixed(2)}</b> · 7일 <b>$${weekTotal.toFixed(2)}</b>\n` +
      `월 환산 약 $${(dayTotal * 30).toFixed(0)}\n\n` +
      `${lines.join("\n")}\n\n` +
      `<i>정가 기준 추정. Sonnet은 8/31까지 할인가라 실제는 이보다 낮습니다.</i>`
    );
  },
};

type SnapshotRow = {
  trade_date: string;
  account_realised_krw: number | null;
  realised_pnl_krw: number | null;
  by_strategy: Record<string, number>;
  capital_krw: number | null;
  total_equity_krw: number | null;
  attribution_source: string | null;
};

const money = (value: number) =>
  `${value >= 0 ? "+" : "−"}${Math.abs(Math.round(value)).toLocaleString("ko-KR")}원`;

/** The account's own figure, falling back to the per-strategy sum. */
const dayResult = (row: SnapshotRow) =>
  row.account_realised_krw ?? row.realised_pnl_krw ?? 0;

const performance: Command = {
  name: "performance",
  description: "수익률 — 기간별과 전략별",
  async handle() {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("equity_snapshots")
      .select(
        "trade_date, account_realised_krw, realised_pnl_krw, by_strategy, capital_krw, total_equity_krw, attribution_source",
      )
      .order("trade_date", { ascending: false })
      .limit(60);

    if (error) return `Could not read performance: ${escapeHtml(error.message)}`;

    const rows = (data ?? []) as SnapshotRow[];
    if (!rows.length) return "아직 기록된 세션이 없습니다. 첫 마감 이후에 나타납니다.";

    const capital = rows[0].capital_krw ?? 0;
    const cumulative = rows.reduce((sum, r) => sum + dayResult(r), 0);
    const wins = rows.filter((r) => dayResult(r) > 0).length;
    const rate = capital > 0 ? (cumulative / capital) * 100 : 0;

    // Per strategy across everything shown. Estimated on the paper account,
    // where the broker reports no fills -- said plainly rather than implied.
    const byStrategy = new Map<string, number>();
    for (const row of rows) {
      for (const [name, amount] of Object.entries(row.by_strategy ?? {})) {
        byStrategy.set(name, (byStrategy.get(name) ?? 0) + amount);
      }
    }

    const estimated = rows.every((r) => r.attribution_source === "marks");
    const latest = rows[0];

    const recent = rows
      .slice(0, 5)
      .map((r) => `${escapeHtml(r.trade_date)}  ${money(dayResult(r))}`)
      .join("\n");

    const strategies = [...byStrategy.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, amount]) => `• <b>${escapeHtml(name)}</b> ${money(amount)}`)
      .join("\n");

    return (
      `<b>📈 수익률</b>\n` +
      `누적 <b>${money(cumulative)}</b> · ${rate >= 0 ? "+" : "−"}${Math.abs(rate).toFixed(2)}%\n` +
      `${rows.length}거래일 중 ${wins}일 수익 · 자본 ${Math.round(capital).toLocaleString("ko-KR")}원\n` +
      (latest.total_equity_krw === null
        ? ""
        : `계좌 잔고 ${Math.round(latest.total_equity_krw).toLocaleString("ko-KR")}원 (${escapeHtml(latest.trade_date)} 마감)\n`) +
      `\n<b>전략별${estimated ? " (추정)" : ""}</b>\n${strategies || "기록 없음"}\n` +
      `\n<b>최근</b>\n${recent}\n\n` +
      `<a href="${escapeHtml(appUrl("/performance"))}">종목별 상세 보기</a>`
    );
  },
};

const help: Command = {
  name: "help",
  description: "This list",
  async handle() {
    const lines = REGISTRY.map((c) => `/${c.name} — ${escapeHtml(c.description)}`);
    return `<b>Commands</b>\n${lines.join("\n")}`;
  },
};

export const REGISTRY: Command[] = [status, report, performance, approvals, cost, help];

/**
 * Parse and run a message. Returns null when the text is not a command, so
 * ordinary chatter is ignored rather than answered.
 */
export async function runCommand(text: string): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  // Telegram appends @botname when a command is used in a group.
  const [word, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = word.split("@")[0].toLowerCase();

  const command = REGISTRY.find((c) => c.name === name);
  if (!command) {
    return `Unknown command <code>/${escapeHtml(name)}</code>. Try /help.`;
  }

  try {
    return await command.handle({ args: rest.join(" ") });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `<b>/${escapeHtml(name)} failed</b>\n<code>${escapeHtml(detail.slice(0, 300))}</code>`;
  }
}
