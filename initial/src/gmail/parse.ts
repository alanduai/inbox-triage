import type { gmail_v1 } from "@googleapis/gmail";

type Part = gmail_v1.Schema$MessagePart;

export interface Address {
  name: string;
  email: string;
}

export interface AttachmentRef {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  // Small data is inline in the part instead of behind an attachment id.
  data?: string;
  inline: boolean;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: Date;
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  subject: string;
  rfc822MessageId: string;
  // Full text of the message, and the text without quoted earlier messages.
  text: string;
  latestText: string;
  attachments: AttachmentRef[];
}

export function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return decodeEncodedWords(h?.value ?? "");
}

/** RFC 2047 encoded words, e.g. =?UTF-8?B?...?= or =?iso-8859-2?Q?...?=. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
      try {
        const bytes =
          enc.toUpperCase() === "B"
            ? Buffer.from(data, "base64")
            : Buffer.from(
                data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
                "latin1",
              );
        return decodeBytes(bytes, charset);
      } catch {
        return data;
      }
    });
}

function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  const cs = (charset ?? "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Splits an address header on commas outside quotes and angle brackets. */
export function parseAddressList(value: string): Address[] {
  const out: Address[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) {
      push(cur);
      cur = "";
    } else cur += ch;
  }
  push(cur);
  return out;

  function push(raw: string) {
    const s = raw.trim().replace(/;$/, "");
    if (!s) return;
    const m = s.match(/^(.*?)<([^>]+)>\s*$/);
    if (m) {
      out.push({ name: (m[1] ?? "").trim().replace(/^"|"$/g, "").trim(), email: (m[2] ?? "").trim().toLowerCase() });
    } else if (s.includes("@")) {
      out.push({ name: "", email: s.replace(/^"|"$/g, "").trim().toLowerCase() });
    }
  }
}

function charsetOf(part: Part): string | undefined {
  const ct = header(part.headers ?? undefined, "Content-Type");
  return ct.match(/charset="?([^";\s]+)"?/i)?.[1];
}

function isAttachmentPart(part: Part): boolean {
  return Boolean(part.filename) || Boolean(part.body?.attachmentId && !part.mimeType?.startsWith("text/"));
}

function walk(part: Part | undefined, visit: (p: Part) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

export function htmlToText(html: string): string {
  let s = html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, "&");
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const QUOTE_HEADERS: RegExp[] = [
  /^On .{1,240}wrote:\s*$/,
  /^Den .{1,240}skrev.{0,60}:\s*$/,
  /^.{0,240}\b(je )?(napisao|napisala|napisao\/la)\b.{0,60}:\s*$/,
  /^-{2,}\s*(Original Message|Ursprungligt meddelande|Originalmeddelande|Izvorna poruka|Izvorni e-mail)\s*-{2,}/i,
  /^_{10,}\s*$/,
];
const OUTLOOK_FROM = /^(From|Från|Šalje|Od|Pošiljatelj):\s/;
const OUTLOOK_NEXT = /^(Sent|Skickat|Poslano|Datum|Date|Šalje|Poslan):\s/;

/** Drops quoted earlier messages so the note shows what is new. Keeps everything if nothing is left. */
export function stripQuoted(text: string): string {
  const lines = text.split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (QUOTE_HEADERS.some((r) => r.test(line))) {
      cut = i;
      break;
    }
    if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 5).some((l) => OUTLOOK_NEXT.test(l.trim()))) {
      cut = i;
      break;
    }
  }
  let kept = lines.slice(0, cut);
  // Trailing "> " quote blocks.
  while (kept.length && /^\s*(>|$)/.test(kept[kept.length - 1] ?? "")) kept.pop();
  const result = kept.join("\n").trim();
  return result || text.trim();
}

export function parseMessage(msg: gmail_v1.Schema$Message): ParsedMessage {
  const payload = msg.payload ?? {};
  const headers = payload.headers ?? undefined;
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: AttachmentRef[] = [];

  walk(payload, (part) => {
    if (part.parts?.length) return;
    if (isAttachmentPart(part)) {
      const disposition = header(part.headers ?? undefined, "Content-Disposition").toLowerCase();
      const cid = header(part.headers ?? undefined, "Content-ID");
      attachments.push({
        filename: decodeEncodedWords(part.filename || "attachment"),
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body?.size ?? 0,
        attachmentId: part.body?.attachmentId ?? undefined,
        data: part.body?.data ?? undefined,
        inline: disposition.startsWith("inline") || (Boolean(cid) && !disposition.startsWith("attachment")),
      });
      return;
    }
    const data = part.body?.data;
    if (!data) return;
    const text = decodeBytes(decodeBase64Url(data), charsetOf(part));
    if (part.mimeType === "text/plain") plain.push(text);
    else if (part.mimeType === "text/html") html.push(text);
  });

  const text = (plain.length ? plain.join("\n\n") : htmlToText(html.join("\n\n"))).replace(/\r\n/g, "\n").trim();
  const from = parseAddressList(header(headers, "From"))[0] ?? { name: "", email: "" };
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    labelIds: msg.labelIds ?? [],
    internalDate: new Date(Number(msg.internalDate ?? 0)),
    from,
    to: parseAddressList(header(headers, "To")),
    cc: parseAddressList(header(headers, "Cc")),
    replyTo: parseAddressList(header(headers, "Reply-To")),
    subject: header(headers, "Subject") || "(no subject)",
    rfc822MessageId: header(headers, "Message-ID"),
    text,
    latestText: stripQuoted(text),
    attachments,
  };
}

/** Logos and signature images: inline images under 50 KB are not worth filing. */
export function isNoiseAttachment(a: AttachmentRef): boolean {
  return a.inline && a.mimeType.startsWith("image/") && a.size < 50_000;
}
