import Anthropic from "@anthropic-ai/sdk";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * One structured call to Claude, shared by every team.
 *
 * Extracted from the market report once the strategy department needed the
 * same arrangement: reason in English, then translate what was concluded. The
 * schemas and prompts stay with each team -- what is shared is the mechanics
 * of asking for JSON, getting it back safely, and recording what it cost.
 */

/** Judgement calls: which stock, which idea, what the market did. */
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * Transformation rather than judgement -- translating, or writing up notes
 * from material already gathered. Sonnet is roughly 60% of Opus on both input
 * and output, and these steps do not decide anything.
 */
export const CHEAP_MODEL = "claude-sonnet-5";

export type OutputFormat = { type: "json_schema"; schema: Record<string, unknown> };

export type CompleteOptions = {
  system: string;
  user: string;
  format: OutputFormat;
  /** Recorded against the call so spending can be attributed later. */
  team: string;
  purpose: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  model?: string;
};

type UsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/**
 * Never allowed to fail the work it is measuring. A missing usage row is a
 * gap in the accounting; a thrown error here would be a lost report.
 */
export async function recordUsage(entry: {
  team: string;
  purpose: string;
  model: string;
  usage: UsageLike | undefined;
  webSearches?: number;
}): Promise<void> {
  try {
    const supabase = createAdminClient();
    await supabase.from("llm_usage").insert({
      team: entry.team,
      purpose: entry.purpose,
      model: entry.model,
      input_tokens: entry.usage?.input_tokens ?? 0,
      output_tokens: entry.usage?.output_tokens ?? 0,
      cache_read_tokens: entry.usage?.cache_read_input_tokens ?? 0,
      cache_write_tokens: entry.usage?.cache_creation_input_tokens ?? 0,
      web_searches: entry.webSearches ?? 0,
    });
  } catch (cause) {
    console.error("recordUsage failed", cause);
  }
}

/**
 * Streamed because these run long enough that a non-streaming request risks an
 * HTTP timeout well before the function's own limit.
 */
export async function complete<T>({
  system,
  user,
  format,
  team,
  purpose,
  effort = "medium",
  maxTokens = 32000,
  model = DEFAULT_MODEL,
}: CompleteOptions): Promise<T> {
  const client = new Anthropic();

  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    system,
    output_config: { effort, format },
    messages: [{ role: "user", content: user }],
  });

  const message = await stream.finalMessage();
  await recordUsage({ team, purpose, model, usage: message.usage });

  if (message.stop_reason === "refusal") {
    throw new Error("The model refused the request");
  }

  const texts = message.content.filter((block) => block.type === "text");
  const last = texts[texts.length - 1];
  if (!last || last.type !== "text") {
    throw new Error("The model returned no text content");
  }

  return JSON.parse(last.text) as T;
}
