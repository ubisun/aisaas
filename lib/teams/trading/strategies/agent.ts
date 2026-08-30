import Anthropic from "@anthropic-ai/sdk";

import { recordUsage } from "@/lib/llm";

import type { Strategy, StrategyProposal, TickContext } from "../types";

/**
 * The model-driven strategy.
 *
 * It only ever proposes entries. Exits are the risk gate's business -- the
 * stop, the ladder and the give-back are not opinions to be weighed, so
 * offering them here would only invite the model to argue with them.
 *
 * The prompt is written around one idea: doing nothing is the default. Five
 * entries is a budget, not a target, and a strategy that trades because it has
 * room left is worse than one that sits out.
 */

const MODEL = "claude-opus-5";

const SYSTEM = `You trade the Korean market intraday, in the first ninety minutes of the session.

You are given: an overnight read on the US session and which KRX sectors it may move, and a shortlist of stocks that are being traded heavily this morning relative to their market capitalisation. You decide whether any of them is worth buying right now.

Your bias is to do nothing. The entry budget is a ceiling, not a quota — a day with no trades is a good day if nothing met the bar, and there is no credit for using the budget. Only propose a buy when you can say what specifically makes this stock likely to continue higher over the next hour, in this session, from what you were given. "It is up and busy" is not that; every name on the shortlist is up and busy.

Things worth weighing:
- Whether the move fits the overnight sector read, and how much confidence that read carried. A low-confidence sector view is thin support.
- Turnover against market capitalisation: a large number on a small company means something a large company's does not.
- How much of the entry window is left. Late entries have less time to work before everything is closed at 10:30, so the bar rises as the morning goes on.
- What is already held. Concentration is a risk you own.

Do not propose sells. Stops, profit-taking and the end-of-window close are handled outside your control and will happen regardless of what you think.

Position sizing: whole shares, and the order value must stay under the stated per-order cap. Work it out from the price you were given.

Be brief and concrete in every reason. It is the record someone reads months later to work out whether this was skill or luck, so write what you actually concluded, including your uncertainty. Never invent a ticker: propose only from the shortlist.`;

const FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      reasoning: {
        type: "string",
        description:
          "What you make of this tick overall, including why you are not buying anything if that is the case.",
      },
      orders: {
        type: "array",
        description: "Buys to place now. Empty is a valid and often correct answer.",
        items: {
          type: "object",
          properties: {
            ticker: { type: "string", description: "Six-digit code from the shortlist." },
            quantity: { type: "integer", description: "Whole shares." },
            reason: {
              type: "string",
              description:
                "What specifically makes this likely to continue higher this session. One or two sentences.",
            },
          },
          required: ["ticker", "quantity", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["reasoning", "orders"],
    additionalProperties: false,
  },
};

function describe(context: TickContext): string {
  const outlook = context.sectorOutlook.length
    ? context.sectorOutlook
        .map(
          (s) =>
            `- ${s.sector}: ${s.direction} (confidence ${s.confidence}) — ${s.rationale}`,
        )
        .join("\n")
    : "- none available";

  const candidates = context.candidates
    .map(
      (c) =>
        `- ${c.name} (${c.ticker}): ${c.price.toLocaleString()} KRW, ${c.changePct >= 0 ? "+" : ""}${c.changePct.toFixed(2)}% today, turnover ${Math.round(c.turnover / 100_000_000).toLocaleString()}억 = ${c.turnoverToMarketCapPct.toFixed(2)}% of market cap`,
    )
    .join("\n");

  const positions = context.positions.length
    ? context.positions
        .map(
          (p) =>
            `- ${p.name} (${p.ticker}): ${p.quantity} shares at ${p.averagePrice.toLocaleString()}, now ${p.currentPrice.toLocaleString()} (${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(2)}%)`,
        )
        .join("\n")
    : "- none";

  return `Time: ${context.observedAt} KST on ${context.tradeDate}. ${context.minutesToLastEntry} minutes until entries close; everything is sold at 10:30 regardless.

Overnight US read, by KRX sector:
${outlook}

Shortlist (heavily traded this morning relative to size):
${candidates}

Currently held:
${positions}

Budget: ${context.entriesUsed} of ${context.entryBudget} entries used. No single order above ${context.maxOrderValueKrw.toLocaleString()} KRW. Each name may be bought once a day only, and the shortlist already excludes anything another desk has taken.`;
}

export const agentStrategy: Strategy = {
  name: "agent-v1",
  description: "Opus 5 reading the overnight report against the morning's turnover leaders",

  async propose(context: TickContext): Promise<StrategyProposal> {
    // Nothing to buy into, or no budget left: skip the call rather than pay
    // for a model round trip that can only answer "no".
    if (!context.candidates.length || context.entriesUsed >= context.entryBudget) {
      return {
        orders: [],
        reasoning: context.candidates.length
          ? "Entry budget already spent."
          : "No candidate passed the morning screen.",
      };
    }

    const client = new Anthropic();
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM,
      output_config: { effort: "medium", format: FORMAT },
      messages: [{ role: "user", content: describe(context) }],
    });

    const message = await stream.finalMessage();
    await recordUsage({ team: "trading", purpose: "tick", model: MODEL, usage: message.usage });

    if (message.stop_reason === "refusal") {
      return { orders: [], reasoning: "The model declined to answer; no orders placed." };
    }

    const text = message.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") {
      return { orders: [], reasoning: "The model returned no usable output; no orders placed." };
    }

    const parsed = JSON.parse(text.text) as {
      reasoning: string;
      orders: { ticker: string; quantity: number; reason: string }[];
    };

    return {
      reasoning: parsed.reasoning,
      orders: parsed.orders.map((order) => ({
        ticker: order.ticker,
        side: "buy" as const,
        quantity: order.quantity,
        reason: order.reason,
      })),
    };
  },
};
