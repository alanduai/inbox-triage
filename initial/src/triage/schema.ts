import { z } from "zod";

export const URGENCIES = ["urgent", "today", "week", "fyi"] as const;
export type Urgency = (typeof URGENCIES)[number];

/** What the model returns. Strings are "" when they do not apply, so every field is always present. */
export const ModelTriage = z.object({
  title: z.string(),
  summary: z.string(),
  needs_reply: z.boolean(),
  urgency: z.enum(URGENCIES),
  urgency_score: z.number().int(),
  urgency_reason: z.string(),
  task: z.string(),
  due_date: z.string(),
  reply_by: z.string(),
  message_language: z.enum(["en", "hr", "sv", "other"]),
  suggested_reply: z.string(),
  draft_assumption: z.string(),
  ack_reply: z.string(),
});
export type ModelTriage = z.infer<typeof ModelTriage>;

const str = (description: string) => ({ type: "string", description });

/** JSON schema sent as output_config.format. Kept by hand so each field carries its instruction. */
export const TRIAGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(ModelTriage.shape),
  properties: {
    title: str("Short English title for a dashboard list, at most 80 characters."),
    summary: str("One or two English sentences on what the message says and asks."),
    needs_reply: { type: "boolean", description: "Whether Alan should send a reply (to the sender or, where routed, to his lawyer)." },
    urgency: { type: "string", enum: [...URGENCIES], description: "Urgency tier, as defined in the instructions." },
    urgency_score: { type: "integer", description: "0 to 100, higher is more urgent." },
    urgency_reason: str("One or two English sentences: the concrete reason for the tier (deadline, decision, who waits). Mention fraud signals here."),
    task: str("The action Alan needs to take, as a short English imperative. Empty if none."),
    due_date: str("Date the sender needs the action done, YYYY-MM-DD in Alan's time zone. Empty if none is stated or implied."),
    reply_by: str("Latest local time Alan should answer to be safe, YYYY-MM-DDTHH:MM. Empty if no reply is needed."),
    message_language: { type: "string", enum: ["en", "hr", "sv", "other"], description: "Language the message is written in." },
    suggested_reply: str("The full reply body for Alan to review, in the reply language, ending with the given sign-off. Empty if no reply is needed."),
    draft_assumption: str("One English sentence naming what the draft assumed or committed Alan to (a decision, a date, money, attendance), and any [bracketed] gaps. Empty if none."),
    ack_reply: str("A one or two sentence holding reply in the reply language that confirms receipt, ending with the sign-off. Empty if not appropriate."),
  },
} as const;
