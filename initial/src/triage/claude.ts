import Anthropic from "@anthropic-ai/sdk";
import type { LoadedConfig } from "../config.js";
import { ModelTriage, TRIAGE_JSON_SCHEMA, type Urgency } from "./schema.js";
import { systemPrompt, userContent, type TriageInput } from "./prompt.js";

export class TriageError extends Error {
  constructor(
    message: string,
    readonly kind: "refusal" | "truncated" | "invalid" | "api",
  ) {
    super(message);
  }
}

export interface Triage extends ModelTriage {
  review_required: boolean;
  always_urgent: boolean;
  model: string;
}

export async function callClaude(client: Anthropic, cfg: LoadedConfig, input: TriageInput): Promise<{ result: ModelTriage; model: string }> {
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: cfg.claude.model,
      max_tokens: 16000,
      // On a safety decline the API re-runs the request on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: cfg.claude.effort, format: { type: "json_schema", schema: TRIAGE_JSON_SCHEMA } },
      system: systemPrompt(cfg.owner.name),
      messages: [{ role: "user", content: userContent(input) }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw new TriageError(`Claude API ${err.status ?? ""}: ${err.message}`, "api");
    throw err;
  }

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "unspecified";
    throw new TriageError(`Claude declined to triage this message (category: ${category}). Triage it by hand.`, "refusal");
  }
  if (response.stop_reason === "max_tokens") throw new TriageError("Claude's answer was cut off at max_tokens", "truncated");

  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TriageError("Claude's answer was not valid JSON", "invalid");
  }
  const parsed = ModelTriage.safeParse(json);
  if (!parsed.success) throw new TriageError(`Claude's answer did not match the schema: ${parsed.error.issues[0]?.message ?? ""}`, "invalid");
  return { result: parsed.data, model: response.model };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Fixed rules applied after the model, so they hold whatever the model wrote:
 * review-required senders get no acknowledgement, always-urgent senders are raised to urgent,
 * malformed dates are dropped, and every draft ends with the configured sign-off.
 */
export function finalize(
  result: ModelTriage,
  opts: { reviewRequired: boolean; alwaysUrgent: boolean; signOff: string; model: string },
): Triage {
  const t: Triage = { ...result, review_required: opts.reviewRequired, always_urgent: opts.alwaysUrgent, model: opts.model };
  t.urgency_score = Math.max(0, Math.min(100, Math.round(t.urgency_score)));
  if (!DATE.test(t.due_date)) t.due_date = "";
  if (!DATETIME.test(t.reply_by)) t.reply_by = "";
  t.title = t.title.trim().slice(0, 120) || "(untitled)";

  if (!t.needs_reply) {
    t.suggested_reply = "";
    t.ack_reply = "";
    t.draft_assumption = "";
    if (t.urgency !== "fyi" && !t.task) t.urgency = "fyi";
  }
  if (opts.reviewRequired) t.ack_reply = "";

  if (opts.alwaysUrgent && t.needs_reply && t.urgency !== "urgent") {
    t.urgency = "urgent" as Urgency;
    t.urgency_score = Math.max(t.urgency_score, 80);
    t.urgency_reason = `${t.urgency_reason} Raised to urgent: this sender is always urgent.`.trim();
  }

  t.suggested_reply = withSignOff(t.suggested_reply, opts.signOff);
  t.ack_reply = withSignOff(t.ack_reply, opts.signOff);
  return t;
}

export function withSignOff(text: string, signOff: string): string {
  const body = text.trimEnd();
  if (!body) return "";
  const firstLine = signOff.split("\n")[0]?.trim() ?? "";
  const tail = body.slice(-Math.max(200, signOff.length + 40));
  if (firstLine && tail.includes(firstLine)) return body;
  return `${body}\n\n${signOff}`;
}

/** True while a draft still holds [bracketed] gaps that only the owner can fill. */
export function hasPlaceholders(text: string): boolean {
  return /\[[^\]\n]{1,80}\]/.test(text);
}
