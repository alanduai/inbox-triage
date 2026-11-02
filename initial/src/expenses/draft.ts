import { randomBytes } from "node:crypto";
import { formatHr } from "./money.js";
import type { ExpenseLine } from "./types.js";

// Genitive month names: "troškovi iz listopada 2026."
const MONTHS_GENITIVE = ["siječnja", "veljače", "ožujka", "travnja", "svibnja", "lipnja", "srpnja", "kolovoza", "rujna", "listopada", "studenoga", "prosinca"];

export function periodHr(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return `${MONTHS_GENITIVE[m - 1] ?? period} ${y}.`;
}

/** "2026-10-03" → "03.10.2026." */
export function dateHr(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}.` : "";
}

// The vendor as Ivana wrote it, so each line matches her list.
function lineHr(l: Pick<ExpenseLine, "vendor" | "amount" | "currency" | "date">): string {
  const parts = [l.vendor];
  if (l.amount !== null) parts.push(`${formatHr(l.amount)}${l.currency ? ` ${l.currency}` : ""}`);
  const d = dateHr(l.date);
  return d ? `${parts.join(" – ")}, ${d}` : parts.join(" – ");
}

/**
 * The reply to Ivana, in Croatian. It lists what is attached and what is still missing, and avoids
 * gendered past-tense verbs and promises. You review it in Gmail before sending.
 */
export function draftBody(opts: { greeting: string; period: string; attached: ExpenseLine[]; missing: ExpenseLine[]; signOff: string }): string {
  const out = [opts.greeting.trim(), ""];
  if (opts.attached.length) {
    out.push(`u prilogu šaljem račune za troškove iz ${periodHr(opts.period)}:`, "");
    opts.attached.forEach((l, i) => out.push(`${i + 1}. ${lineHr(l)}`));
  }
  if (opts.missing.length) {
    if (opts.attached.length) out.push("");
    out.push(opts.attached.length ? "Za sljedeće troškove račun još nije pronađen:" : `za troškove iz ${periodHr(opts.period)} račun još nije pronađen:`, "");
    for (const l of opts.missing) out.push(`- ${lineHr(l)}`);
  }
  out.push("", opts.signOff.trim());
  return out.join("\n");
}

export function replySubject(subject: string): string {
  const s = subject.replace(/\s+/g, " ").trim() || "Računi";
  return /^(re|odg|odgovor|aw|sv)\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** RFC 2047 encoded word for a header value that is not plain ASCII. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  // Split into chunks so no encoded word is longer than 75 characters, never inside a character.
  const words: string[] = [];
  let chunk = "";
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

function addressHeader(a: { name: string; email: string }): string {
  if (!/^[^\s@<>"(),;:\r\n]+@[^\s@<>"(),;:\r\n]+$/.test(a.email)) throw new Error(`Not an email address: ${a.email}`);
  if (!a.name) return a.email;
  const name = a.name.replace(/[\r\n"\\]/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(name) ? `"${name}" <${a.email}>` : `${encodeHeader(name)} <${a.email}>`;
}

function base64Lines(data: Buffer): string {
  return (data.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/** RFC 2231 file name, plus a plain fallback for mail programs that read only filename=. */
function filenameParams(name: string): string {
  const safe = name.replace(/[\r\n"\\/]/g, "_");
  const ascii = /^[\x20-\x7e]*$/.test(safe);
  const star = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return ascii ? `filename="${safe}"` : `filename="${encodeHeader(safe)}"; filename*=UTF-8''${star}`;
}

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface MimeInput {
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  subject: string;
  inReplyTo: string;
  references: string;
  text: string;
  attachments: MimeAttachment[];
  date?: Date;
  boundary?: string;
}

/** A reply email as raw MIME: threaded to the original by In-Reply-To and References. */
export function buildMime(input: MimeInput): Buffer {
  const boundary = input.boundary ?? `=_expenses_${randomBytes(12).toString("hex")}`;
  const msgId = input.inReplyTo.trim();
  const refs = [...new Set([...input.references.split(/\s+/).filter((r) => /^<[^<>\s]+>$/.test(r)), ...(msgId ? [msgId] : [])])].join(" ");
  const headers = [
    `From: ${addressHeader(input.from)}`,
    `To: ${input.to.map(addressHeader).join(", ")}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${(input.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    ...(msgId ? [`In-Reply-To: ${msgId}`] : []),
    ...(refs ? [`References: ${refs}`] : []),
    "MIME-Version: 1.0",
  ];
  const text = input.text.replace(/\r?\n/g, "\r\n");
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64Lines(Buffer.from(text, "utf8"))].join("\r\n");
  if (!input.attachments.length) return Buffer.from([...headers, textPart].join("\r\n") + "\r\n", "utf8");
  const parts = [textPart];
  for (const a of input.attachments) {
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType) ? a.mimeType : "application/octet-stream";
    parts.push(
      [`Content-Type: ${type}; name="${a.filename.replace(/[\r\n"\\/]/g, "_").replace(/[^\x20-\x7e]/g, "_")}"`, `Content-Disposition: attachment; ${filenameParams(a.filename)}`, "Content-Transfer-Encoding: base64", "", base64Lines(a.content)].join("\r\n"),
    );
  }
  const body = parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n") + `\r\n--${boundary}--\r\n`;
  return Buffer.from([...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", body].join("\r\n"), "utf8");
}

export function mimeTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return (
    { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", html: "text/html", htm: "text/html", txt: "text/plain" } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}
