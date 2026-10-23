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

/** A file name that is safe on macOS and in Obsidian links. */
export function safeFileName(name: string, maxLength = 120): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (cleaned.length <= maxLength) return cleaned || "untitled";
  const ext = path.extname(cleaned);
  const keepExt = ext.length > 0 && ext.length <= 10 ? ext : "";
  return cleaned.slice(0, maxLength - keepExt.length).trimEnd() + keepExt;
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
