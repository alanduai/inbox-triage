import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { LoadedConfig } from "../config.js";

export class ExpenseClaudeError extends Error {
  constructor(
    message: string,
    readonly kind: "refusal" | "truncated" | "invalid" | "api",
  ) {
    super(message);
  }
}

export type UserContent = string | Anthropic.Beta.BetaContentBlockParam[];

/**
 * One Claude call whose answer must match a JSON schema. Same settings as the triage: on a safety
 * decline the API re-runs the request on Anthropic's recommended fallback model.
 */
export async function structuredCall<T>(
  client: Anthropic,
  cfg: LoadedConfig,
  opts: { system: string; content: UserContent; jsonSchema: Record<string, unknown>; zod: z.ZodType<T>; what: string },
): Promise<{ result: T; model: string }> {
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: cfg.claude.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: cfg.claude.effort, format: { type: "json_schema", schema: opts.jsonSchema } },
      system: opts.system,
      messages: [{ role: "user", content: opts.content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw new ExpenseClaudeError(`Claude API ${err.status ?? ""}: ${err.message}`, "api");
    throw err;
  }
  if (response.stop_reason === "refusal") {
    throw new ExpenseClaudeError(`Claude declined to ${opts.what} (category: ${response.stop_details?.category ?? "unspecified"})`, "refusal");
  }
  if (response.stop_reason === "max_tokens") throw new ExpenseClaudeError(`Claude's answer was cut off while trying to ${opts.what}`, "truncated");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ExpenseClaudeError(`Claude's answer was not valid JSON (${opts.what})`, "invalid");
  }
  const parsed = opts.zod.safeParse(json);
  if (!parsed.success) throw new ExpenseClaudeError(`Claude's answer did not match the schema (${opts.what}): ${parsed.error.issues[0]?.message ?? ""}`, "invalid");
  return { result: parsed.data, model: response.model };
}

/** Keeps untrusted text from closing or opening the tags that mark it as data. */
export function escapeTags(text: string, tags: string[]): string {
  const re = new RegExp(`<(/?)(${tags.join("|")})\\b`, "gi");
  return text.replace(re, "&lt;$1$2");
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... ${text.length - max} more characters not shown]`;
}
