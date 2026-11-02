import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { gmail_v1 } from "@googleapis/gmail";
import type { ThreadMeta } from "../src/gmail/client.js";
import { parseMessage, type AttachmentRef, type ParsedMessage } from "../src/gmail/parse.js";
import type { MailboxApi } from "../src/expenses/types.js";
import { b64url, tempDir, testConfig } from "./helpers.js";

export const PDF = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);

export interface RawAttachment {
  filename: string;
  mimeType?: string;
  data: Buffer;
}

let seq = 0;
export function hexId(): string {
  seq++;
  return (0x19a0000000000000n + BigInt(seq)).toString(16);
}

/** A Gmail API message, as messages.get returns it. */
export function gmailRaw(o: {
  id?: string;
  threadId?: string;
  from: string;
  to?: string;
  subject: string;
  text?: string;
  html?: string;
  at: number;
  labels?: string[];
  attachments?: RawAttachment[];
  messageId?: string;
  references?: string;
}) {
  const id = o.id ?? hexId();
  const parts: gmail_v1.Schema$MessagePart[] = [];
  if (o.text !== undefined) parts.push({ mimeType: "text/plain", body: { data: b64url(o.text) } });
  if (o.html !== undefined) parts.push({ mimeType: "text/html", body: { data: b64url(o.html) } });
  for (const [i, a] of (o.attachments ?? []).entries()) {
    parts.push({
      mimeType: a.mimeType ?? "application/pdf",
      filename: a.filename,
      headers: [{ name: "Content-Disposition", value: `attachment; filename="${a.filename}"` }],
      body: { attachmentId: `att-${id}-${i}`, size: a.data.length },
    });
  }
  return {
    id,
    threadId: o.threadId ?? id,
    internalDate: String(o.at),
    labelIds: o.labels ?? ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: o.from },
        { name: "To", value: o.to ?? "Alan <me@example.com>" },
        { name: "Subject", value: o.subject },
        { name: "Message-ID", value: o.messageId ?? `<${id}@mail.example>` },
        ...(o.references ? [{ name: "References", value: o.references }] : []),
        { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=example" },
      ],
      parts,
    },
  };
}

/**
 * A mailbox in memory. Search understands the parts of Gmail's syntax the agent uses: from: and
 * -from:/-to:, after:/before: in epoch seconds, {a b} alternatives and quoted words.
 */
export class FakeMailbox implements MailboxApi {
  messages = new Map<string, ParsedMessage>();
  data = new Map<string, Buffer>();
  extraMeta = new Map<string, ThreadMeta[]>();
  queries: string[] = [];
  drafts = new Map<string, { raw: Buffer; threadId: string; messageId: string }>();
  creates = 0;
  updates = 0;

  add(raw: ReturnType<typeof gmailRaw>, attachments: RawAttachment[] = []): ParsedMessage {
    const m = parseMessage(raw);
    this.messages.set(m.id, m);
    m.attachments.forEach((ref, i) => this.data.set(ref.attachmentId!, attachments[i]!.data));
    return m;
  }

  addMail(o: Parameters<typeof gmailRaw>[0]): ParsedMessage {
    return this.add(gmailRaw(o), o.attachments ?? []);
  }

  sent(threadId: string, at: number, to: string): void {
    const list = this.extraMeta.get(threadId) ?? [];
    list.push({ id: hexId(), internalDate: new Date(at), labelIds: ["SENT"], fromEmail: "me@example.com", recipients: [to] });
    this.extraMeta.set(threadId, list);
  }

  async listIds(query: string): Promise<{ ids: string[]; truncated: boolean }> {
    this.queries.push(query);
    const ids = [...this.messages.values()].filter((m) => matches(m, query)).sort((a, b) => b.internalDate.getTime() - a.internalDate.getTime()).map((m) => m.id);
    return { ids, truncated: false };
  }

  async message(id: string): Promise<ParsedMessage> {
    const m = this.messages.get(id);
    if (!m) throw new Error(`no message ${id}`);
    return m;
  }

  async threadMeta(id: string): Promise<ThreadMeta[]> {
    const own = [...this.messages.values()]
      .filter((m) => m.threadId === id)
      .map((m) => ({ id: m.id, internalDate: m.internalDate, labelIds: m.labelIds, fromEmail: m.from.email, recipients: [...m.to, ...m.cc].map((a) => a.email) }));
    return [...own, ...(this.extraMeta.get(id) ?? [])];
  }

  async attachment(_messageId: string, ref: AttachmentRef): Promise<Buffer> {
    const d = this.data.get(ref.attachmentId ?? "");
    if (!d) throw new Error(`no attachment ${ref.filename}`);
    return d;
  }

  async createDraft(raw: Buffer, threadId: string) {
    this.creates++;
    const id = `r-${this.drafts.size + 1}`;
    const messageId = hexId();
    this.drafts.set(id, { raw, threadId, messageId });
    return { id, messageId };
  }

  async updateDraft(id: string, raw: Buffer, threadId: string) {
    this.updates++;
    const messageId = hexId();
    this.drafts.set(id, { raw, threadId, messageId });
    return { id, messageId };
  }

  async draftExists(id: string) {
    return this.drafts.has(id);
  }
}

function tokens(q: string): string[] {
  const out: string[] = [];
  const re = /-?\{[^}]*\}|-?"[^"]*"|\S+/g;
  for (const m of q.matchAll(re)) out.push(m[0]);
  return out;
}

function term(m: ParsedMessage, t: string): boolean {
  const hay = `${m.from.name} ${m.from.email} ${m.subject} ${m.text} ${m.attachments.map((a) => a.filename).join(" ")}`.toLowerCase();
  if (t.startsWith("from:")) return m.from.email.toLowerCase().includes(t.slice(5).toLowerCase());
  if (t.startsWith("to:")) return m.to.some((a) => a.email.toLowerCase() === t.slice(3).toLowerCase());
  if (t.startsWith("after:")) return m.internalDate.getTime() / 1000 >= Number(t.slice(6));
  if (t.startsWith("before:")) return m.internalDate.getTime() / 1000 < Number(t.slice(7));
  if (t.startsWith("in:")) return t === "in:drafts" ? m.labelIds.includes("DRAFT") : false;
  return hay.includes(t.replace(/^"|"$/g, "").toLowerCase());
}

function matches(m: ParsedMessage, q: string): boolean {
  return tokens(q).every((t) => {
    const neg = t.startsWith("-");
    const body = neg ? t.slice(1) : t;
    const ok = body.startsWith("{") ? tokens(body.slice(1, -1)).some((x) => term(m, x)) : term(m, body);
    return neg ? !ok : ok;
  });
}

type Responder = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Record<string, unknown> | Error;

/** A Claude client that answers by request kind: the extraction or the receipt match. */
export function fakeClaude(handlers: { extract?: Responder; choose?: Responder }) {
  const calls: { kind: string; params: Anthropic.Beta.MessageCreateParamsNonStreaming }[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
          const system = String(params.system ?? "");
          const kind = system.includes("decide whether a message is such a request") ? "extract" : system.includes("match company expenses") ? "choose" : "other";
          calls.push({ kind, params });
          const h = kind === "extract" ? handlers.extract : kind === "choose" ? handlers.choose : undefined;
          if (!h) throw new Error(`no fake answer for ${kind}`);
          const answer = h(params);
          if (answer instanceof Error) {
            return { model: "claude-opus-5-5", stop_reason: "refusal", stop_details: { category: "test" }, content: [] };
          }
          return { model: "claude-opus-5-5", stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify(answer) }] };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

/** The text of the user content Claude received, whatever its shape. */
export function userText(params: Anthropic.Beta.MessageCreateParamsNonStreaming): string {
  const c = params.messages[0]?.content;
  if (typeof c === "string") return c;
  return (c ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
}

export function expensesConfig(overrides: Record<string, unknown> = {}) {
  const receiptsDir = path.join(tempDir("receipts-"), "Računi");
  const cfg = testConfig({
    dataDir: tempDir("data-"),
    expenses: {
      accountant: { name: "Ivana Nikolić", emails: ["ivana@racunovodstvo.example"] },
      receiptsDir,
      gmail: { account: "me@example.com" },
      notify: { macos: false },
      ...overrides,
    },
  });
  // testConfig resolves dataDir against /tmp/inbox-triage-test; tempDir is absolute, so it is used as is.
  fs.mkdirSync(cfg.dataDirAbs, { recursive: true });
  return cfg;
}

/** Splits a raw MIME message into headers and decoded parts, enough to check a draft. */
export function parseMime(raw: Buffer): { headers: Record<string, string>; text: string; files: { filename: string; type: string; data: Buffer }[] } {
  const s = raw.toString("utf8");
  const [head, ...rest] = s.split("\r\n\r\n");
  const headers: Record<string, string> = {};
  for (const line of (head ?? "").replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const boundary = headers["content-type"]?.match(/boundary="([^"]+)"/)?.[1];
  const body = rest.join("\r\n\r\n");
  const files: { filename: string; type: string; data: Buffer }[] = [];
  let text = "";
  const parts = boundary ? body.split(`--${boundary}`).slice(1, -1) : [`${head}\r\n\r\n${body}`];
  for (const p of parts) {
    const [ph, ...pb] = p.replace(/^\r\n/, "").split("\r\n\r\n");
    const h = (ph ?? "").replace(/\r\n[ \t]+/g, " ");
    const data = Buffer.from(pb.join("\r\n\r\n").replace(/\s+/g, ""), "base64");
    const star = h.match(/filename\*=UTF-8''([^;\r\n]+)/)?.[1];
    const plain = h.match(/filename="([^"]+)"/)?.[1];
    const type = h.match(/Content-Type: ([^;\r\n]+)/i)?.[1] ?? "";
    if (/Content-Disposition: attachment/i.test(h)) files.push({ filename: star ? decodeURIComponent(star) : (plain ?? ""), type, data });
    else if (/text\/plain/i.test(h)) text = data.toString("utf8");
  }
  return { headers, text, files };
}

export function decodeWords(v: string): string {
  return v.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_, b: string) => Buffer.from(b, "base64").toString("utf8"));
}
