import Anthropic from "@anthropic-ai/sdk";

import type { CollectedQuote } from "@/lib/market/finnhub";

export const REPORT_MODEL = "claude-opus-5";

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
  us_summary_ko: string;
  kr_sector_outlook: SectorOutlook[];
};

/**
 * Structured output schema. Constraining the response means the worker can
 * write straight to Postgres without parsing prose, and the rationale field
 * forces every sector call to carry its reasoning rather than a bare verdict.
 */
const REPORT_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      us_summary: {
        type: "string",
        description:
          "Narrative summary of the US session in English: index moves, sector leadership and laggards, and what drove them.",
      },
      us_summary_ko: {
        type: "string",
        description:
          "Korean translation of us_summary. Same content and structure, written as native Korean market commentary rather than a literal rendering.",
      },
      kr_sector_outlook: {
        type: "array",
        description:
          "KRX sectors most likely to be affected on the next Korean trading day.",
        items: {
          type: "object",
          properties: {
            sector: { type: "string", description: "KRX sector name in English." },
            sector_ko: {
              type: "string",
              description:
                "The sector name as it is normally written in Korean market coverage (e.g. 반도체, 2차전지), not a literal translation of the English.",
            },
            direction: {
              type: "string",
              enum: ["positive", "neutral", "negative"],
            },
            confidence: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
            rationale: {
              type: "string",
              description:
                "Which US move this reads from, and the transmission mechanism to the Korean sector, in English.",
            },
            rationale_ko: {
              type: "string",
              description: "Korean translation of rationale.",
            },
          },
          required: [
            "sector",
            "sector_ko",
            "direction",
            "confidence",
            "rationale",
            "rationale_ko",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["us_summary", "kr_sector_outlook"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You write a daily market brief for readers who trade the Korean market and need to be caught up on the US session before KRX opens.

You are given the closing quotes for the US benchmarks and the eleven GICS sector ETFs. Work only from those numbers -- do not invent prices, volumes, or news events you were not given. Where a move needs an explanation you do not have, say the move happened and that the cause is not established from this data.

For the sector outlook, reason about transmission rather than analogy: which Korean sectors are exposed to the US moves in the data, through supply chains, shared demand, or index-level correlation. Rank confidence honestly -- most single-session signals are weak, and "low" is the right answer more often than not. A sector belongs in the list only if you can state the mechanism.

This is a market summary and a reasoned projection, not investment advice, and it should read as such.

Write every field in English first, then supply the Korean. Reason in English -- it is the source of record. The Korean is a translation of what you concluded, not a second pass at the analysis, so the two must agree; do not add a caveat or a sector to one and not the other. Write the Korean as native market commentary in the register a Korean brokerage note would use, with the sector names Korean coverage actually uses, rather than translating the English word by word. Keep tickers, index names and numbers in their original form.`;

function formatQuotes(quotes: CollectedQuote[]): string {
  const line = (q: CollectedQuote) =>
    `${q.label} (${q.symbol}): close ${q.close.toFixed(2)}, previous ${q.previousClose.toFixed(2)}, change ${q.changePct.toFixed(2)}%`;

  const indices = quotes.filter((q) => q.kind === "index").map(line);
  const sectors = quotes.filter((q) => q.kind === "sector").map(line);

  return `Benchmarks:\n${indices.join("\n")}\n\nSectors:\n${sectors.join("\n")}`;
}

export async function generateReport(
  sessionDate: string,
  quotes: CollectedQuote[],
): Promise<GeneratedReport> {
  const client = new Anthropic();

  // Streamed because the combined summary and per-sector rationales run long
  // enough that a non-streaming request risks an HTTP timeout.
  const stream = client.messages.stream({
    model: REPORT_MODEL,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    output_config: { format: REPORT_FORMAT },
    messages: [
      {
        role: "user",
        content: `US trading session of ${sessionDate}.\n\n${formatQuotes(quotes)}`,
      },
    ],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("Report generation was refused by the model");
  }

  const text = message.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("Report generation returned no text content");
  }

  return JSON.parse(text.text) as GeneratedReport;
}
