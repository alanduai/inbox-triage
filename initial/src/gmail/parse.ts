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
  // The original References header, carried into replies so every client keeps the thread together.
  references: string;
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

// Latin-1 names (U+00A0 to U+00FF, in order) and the others that appear in Croatian, Swedish and business mail.
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const ENTITIES: Record<string, number> = {
  ...Object.fromEntries(LATIN1.map((name, i) => [name, 0xa0 + i])),
  quot: 34, amp: 38, apos: 39, lt: 60, gt: 62,
  Cacute: 0x106, cacute: 0x107, Ccaron: 0x10c, ccaron: 0x10d, Dstrok: 0x110, dstrok: 0x111,
  OElig: 0x152, oelig: 0x153, Scaron: 0x160, scaron: 0x161, Yuml: 0x178, Zcaron: 0x17d, zcaron: 0x17e,
  fnof: 0x192, circ: 0x2c6, tilde: 0x2dc, ensp: 0x2002, emsp: 0x2003, thinsp: 0x2009, zwnj: 0x200c, zwj: 0x200d,
  lrm: 0x200e, rlm: 0x200f, ndash: 0x2013, mdash: 0x2014, lsquo: 0x2018, rsquo: 0x2019, sbquo: 0x201a,
  ldquo: 0x201c, rdquo: 0x201d, bdquo: 0x201e, dagger: 0x2020, Dagger: 0x2021, bull: 0x2022, hellip: 0x2026,
  permil: 0x2030, prime: 0x2032, Prime: 0x2033, lsaquo: 0x2039, rsaquo: 0x203a, euro: 0x20ac, trade: 0x2122,
  larr: 0x2190, rarr: 0x2192, minus: 0x2212,
};

/** Decodes character references in one pass, so "&amp;lt;" stays "&lt;". Unknown names are kept as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,8}|#x[0-9a-f]{1,8}|[a-z][a-z0-9]{1,31});/gi, (whole, ref: string) => {
    if (ref[0] === "#") return codePoint(ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
    const cp = ENTITIES[ref];
    return cp === undefined ? whole : String.fromCodePoint(cp);
  });
}

export function htmlToText(html: string): string {
  const s = dropBlocks(html.slice(0, MAX_HTML_CHARS))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^<>]*>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|table|ul|ol)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<li\b[^<>]*>/gi, "\n- ")
    .replace(/<[^<>]*>/g, "");
  return decodeEntities(s)
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A forward carries the content that matters, so it is never cut.
const FORWARD_MARKERS: RegExp[] = [
  /^-{3,}\s*(Forwarded message|Vidarebefordrat meddelande|Proslije[dđ]ena poruka|Prosle[dđ]ena poruka|Weitergeleitete Nachricht)\s*-{3,}$/i,
  /^(Begin forwarded message|Vidarebefordrat meddelande|Proslije[dđ]ena poruka|Prosle[dđ]ena poruka):?$/i,
];
const FORWARD_SUBJECT = /^\s*(fwd?|vb|wg|tr)\s*(\[\d+\])?\s*:/i;
// Gmail and Apple Mail attribution lines in English, Swedish and Croatian. They only count with an
// address in them or a ">" quote right after, so an ordinary sentence ending in "wrote:" is kept.
const ATTRIBUTIONS: RegExp[] = [/^On\b.{1,240}\bwrote:$/, /^Den\b.{1,240}\bskrev\b.{0,120}:$/, /^.{1,240}\b(napisao|napisala)( je)?:$/];
const ORIGINAL_MARKER = /^-{2,}\s*(Original Message|Ursprungligt meddelande|Originalmeddelande|Izvorna poruka|Izvorni e-mail)\s*-{2,}$/i;
const HEADER_FROM = /^(From|Från|Šalje|Od|Pošiljatelj|Pošiljalac):\s/i;
const HEADER_SENT = /^(Sent|Skickat|Poslano|Datum|Date|Poslan):\s/i;
const HEADER_SUBJECT = /^(Subject|Ämne|Predmet|Tema):\s/i;
const HAS_ADDRESS = /[^\s<>"(),;:]+@[^\s<>"(),;:]+\.[a-z]{2,}/i;

/**
 * The part of a message that is new: drops a quoted earlier message at the end. Keeps the whole
 * text for forwards, for inline answers under a quote, and whenever the cut is not certain. The
 * full text is kept separately and still reaches Claude and the note.
 */
export function stripQuoted(text: string, subject = ""): string {
  const full = text.trim();
  if (FORWARD_SUBJECT.test(subject)) return full;
  const lines = text.split("\n");
  const trimmed = lines.map((l) => l.trim());
  if (trimmed.some((l) => FORWARD_MARKERS.some((r) => r.test(l)))) return full;

  let cut = -1;
  for (let i = 0; i < trimmed.length && cut === -1; i++) {
    const line = trimmed[i] ?? "";
    if (ORIGINAL_MARKER.test(line)) cut = i;
    else if (ATTRIBUTIONS.some((r) => r.test(line))) {
      const after = trimmed.slice(i + 1).filter(Boolean);
      const quoted = after.filter((l) => l.startsWith(">")).length;
      if (!HAS_ADDRESS.test(line) && !(after[0] ?? "").startsWith(">")) continue;
      // Answers written between quoted lines: the whole text is the message.
      if (quoted > 0 && quoted < after.length) return full;
      cut = i;
    } else if (HEADER_FROM.test(line)) {
      const block = trimmed.slice(i + 1, i + 7);
      if (block.some((l) => HEADER_SENT.test(l)) && block.some((l) => HEADER_SUBJECT.test(l))) {
        cut = i > 0 && /^_{10,}$/.test(trimmed[i - 1] ?? "") ? i - 1 : i;
      }
    }
  }
  if (cut === -1) return full;
  const kept = lines.slice(0, cut);
  while (kept.length && /^\s*(>|$)/.test(kept[kept.length - 1] ?? "")) kept.pop();
  return kept.join("\n").trim() || full;
}

/** What stripQuoted left out: the quoted or forwarded rest of the message. */
export function quotedRest(text: string, latest: string): string {
  const full = text.trim();
  if (!latest || latest === full) return "";
  return full.startsWith(latest) ? full.slice(latest.length).trim() : full;
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
    references: header(headers, "References", true).replace(/\s+/g, " ").trim(),
    text,
    latestText: stripQuoted(text, header(headers, "Subject")),
    attachments,
    senderVerified: senderVerified(headers, from.email),
    deferredBody,
    plainParts: plain,
    htmlParts: html,
  };
}

function bodyText(plain: string[], html: string[]): string {
  const p = plain.join("\n\n").replace(/\r\n?/g, "\n").trim();
  // A blank text part next to real HTML (some mail clients send one) must not hide the HTML.
  return p || htmlToText(html.join("\n\n")).replace(/\r\n?/g, "\n").trim();
}

/** Adds body parts that Gmail served by attachment id (large messages) and recomputes the text. */
export function completeBody(msg: ParsedMessage, fetched: { mimeType: string; data: Buffer; charset?: string }[]): ParsedMessage {
  const plain = [...msg.plainParts];
  const html = [...msg.htmlParts];
  for (const f of fetched) (f.mimeType === "text/plain" ? plain : html).push(decodeBytes(f.data, f.charset));
  const text = bodyText(plain, html);
  return { ...msg, text, latestText: stripQuoted(text, msg.subject), deferredBody: [], plainParts: plain, htmlParts: html };
}

/** Logos and signature images: inline images under 50 KB are not worth filing. */
export function isNoiseAttachment(a: AttachmentRef): boolean {
  return a.inline && a.mimeType.startsWith("image/") && a.size < 50_000;
}
