import type { ParsedMessage } from "../gmail/parse.js";
import { localToUtc } from "../util/time.js";
import { amountsIn, sameAmount } from "./money.js";
import type { Expense } from "./types.js";
import type { VendorProfile } from "./vendors.js";

const DAY = 86_400_000;
// Receipts and invoices in English, Croatian and German, as they appear in subjects and bodies.
const RECEIPT_WORDS = ["receipt", "invoice", "račun", "racun", "rechnung", "quittung", "beleg", "payment", "zahlung", "bestellung", "order", "faktura"];

export interface SearchWindow {
  from: Date;
  to: Date;
}

/**
 * Where a receipt can be: a card charge usually reaches the bank statement a few days after the
 * receipt email, so the window opens `windowDays` before the charge date and closes 3 days after.
 * Without a date, the whole month of the request, a few days either side.
 */
export function searchWindow(expense: Expense, period: string, windowDays: number, tz: string): SearchWindow {
  if (expense.date) {
    const day = localToUtc(`${expense.date}T00:00`, tz) ?? new Date(`${expense.date}T00:00:00Z`);
    return { from: new Date(day.getTime() - windowDays * DAY), to: new Date(day.getTime() + 4 * DAY) };
  }
  const [y, m] = period.split("-").map(Number) as [number, number];
  const start = localToUtc(`${period}-01T00:00`, tz) ?? new Date(Date.UTC(y, m - 1, 1));
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const end = localToUtc(`${next}-01T00:00`, tz) ?? new Date(Date.UTC(y, m, 1));
  return { from: new Date(start.getTime() - 3 * DAY), to: new Date(end.getTime() + 3 * DAY) };
}

function quote(term: string): string {
  const t = term.replace(/["{}()]/g, " ").replace(/\s+/g, " ").trim();
  return /\s|[^\p{L}\p{N}.@-]/u.test(t) ? `"${t}"` : t;
}

/**
 * Gmail searches for one expense: mail from the vendor's own domains, and mail naming the vendor
 * together with a receipt word. Ivana's own mail and replies to her are left out, so last month's
 * reply with its attachments is never taken for a receipt.
 */
export function receiptQueries(vendor: VendorProfile, window: SearchWindow, accountantEmails: string[]): string[] {
  const after = Math.floor(window.from.getTime() / 1000);
  const before = Math.ceil(window.to.getTime() / 1000);
  const base = [`after:${after}`, `before:${before}`, "-in:drafts", "-in:chats", ...accountantEmails.flatMap((e) => [`-from:${e}`, `-to:${e}`])].join(" ");
  const queries: string[] = [];
  const senders = vendor.senders.map((s) => `from:${s.replace(/^@/, "")}`);
  if (senders.length) queries.push(`${base} {${senders.join(" ")}}`);
  const names = vendor.keywords.map(quote);
  if (names.length) queries.push(`${base} {${names.join(" ")}} {${RECEIPT_WORDS.map(quote).join(" ")}}`);
  return queries;
}

function senderMatches(email: string, senders: string[]): boolean {
  const e = email.toLowerCase();
  return senders.some((s) => (s.startsWith("@") ? e.endsWith(s) || e.endsWith(`.${s.slice(1)}`) : e === s || e.endsWith(`@${s}`) || e.endsWith(`.${s}`)));
}

function hasDocument(m: ParsedMessage): boolean {
  return m.attachments.some((a) => !a.inline && (a.mimeType === "application/pdf" || a.filename.toLowerCase().endsWith(".pdf")));
}

/**
 * How likely a message is the receipt for an expense, from fixed facts: the vendor in the sender
 * or text, the same amount, a PDF attached, and the date. Claude makes the final choice among the
 * best few; this only decides which few it sees.
 */
export function scoreCandidate(expense: Expense, vendor: VendorProfile, m: ParsedMessage, tz: string, period: string): number {
  let score = 0;
  const head = `${m.from.name} ${m.from.email} ${m.subject}`.toLowerCase();
  const text = `${m.subject}\n${m.text.slice(0, 20_000)}`;
  if (senderMatches(m.from.email, vendor.senders)) score += 4;
  if (vendor.keywords.some((k) => head.includes(k.toLowerCase())) || vendor.aliases.some((a) => head.includes(a))) score += 3;
  else if (vendor.keywords.some((k) => text.toLowerCase().includes(k.toLowerCase()))) score += 1;
  if (expense.amount !== null && amountsIn(text).some((a) => sameAmount(a, expense.amount!))) score += 5;
  if (hasDocument(m)) score += 2;
  if (RECEIPT_WORDS.some((w) => m.subject.toLowerCase().includes(w))) score += 1;
  const w = searchWindow(expense, period, 0, tz);
  const target = expense.date ? w.from.getTime() : null;
  if (target !== null) {
    const days = Math.abs(m.internalDate.getTime() - target) / DAY;
    score += days <= 1.5 ? 2 : days <= 4 ? 1 : 0;
  }
  return score;
}
