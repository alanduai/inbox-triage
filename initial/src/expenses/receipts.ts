import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ParsedMessage } from "../gmail/parse.js";
import { safeFileName, writeFileAtomic } from "../util/files.js";
import { localStamp } from "../util/time.js";
import { formatPlain } from "./money.js";
import type { ExpenseLine, SavedFile } from "./types.js";

export function monthFolder(receiptsDir: string, period: string): string {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error(`Not a period: ${period}`);
  return path.join(receiptsDir, period);
}

/** "03 2026-10-05 Notion 10.00 USD.pdf"; a second file of the same line gets the original name too. */
export function receiptFileName(line: Pick<ExpenseLine, "n" | "date" | "vendorName" | "amount" | "currency">, period: string, ext: string, original: string, index: number): string {
  const parts = [String(line.n).padStart(2, "0"), line.date || period, line.vendorName];
  if (line.amount !== null) parts.push(`${formatPlain(line.amount)}${line.currency ? ` ${line.currency}` : ""}`);
  let stem = parts.join(" ");
  if (index > 0) stem += ` - ${path.basename(original, path.extname(original))}`;
  return safeFileName(`${stem}${ext}`, 200);
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Writes one receipt into the month folder. An identical file already there is kept as it is. */
export function saveReceipt(folder: string, filename: string, data: Buffer): SavedFile {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, filename);
  const hash = sha256(data);
  if (!(fs.existsSync(file) && sha256(fs.readFileSync(file)) === hash)) writeFileAtomic(file, data);
  return { path: file, filename, size: data.length, sha256: hash };
}

/**
 * Removes files an earlier run of the same month wrote and this run did not write again. A file you
 * changed or added yourself is never touched: only an unchanged file with a recorded hash goes.
 */
export function removeStale(previous: SavedFile[], kept: SavedFile[]): string[] {
  const keep = new Set(kept.map((f) => f.path));
  const removed: string[] = [];
  for (const f of previous) {
    if (keep.has(f.path) || !fs.existsSync(f.path)) continue;
    try {
      if (sha256(fs.readFileSync(f.path)) === f.sha256) {
        fs.unlinkSync(f.path);
        removed.push(f.path);
      }
    } catch {
      // Left in place; the next run tries again.
    }
  }
  return removed;
}

export function isPdf(data: Buffer): boolean {
  return data.subarray(0, 1024).includes("%PDF-");
}

export function isImage(data: Buffer): "png" | "jpg" | "gif" | "webp" | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * A receipt email as one HTML page with its headers on top, for printing to PDF. The renderer runs
 * it with scripts off and every network request blocked, so nothing in it loads or runs.
 */
export function emailAsHtml(m: ParsedMessage, tz: string): string {
  const head = [
    ["From", m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email],
    ["To", m.to.map((a) => a.email).join(", ")],
    ["Date", `${localStamp(m.internalDate, tz)} (${tz})`],
    ["Subject", m.subject],
  ]
    .map(([k, v]) => `<tr><th>${esc(k!)}</th><td>${esc(v!)}</td></tr>`)
    .join("");
  const body = m.htmlParts.length
    ? m.htmlParts.join("\n<hr>\n").replace(/<script\b[\s\S]*?<\/script>/gi, "")
    : `<pre>${esc(m.plainParts.join("\n\n") || m.text)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:12px/1.4 -apple-system,Helvetica,Arial,sans-serif;margin:24px;color:#111}
table.h{border-collapse:collapse;margin:0 0 16px;width:100%}table.h th{text-align:left;padding:2px 12px 2px 0;color:#555;width:70px;vertical-align:top}
table.h td{padding:2px 0}pre{white-space:pre-wrap;font:12px/1.4 ui-monospace,Menlo,monospace}hr.s{border:0;border-top:1px solid #ccc;margin:0 0 16px}
</style></head><body><table class="h">${head}</table><hr class="s">${body}</body></html>`;
}
