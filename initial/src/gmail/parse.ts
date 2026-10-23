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
  // Whether Gmail's own Authentication-Results show the From domain passed DMARC, or an aligned
  // DKIM or SPF check. null when Gmail added no result (for example your own sent mail).
  senderVerified: boolean | null;
  // Body parts too large for Gmail to inline; GmailReader fetches them and calls completeBody.
  deferredBody: DeferredPart[];
  // Decoded text parts, kept so completeBody can rebuild the text.
  plainParts: string[];
  htmlParts: string[];
}

export interface DeferredPart {
  mimeType: string;
  attachmentId: string;
  charset?: string;
}

/** A header's first value, with encoded words decoded unless raw is asked for. */
export function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string, raw = false): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  const value = h?.value ?? "";
  return raw ? value : decodeEncodedWords(value);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

function encodedWordBytes(enc: string, data: string): Buffer {
  if (enc.toUpperCase() === "B") return Buffer.from(data, "base64");
  return Buffer.from(
    data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
    "latin1",
  );
}

/**
 * RFC 2047 encoded words, e.g. =?UTF-8?B?...?= or =?iso-8859-2?Q?...?=. Adjacent words in the
 * same charset are joined as bytes before decoding, so a character split across two words survives.
 */
export function decodeEncodedWords(value: string): string {
  const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
  let out = "";
  let last = 0;
  let run: { charset: string; bytes: Buffer[] } | null = null;
  const flush = () => {
    if (run) out += decodeBytes(Buffer.concat(run.bytes), run.charset);
    run = null;
  };
  for (const m of joined.matchAll(ENCODED_WORD)) {
    const at = m.index ?? 0;
    if (at > last) {
      flush();
      out += joined.slice(last, at);
    }
    const charset = (m[1] ?? "utf-8").split("*")[0]!.toLowerCase();
    const bytes = encodedWordBytes(m[2] ?? "B", m[3] ?? "");
    if (run && run.charset === charset) run.bytes.push(bytes);
    else {
      flush();
      run = { charset, bytes: [bytes] };
    }
    last = at + m[0].length;
  }
  flush();
  return out + joined.slice(last);
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

const ADDR_SPEC = /[^\s<>"(),;:@]+@[^\s<>"(),;:@]+\.[^\s<>"(),;:@]+/;

/** Removes (comments) that sit outside quoted strings, as in "a@b.c (Name)". */
function stripComments(s: string): string {
  let out = "";
  let quoted = false;
  let depth = 0;
  for (const ch of s) {
    if (ch === '"' && depth === 0) quoted = !quoted;
    if (!quoted && ch === "(") {
      depth++;
      continue;
    }
    if (!quoted && ch === ")" && depth > 0) {
      depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * Parses a raw (undecoded) address header. Splitting happens before encoded words are decoded,
 * and only display names are decoded, so a name like "=?UTF-8?Q?Court_=3Ca=40court=3E?=" can
 * never become the address. The address is the last <...> outside quotes, else a bare addr-spec.
 */
export function parseAddressList(value: string): Address[] {
  const out: Address[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  for (const ch of stripComments(value)) {
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
    let q = false;
    let open = -1;
    let span: [number, number] | null = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') q = !q;
      else if (!q && ch === "<") open = i;
      else if (!q && ch === ">" && open !== -1) {
        span = [open, i];
        open = -1;
      }
    }
    if (span) {
      const email = s.slice(span[0] + 1, span[1]).trim().toLowerCase();
      const name = (s.slice(0, span[0]) + s.slice(span[1] + 1)).trim().replace(/^"|"$/g, "").replace(/\\(.)/g, "$1").trim();
      if (ADDR_SPEC.test(email)) out.push({ name: decodeEncodedWords(name), email });
      return;
    }
    const bare = s.replace(/"[^"]*"/g, " ").match(ADDR_SPEC)?.[0];
    if (bare) out.push({ name: "", email: bare.toLowerCase() });
  }
}

/**
 * Reads the Authentication-Results that Gmail itself added (the first one, from mx.google.com;
 * a sender can add fake ones further down, never above it). The sender counts as verified when
 * DMARC passed for the From domain, or DKIM or SPF passed for that domain or a subdomain of it.
 */
export function senderVerified(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, fromEmail: string): boolean | null {
  const results = headers?.find((h) => h.name?.toLowerCase() === "authentication-results")?.value ?? "";
  if (!/^\s*mx\.google\.com\s*;/i.test(results)) return null;
  const domain = fromEmail.slice(fromEmail.lastIndexOf("@") + 1).toLowerCase();
  if (!domain) return false;
  const aligned = (d: string | undefined) => {
    const x = (d ?? "").toLowerCase().replace(/^.*@/, "");
    return x === domain || x.endsWith("." + domain) || domain.endsWith("." + x);
  };
  for (const clause of results.split(";")) {
    const c = clause.trim();
    if (/^dmarc=pass\b/i.test(c) && aligned(c.match(/header\.from=([^\s;]+)/i)?.[1])) return true;
    if (/^dkim=pass\b/i.test(c) && aligned(c.match(/header\.(?:i|d)=([^\s;]+)/i)?.[1])) return true;
    if (/^spf=pass\b/i.test(c) && aligned(c.match(/smtp\.mailfrom=([^\s;]+)/i)?.[1])) return true;
  }
  return false;
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

// Only the first 40,000 characters of text reach Claude; this bounds the work on hostile HTML.
const MAX_HTML_CHARS = 500_000;

/** Drops <script>, <style> and <head> blocks in one pass (no backtracking regex). */
function dropBlocks(html: string): string {
  const open = /<(script|style|head)\b/gi;
  let out = "";
  let pos = 0;
  for (;;) {
    open.lastIndex = pos;
    const m = open.exec(html);
    if (!m) break;
    out += html.slice(pos, m.index);
    const close = html.toLowerCase().indexOf(`</${m[1]!.toLowerCase()}`, m.index + m[0].length);
    if (close === -1) return out;
    const end = html.indexOf(">", close);
    pos = end === -1 ? html.length : end + 1;
  }
  return out + html.slice(pos);
}

function codePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\ufffd";
}

export function htmlToText(html: string): string {
  let s = dropBlocks(html.slice(0, MAX_HTML_CHARS))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<li\b[^<>]*>/gi, "\n- ")
    .replace(/<[^<>]*>/g, "");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,8});/g, (_m, d: string) => codePoint(Number(d)))
    .replace(/&#x([0-9a-f]{1,8});/gi, (_m, h: string) => codePoint(parseInt(h, 16)))
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
  const deferredBody: DeferredPart[] = [];

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
    if (!data) {
      if (part.body?.attachmentId && (part.mimeType === "text/plain" || part.mimeType === "text/html")) {
        deferredBody.push({ mimeType: part.mimeType, attachmentId: part.body.attachmentId, charset: charsetOf(part) });
      }
      return;
    }
    const text = decodeBytes(decodeBase64Url(data), charsetOf(part));
    if (part.mimeType === "text/plain") plain.push(text);
    else if (part.mimeType === "text/html") html.push(text);
  });

  const text = bodyText(plain, html);
  const from = parseAddressList(header(headers, "From", true))[0] ?? { name: "", email: "" };
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    labelIds: msg.labelIds ?? [],
    internalDate: new Date(Number(msg.internalDate ?? 0)),
    from,
    to: parseAddressList(header(headers, "To", true)),
    cc: parseAddressList(header(headers, "Cc", true)),
    replyTo: parseAddressList(header(headers, "Reply-To", true)),
    subject: header(headers, "Subject") || "(no subject)",
    rfc822MessageId: header(headers, "Message-ID"),
    text,
    latestText: stripQuoted(text),
    attachments,
    senderVerified: senderVerified(headers, from.email),
    deferredBody,
    plainParts: plain,
    htmlParts: html,
  };
}

function bodyText(plain: string[], html: string[]): string {
  return (plain.length ? plain.join("\n\n") : htmlToText(html.join("\n\n"))).replace(/\r\n/g, "\n").trim();
}

/** Adds body parts that Gmail served by attachment id (large messages) and recomputes the text. */
export function completeBody(msg: ParsedMessage, fetched: { mimeType: string; data: Buffer; charset?: string }[]): ParsedMessage {
  const plain = [...msg.plainParts];
  const html = [...msg.htmlParts];
  for (const f of fetched) (f.mimeType === "text/plain" ? plain : html).push(decodeBytes(f.data, f.charset));
  const text = bodyText(plain, html);
  return { ...msg, text, latestText: stripQuoted(text), deferredBody: [], plainParts: plain, htmlParts: html };
}

/** Logos and signature images: inline images under 50 KB are not worth filing. */
export function isNoiseAttachment(a: AttachmentRef): boolean {
  return a.inline && a.mimeType.startsWith("image/") && a.size < 50_000;
}
