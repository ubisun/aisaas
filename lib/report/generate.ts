import Anthropic from "@anthropic-ai/sdk";

import type { CollectedQuote } from "@/lib/market/finnhub";

export const REPORT_MODEL = "claude-opus-5";

/**
 * Generation and translation are separate calls because a single bilingual
 * request runs past the 60s Vercel ceiling on the Hobby plan. Splitting also
 * keeps English as the source of record: the model reasons once, in English,
 * and the Korean pass only restates that conclusion.
 *
 * `medium` effort is deliberate. Opus 5 is strong at it, and the higher
 * default spends thinking tokens this batch does not need -- which on a
 * 60s budget is the difference between finishing and being killed.
 */
const EFFORT = "medium" as const;

export type SectorOutlook = {
  sector: string;
  sector_ko?: string;
  direction: "positive" | "neutral" | "negative";
  confidence: "low" | "medium" | "high";
  rationale: string;
  rationale_ko?: string;
};

export type GeneratedReport = {
  us_summary: string;
  kr_sector_outlook: SectorOutlook[];
};

export type Translation = {
  us_summary_ko: string;
  sectors: { sector: string; sector_ko: string; rationale_ko: string }[];
};

const REPORT_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      us_summary: {
        type: "string",
        description:
          "Narrative summary of the US session: index moves, sector leadership and laggards, and what drove them.",
      },
      kr_sector_outlook: {
        type: "array",
        description:
          "KRX sectors most likely to be affected on the next Korean trading day.",
        items: {
          type: "object",
          properties: {
            sector: { type: "string", description: "KRX sector name." },
            direction: { type: "string", enum: ["positive", "neutral", "negative"] },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            rationale: {
              type: "string",
              description:
                "Which US move this reads from, and the transmission mechanism to the Korean sector.",
            },
          },
          required: ["sector", "direction", "confidence", "rationale"],
          additionalProperties: false,
        },
      },
    },
    required: ["us_summary", "kr_sector_outlook"],
    additionalProperties: false,
  },
};

const TRANSLATION_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      us_summary_ko: { type: "string" },
      sectors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sector: {
              type: "string",
              description: "The English sector name exactly as given, used to match rows.",
            },
            sector_ko: {
              type: "string",
              description:
                "The sector name as Korean market coverage writes it (e.g. 반도체, 2차전지), not a literal translation.",
            },
            rationale_ko: { type: "string" },
          },
          required: ["sector", "sector_ko", "rationale_ko"],
          additionalProperties: false,
        },
      },
    },
    required: ["us_summary_ko", "sectors"],
    additionalProperties: false,
  },
};

const REPORT_PROMPT = `You write a daily market brief for readers who trade the Korean market and need to be caught up on the US session before KRX opens.

You are given the closing quotes for the US benchmarks and the eleven GICS sector ETFs. Work only from those numbers -- do not invent prices, volumes, or news events you were not given. Where a move needs an explanation you do not have, say the move happened and that the cause is not established from this data.

For the sector outlook, reason about transmission rather than analogy: which Korean sectors are exposed to the US moves in the data, through supply chains, shared demand, or index-level correlation. Rank confidence honestly -- most single-session signals are weak, and "low" is the right answer more often than not. A sector belongs in the list only if you can state the mechanism.

This is a market summary and a reasoned projection, not investment advice, and it should read as such.`;

const TRANSLATION_PROMPT = `You translate a US market brief into Korean for readers who trade the Korean market.

Translate, do not re-analyse. The English is the source of record: every claim, hedge and confidence level must survive intact, and you must not add a caveat, drop one, or introduce a sector that is not in the input.

Write in the register a Korean brokerage note uses, not word-for-word English. Use the sector names Korean coverage actually uses. Keep tickers, index names, percentages and dates in their original form.

Return one entry per sector you were given, echoing the English sector name unchanged so the rows can be matched.`;

function formatQuotes(quotes: CollectedQuote[]): string {
  const line = (q: CollectedQuote) =>
    `${q.label} (${q.symbol}): close ${q.close.toFixed(2)}, previous ${q.previousClose.toFixed(2)}, change ${q.changePct.toFixed(2)}%`;

  const indices = quotes.filter((q) => q.kind === "index").map(line);
  const sectors = quotes.filter((q) => q.kind === "sector").map(line);

  return `Benchmarks:\n${indices.join("\n")}\n\nSectors:\n${sectors.join("\n")}`;
}

type OutputFormat = { type: "json_schema"; schema: Record<string, unknown> };

async function complete<T>(
  system: string,
  user: string,
  format: OutputFormat,
): Promise<T> {
  const client = new Anthropic();

  const stream = client.messages.stream({
    model: REPORT_MODEL,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    system,
    output_config: { effort: EFFORT, format },
    messages: [{ role: "user", content: user }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("The model refused the request");
  }

  const text = message.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("The model returned no text content");
  }

  return JSON.parse(text.text) as T;
}

export async function generateReport(
  sessionDate: string,
  quotes: CollectedQuote[],
): Promise<GeneratedReport> {
  return complete<GeneratedReport>(
    REPORT_PROMPT,
    `US trading session of ${sessionDate}.\n\n${formatQuotes(quotes)}`,
    REPORT_FORMAT,
  );
}

export async function translateReport(report: GeneratedReport): Promise<Translation> {
  return complete<Translation>(
    TRANSLATION_PROMPT,
    JSON.stringify(
      {
        us_summary: report.us_summary,
        sectors: report.kr_sector_outlook.map((s) => ({
          sector: s.sector,
          rationale: s.rationale,
        })),
      },
      null,
      2,
    ),
    TRANSLATION_FORMAT,
  );
}
