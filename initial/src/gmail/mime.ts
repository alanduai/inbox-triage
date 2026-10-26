/**
 * Plain-text replies in RFC 5322 form, for the Gmail API's raw field. Headers with non-ASCII text
 * (Croatian and Swedish names and subjects) use RFC 2047 encoded words; the body is UTF-8 in base64.
 * Lines are folded so none goes over 78 characters where it can be helped, never over 998.
 */

import { headerText } from "../util/text.js";

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
  // Our own id for this send, so a retry can tell whether it already went out.
  outboxId: string;
  date: Date;
}

// A neutral name and a random value: recipients learn nothing about how the reply was written.
export const OUTBOX_HEADER = "X-Ref-ID";

// Reply prefixes in English, Swedish (SV), Croatian (Odg, Odg.), German (AW) and Dutch (Antw).
// Not VS: it means reply in Finnish but forward in Norwegian and Danish.
const REPLY_PREFIX = /^\s*(re|sv|odg\.?|aw|antw)\s*(\[\d+\])?\s*:/i;

/** "Re: <subject>", unless the subject already starts with a reply prefix (Gmail threads on a matching subject). */
export function replySubject(subject: string): string {
  const s = subject.trim();
  if (!s) return "Re:";
  return REPLY_PREFIX.test(s) ? s : `Re: ${s}`;
}

// RFC 2047: a line that holds an encoded word is at most 76 characters.
const EW_LINE = 76;
const EW_PREFIX = "=?UTF-8?B?";
const EW_SUFFIX = "?=";

/**
 * Header text as it goes on the wire, starting after `used` characters already on the line
 * ("Subject: " is 9). Plain ASCII is folded at spaces; anything else becomes encoded words, one
 * per line, that never split a character.
 */
export function encodeHeaderText(text: string, used = 0): string {
  if (/^[\x20-\x7e]*$/.test(text)) return foldAscii(text, used);
  const words: string[] = [];
  // An encoded word is at most 75 characters, and its line at most 76.
  let room = Math.min(75, EW_LINE - used);
  let chunk = "";
  const bytesFor = (len: number) => Math.floor((len - EW_PREFIX.length - EW_SUFFIX.length) / 4) * 3;
  for (const ch of text) {
    if (chunk && Buffer.byteLength(chunk + ch, "utf8") > bytesFor(room)) {
      words.push(EW_PREFIX + Buffer.from(chunk, "utf8").toString("base64") + EW_SUFFIX);
      chunk = "";
      // Continuation lines start with one space.
      room = EW_LINE - 1;
    }
    chunk += ch;
  }
  if (chunk) words.push(EW_PREFIX + Buffer.from(chunk, "utf8").toString("base64") + EW_SUFFIX);
  return words.join("\r\n ");
}

/** Folds ASCII header text at spaces so lines stay near 78 characters. */
function foldAscii(text: string, used: number): string {
  const lines: string[] = [];
  let line = "";
  let budget = 78 - used;
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > budget) {
      lines.push(line);
      line = word;
      budget = 77;
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines.join("\r\n ");
}

/** One address for a header: the name encoded or quoted as needed, the address checked for injected characters. */
export function formatAddress(a: MailAddress): string {
  const email = a.email.trim();
  if (!isPlainAddress(email)) throw new Error(`Not a usable email address: ${JSON.stringify(a.email)}`);
  const name = headerText(a.name, 100);
  if (!name || name.toLowerCase() === email.toLowerCase()) return email;
  let shown: string;
  if (!/^[\x20-\x7e]*$/.test(name)) shown = encodeHeaderText(name, 4);
  // Quote names with specials (commas, dots, parentheses); escape quotes and backslashes inside.
  else shown = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(name) ? name : `"${name.replace(/(["\\])/g, "\\$1")}"`;
  const last = shown.slice(shown.lastIndexOf("\n") + 1);
  return last.length + email.length + 3 > EW_LINE ? `${shown}\r\n <${email}>` : `${shown} <${email}>`;
}

/** local@domain, with no spaces, angle brackets, commas, quotes or line breaks that could add a header or a recipient. */
export function isPlainAddress(email: string): boolean {
  return /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email);
}

/** <...> message ids of printable ASCII only. */
function messageIds(value: string): string[] {
  return value.match(/<[\x21-\x3b\x3d\x3f-\x7e]+>/g) ?? [];
}

/**
 * References for a reply: the parent's, then the parent's own id. A long chain keeps its first id
 * and the newest ones (RFC 5322 §3.6.4), one per line.
 */
function referencesFor(references: string, inReplyTo: string): string {
  const ids = [...messageIds(references), ...messageIds(inReplyTo).slice(0, 1)];
  const unique = ids.filter((id, i) => ids.indexOf(id) === i);
  const kept = unique.length > 10 ? [unique[0]!, ...unique.slice(-9)] : unique;
  return kept.join("\r\n ");
}

/** A reply: the subject gets "Re:" so Gmail keeps it in the thread. */
export function buildReply(m: ReplyMessage): string {
  return buildMessage({ ...m, subject: replySubject(m.subject) });
}

/** The whole message with the subject as given, CRLF line endings, ready to be base64url-encoded for the API. */
export function buildMessage(m: ReplyMessage): string {
  if (!m.to.length) throw new Error("A message needs at least one recipient");
  const parent = messageIds(m.inReplyTo)[0] ?? "";
  const references = referencesFor(m.references, parent);
  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.map(formatAddress).join(",\r\n ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(formatAddress).join(",\r\n ")}`] : []),
    `Subject: ${encodeHeaderText(headerText(m.subject, 500), 9)}`,
    `Date: ${m.date.toUTCString().replace("GMT", "+0000")}`,
    ...(parent ? [`In-Reply-To: ${parent}`] : []),
    ...(references ? [`References: ${references}`] : []),
    `${OUTBOX_HEADER}: ${m.outboxId.replace(/[^A-Za-z0-9-]/g, "")}`,
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

/**
 * Your text, then the original quoted with "> ", introduced in the reply's language. The
 * introduction names the sender by address only: a display name is whatever the sender chose,
 * so nothing they wrote can appear outside the quote.
 */
export function withQuote(text: string, original: { date: Date; fromEmail: string; text: string }, language: string, tz: string): string {
  const lang = ATTRIBUTION[language] ? language : "en";
  const date = original.date.toLocaleString(LOCALE[lang], { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
  const who = headerText(original.fromEmail, 254);
  const quoted = original.text
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
    .split("\n")
    .map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`).trimEnd())
    .join("\n");
  return `${text.replace(/\s+$/, "")}\n\n${ATTRIBUTION[lang]!(date, who)}\n${quoted}\n`;
}
