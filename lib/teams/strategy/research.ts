import { CHEAP_MODEL, complete, recordUsage } from "@/lib/llm";

/**
 * What a meeting produces, and what the filing is written from.
 *
 * The department's job is to find business models a company of one person and
 * a set of agents could actually charge for -- so the research is pointed at
 * what people are being paid for now, not at what sounds plausible.
 */

export type MeetingNotes = {
  findings: {
    what: string;
    who: string;
    evidence: string;
    source: string;
    relevance: string;
  }[];
  /** How the idea moved because of this meeting. */
  development: string;
  /** What to look into next time. */
  open_questions: string[];
};

export type IdeaDraft = {
  title: string;
  summary: string;
  detail: {
    model: string;
    customer: string;
    why_now: string;
    what_it_takes: string;
    revenue: string;
    risks: string;
    first_test: string;
    /** What would have to be true for this to work, stated so it can be checked. */
    assumptions: string[];
  };
};

export type IdeaTranslation = {
  title_ko: string;
  summary_ko: string;
  detail_ko: {
    model: string;
    customer: string;
    why_now: string;
    what_it_takes: string;
    revenue: string;
    risks: string;
    first_test: string;
    assumptions: string[];
  };
};

const MEETING_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        description: "Concrete things found this session. Empty if nothing new turned up.",
        items: {
          type: "object",
          properties: {
            what: { type: "string", description: "The business or tactic, in a sentence." },
            who: { type: "string", description: "Who is doing it." },
            evidence: {
              type: "string",
              description:
                "What indicates it actually earns — stated revenue, pricing, customer count. Say so plainly if the evidence is only a claim.",
            },
            source: { type: "string", description: "Where this came from." },
            relevance: {
              type: "string",
              description: "What a one-person-plus-agents company could take from it.",
            },
          },
          required: ["what", "who", "evidence", "source", "relevance"],
          additionalProperties: false,
        },
      },
      development: {
        type: "string",
        description:
          "How the idea under development moved as a result. If it did not move, say that.",
      },
      open_questions: {
        type: "array",
        items: { type: "string" },
        description: "What the next meeting should resolve.",
      },
    },
    required: ["findings", "development", "open_questions"],
    additionalProperties: false,
  },
};

const IDEA_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short and concrete. Not a slogan." },
      summary: {
        type: "string",
        description: "What the business is and why it could work, in a short paragraph.",
      },
      detail: {
        type: "object",
        properties: {
          model: { type: "string", description: "What is sold, and how it is delivered." },
          customer: { type: "string", description: "Who pays, and what they are buying instead today." },
          why_now: { type: "string", description: "What changed that makes this possible now." },
          what_it_takes: {
            type: "string",
            description:
              "What the company would have to build or do — honestly, including the parts agents cannot do.",
          },
          revenue: { type: "string", description: "Pricing and a grounded first-year estimate." },
          risks: { type: "string", description: "What most likely kills it." },
          first_test: {
            type: "string",
            description: "The cheapest thing that would show whether this is real, and what result would settle it.",
          },
          assumptions: {
            type: "array",
            items: { type: "string" },
            description: "What must be true, stated so each could be checked.",
          },
        },
        required: [
          "model",
          "customer",
          "why_now",
          "what_it_takes",
          "revenue",
          "risks",
          "first_test",
          "assumptions",
        ],
        additionalProperties: false,
      },
    },
    required: ["title", "summary", "detail"],
    additionalProperties: false,
  },
};

const TRANSLATION_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      title_ko: { type: "string" },
      summary_ko: { type: "string" },
      detail_ko: {
        type: "object",
        properties: {
          model: { type: "string" },
          customer: { type: "string" },
          why_now: { type: "string" },
          what_it_takes: { type: "string" },
          revenue: { type: "string" },
          risks: { type: "string" },
          first_test: { type: "string" },
          assumptions: { type: "array", items: { type: "string" } },
        },
        required: [
          "model",
          "customer",
          "why_now",
          "what_it_takes",
          "revenue",
          "risks",
          "first_test",
          "assumptions",
        ],
        additionalProperties: false,
      },
    },
    required: ["title_ko", "summary_ko", "detail_ko"],
    additionalProperties: false,
  },
};

const CONTEXT = `The company is one person — the CEO — and a set of agents that already run unattended: a daily market report, an automated paper-trading desk, a scheduler, a queue and an approval channel. It can build and operate software without hiring. It cannot do anything requiring a team, a licence it does not hold, physical presence, or capital it does not have.`;

const MEETING_PROMPT = `You research business models for a company that is one person and a set of AI agents.

${CONTEXT}

Search for what people are actually being paid for right now — individuals and very small teams earning real money with AI, in the last few months. Prefer specifics over commentary: a price, a customer count, a revenue figure, a concrete offer. Ignore posts that only describe an opportunity in the abstract, and ignore anyone whose product is teaching others how to make money with AI, which is a different business from the one being described.

Be sceptical about evidence. A screenshot and a claim are not revenue. Say plainly what is verified and what is only asserted — a finding whose evidence is weak is still worth recording, as long as it is labelled.

Your job in this meeting is to move one idea forward, not to collect a list. If the search changed your view, say how. If it did not, say that rather than inventing progress.`;

const IDEA_PROMPT = `You file one business idea a day for a company that is one person and a set of AI agents.

${CONTEXT}

Write the idea you would actually defend. It should be something this company could start testing within a week, not a strategy that needs a team or a funding round. Be concrete about what is sold and who pays; "an AI-powered platform for X" is not an idea.

Be honest about the parts that are hard, including the ones agents cannot do — distribution, trust, and anything needing a human name attached. The CEO is going to reply to this, and the useful reply comes from a proposal that already admits its weak points.

Ground the numbers. A revenue estimate that assumes a conversion rate nobody has measured is worse than saying you do not know what the conversion rate is.

The first test matters most. Name the cheapest thing that would show whether this is real, and say what result would settle it either way.`;

const TRANSLATION_PROMPT = `You translate a business proposal into Korean for the CEO who will act on it.

Translate, do not re-argue. Every claim, hedge and number must survive intact; do not add a caveat, drop one, or improve the argument.

Write the register a Korean strategy memo uses, not word-for-word English. Keep product names, company names and figures in their original form. Where an English term is normally used untranslated in Korean business writing, leave it.`;

/**
 * A meeting is two calls, not one.
 *
 * Searching and then writing up the result in a single request runs past the
 * 60s function ceiling -- measured, not guessed: the first attempt timed out
 * with the search still going. Splitting keeps each half inside the budget and
 * has the useful side effect that the raw search output is preserved
 * separately from the conclusions drawn about it.
 */
export async function searchForEvidence(user: string): Promise<string> {
  const client = new (await import("@anthropic-ai/sdk")).default();

  const stream = client.messages.stream({
    model: "claude-opus-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: MEETING_PROMPT,
    // Effort is deliberately left at its default. `low` was tried first and
    // the searches came back malformed -- lower effort consolidates tool calls,
    // which does not suit a search that needs several distinct queries.
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
    messages: [
      {
        role: "user",
        content: `${user}\n\nSearch now and report what you found in plain prose. Do not draw conclusions yet -- just what you found, who is doing it, what the evidence is, and where it came from. Say explicitly where the evidence is only a claim.`,
      },
    ],
  });

  const message = await stream.finalMessage();

  // Searches are billed per use, separately from tokens, so count what was
  // actually issued rather than trusting max_uses -- the model often uses
  // fewer than it is allowed.
  const webSearches = message.content.filter(
    (block) => block.type === "web_search_tool_result",
  ).length;

  await recordUsage({
    team: "strategy",
    purpose: "search",
    model: "claude-opus-5",
    usage: message.usage,
    webSearches,
  });

  const texts = message.content.filter((block) => block.type === "text");
  return texts.map((block) => (block.type === "text" ? block.text : "")).join("\n\n");
}

export async function holdMeeting(user: string, searchOutput: string): Promise<MeetingNotes> {
  return complete<MeetingNotes>({
    system: MEETING_PROMPT,
    user: `${user}\n\nWhat this meeting's search turned up:\n\n${searchOutput}`,
    format: MEETING_FORMAT,
    team: "strategy",
    purpose: "notes",
    // Writing up material already gathered is transformation, not judgement.
    model: CHEAP_MODEL,
    maxTokens: 32000,
  });
}

export async function draftIdea(user: string): Promise<IdeaDraft> {
  return complete<IdeaDraft>({
    system: IDEA_PROMPT,
    user,
    format: IDEA_FORMAT,
    team: "strategy",
    purpose: "draft",
    maxTokens: 32000,
  });
}

export async function translateIdea(draft: IdeaDraft): Promise<IdeaTranslation> {
  return complete<IdeaTranslation>({
    system: TRANSLATION_PROMPT,
    user: JSON.stringify(draft, null, 2),
    format: TRANSLATION_FORMAT,
    team: "strategy",
    purpose: "translate",
    model: CHEAP_MODEL,
    maxTokens: 32000,
  });
}
