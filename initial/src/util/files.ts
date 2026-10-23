import fs from "node:fs";
import path from "node:path";

/** Writes a file only the current user can read (tokens, keys). */
export function writePrivateFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/**
 * Atomic write: a hidden temp file in the same folder, then a rename, so Obsidian Sync never
 * picks up a half-written note. Obsidian ignores dot-files.
 */
export function writeFileAtomic(file: string, content: string | Buffer): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** The longest start of s that fits in maxBytes of UTF-8, never splitting a character. */
export function truncateBytes(s: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

/**
 * A file name that is safe on macOS and in Obsidian links. macOS allows 255 bytes per name; the
 * default leaves room for a date prefix and an extension. Cuts fall between characters.
 */
export function safeFileName(name: string, maxBytes = 180): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (Buffer.byteLength(cleaned) <= maxBytes) return cleaned || "untitled";
  const ext = path.extname(cleaned);
  const keepExt = ext.length > 0 && Buffer.byteLength(ext) <= 10 ? ext : "";
  const stem = keepExt ? cleaned.slice(0, -keepExt.length) : cleaned;
  return truncateBytes(stem, maxBytes - Buffer.byteLength(keepExt)).trimEnd() + keepExt;
}

/** a.pdf, then "a (2).pdf", "a (3).pdf"... */
export function uniquePath(file: string): string {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}
