/**
 * Plain-text replies in RFC 5322 form, for the Gmail API's raw field. Headers with non-ASCII text
 * (Croatian and Swedish names and subjects) use RFC 2047 encoded words; the body is UTF-8 in base64.
 */

export interface MailAddress {
  name: string;
  email: string;
}

export interface ReplyMessage {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  // The original's Message-ID and References, so Gmail and every client keep the thread together.
  inReplyTo: string;
  references: string;
  body: string;
  // Our own id for this send, carried in a header so a retry can tell whether it already went out.
  outboxId: string;
  kind: "reply" | "ack";
  date: Date;
}

export const OUTBOX_HEADER = "X-Inbox-Triage-Outbox";
export const KIND_HEADER = "X-Inbox-Triage-Kind";

// Reply prefixes in English, Swedish (SV, VS), Croatian (Odg), German (AW) and Dutch (Antw).
const REPLY_PREFIX = /^\s*(re|sv|vs|odg|aw|antw)\s*(\[\d+\])?\s*:/i;

/** "Re: <subject>", unless the subject already starts with a reply prefix (Gmail threads on a matching subject). */
export function replySubject(subject: string): string {
  const s = subject.trim();
  if (!s) return "Re:";
  return REPLY_PREFIX.test(s) ? s : `Re: ${s}`;
}

const MAX_WORD = 75;

/** RFC 2047 encoded words for text that is not plain ASCII; never splits a character across words. */
export function encodeHeaderText(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words: string[] = [];
  const prefix = "=?UTF-8?B?";
  const suffix = "?=";
  // 75 characters per word leave room for 45 bytes of text (60 base64 characters).
  const maxBytes = Math.floor((MAX_WORD - prefix.length - suffix.length) / 4) * 3;
  let chunk = "";
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, "utf8") > maxBytes) {
      words.push(prefix + Buffer.from(chunk, "utf8").toString("base64") + suffix);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(prefix + Buffer.from(chunk, "utf8").toString("base64") + suffix);
  return words.join("\r\n ");
}

/** One address for a header: the name encoded or quoted as needed, the address checked for injected characters. */
export function formatAddress(a: MailAddress): string {
  const email = a.email.trim();
  if (!isPlainAddress(email)) throw new Error(`Not a usable email address: ${JSON.stringify(a.email)}`);
  const name = a.name.replace(/[\r\n]+/g, " ").trim();
  if (!name || name.toLowerCase() === email.toLowerCase()) return email;
  if (!/^[\x20-\x7e]*$/.test(name)) return `${encodeHeaderText(name)} <${email}>`;
  // Quote names with specials (commas, dots, parentheses); escape quotes and backslashes inside.
  const safe = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(name) ? name : `"${name.replace(/(["\\])/g, "\\$1")}"`;
  return `${safe} <${email}>`;
}

/** local@domain, with no spaces, angle brackets, commas, quotes or line breaks that could add a header or a recipient. */
export function isPlainAddress(email: string): boolean {
  return /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email);
}

/** A header value with no line breaks, so message text can never add a header of its own. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** A reply: the subject gets "Re:" so Gmail keeps it in the thread. */
export function buildReply(m: ReplyMessage): string {
  return buildMessage({ ...m, subject: replySubject(m.subject) });
}

/** The whole message with the subject as given, CRLF line endings, ready to be base64url-encoded for the API. */
export function buildMessage(m: ReplyMessage): string {
  if (!m.to.length) throw new Error("A message needs at least one recipient");
  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.map(formatAddress).join(",\r\n ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(formatAddress).join(",\r\n ")}`] : []),
    `Subject: ${encodeHeaderText(oneLine(m.subject))}`,
    `Date: ${m.date.toUTCString().replace("GMT", "+0000")}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`] : []),
    ...(m.inReplyTo || m.references ? [`References: ${oneLine([m.references, m.inReplyTo].filter(Boolean).join(" "))}`] : []),
    `${OUTBOX_HEADER}: ${oneLine(m.outboxId)}`,
    `${KIND_HEADER}: ${m.kind}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = m.body.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
  const encoded = (Buffer.from(body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${encoded}\r\n`;
}

/** base64url without padding, as the Gmail API wants for raw. */
export function toRaw(message: string): string {
  return Buffer.from(message, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const ATTRIBUTION: Record<string, (date: string, who: string) => string> = {
  en: (date, who) => `On ${date}, ${who} wrote:`,
  hr: (date, who) => `${date}, ${who} je napisao/la:`,
  sv: (date, who) => `${date} skrev ${who}:`,
};

const LOCALE: Record<string, string> = { en: "en-GB", hr: "hr-HR", sv: "sv-SE" };

/** Your text, then the original quoted with "> ", introduced in the reply's language. */
export function withQuote(text: string, original: { date: Date; fromName: string; fromEmail: string; text: string }, language: string, tz: string): string {
  const lang = ATTRIBUTION[language] ? language : "en";
  const date = original.date.toLocaleString(LOCALE[lang], { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
  const who = original.fromName ? `${original.fromName} <${original.fromEmail}>` : original.fromEmail;
  const quoted = original.text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`).trimEnd())
    .join("\n");
  return `${text.replace(/\s+$/, "")}\n\n${ATTRIBUTION[lang]!(date, who)}\n${quoted}\n`;
}
