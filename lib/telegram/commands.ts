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

const help: Command = {
  name: "help",
  description: "This list",
  async handle() {
    const lines = REGISTRY.map((c) => `/${c.name} — ${escapeHtml(c.description)}`);
    return `<b>Commands</b>\n${lines.join("\n")}`;
  },
};

export const REGISTRY: Command[] = [status, report, help];

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
