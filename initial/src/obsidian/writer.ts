import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeFileName, uniquePath, writeFileAtomic } from "../util/files.js";
import type { FiledAttachment } from "../store/db.js";

// Reply and forward prefixes in English, Swedish (SV, VB), Croatian (Odg) and German Outlook.
const REPLY_PREFIX = /^\s*((re|fwd?|aw|sv|vs|vb|wg|odg|fw|tr|antw)\s*(\[\d+\])?\s*:\s*)+/i;

export function cleanSubject(subject: string): string {
  return subject.replace(REPLY_PREFIX, "").trim() || "(no subject)";
}

/** The vault-relative path for a new thread note, for example "Projects/X/2026-10-23 Draft statement.md". */
export function noteRelPath(folder: string, dateIso: string, subject: string): string {
  return path.posix.join(folder, `${dateIso.slice(0, 10)} ${safeFileName(cleanSubject(subject))}.md`);
}

export class VaultWriter {
  constructor(
    readonly vaultPath: string,
    private readonly maxSyncBytes: number,
    private readonly largeDir: string,
  ) {}

  abs(rel: string): string {
    const full = path.resolve(this.vaultPath, rel);
    if (!full.startsWith(path.resolve(this.vaultPath) + path.sep)) throw new Error(`Path escapes the vault: ${rel}`);
    return full;
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.abs(rel));
  }

  read(rel: string): string {
    return fs.readFileSync(this.abs(rel), "utf8");
  }

  write(rel: string, content: string): void {
    writeFileAtomic(this.abs(rel), content);
  }

  /** A free vault-relative path for a new note, never overwriting someone else's file. */
  freeNotePath(rel: string): string {
    return path.relative(this.vaultPath, uniquePath(this.abs(rel))).split(path.sep).join("/");
  }

  /**
   * Saves an attachment next to the project's notes, or outside the vault when it is over the
   * Obsidian Sync per-file limit. The same file sent twice is stored once.
   */
  saveAttachment(folder: string, dateIso: string, filename: string, data: Buffer, projectId: string): FiledAttachment {
    const name = `${dateIso.slice(0, 10)} ${safeFileName(filename)}`;
    if (data.length > this.maxSyncBytes) {
      const target = path.join(this.largeDir, projectId, name);
      const final = sameFileOrFree(target, data);
      if (!fs.existsSync(final)) writeFileAtomic(final, data);
      return { filename, size: data.length, path: final, inVault: false };
    }
    const rel = path.posix.join(folder, "attachments", name);
    const final = sameFileOrFree(this.abs(rel), data);
    if (!fs.existsSync(final)) writeFileAtomic(final, data);
    return { filename, size: data.length, path: path.relative(this.vaultPath, final).split(path.sep).join("/"), inVault: true };
  }
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The target if it holds the same bytes already, otherwise the first free variant of it. */
function sameFileOrFree(target: string, data: Buffer): string {
  const ext = path.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  const want = sha256(data);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? target : `${stem} (${i})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
    const stat = fs.statSync(candidate);
    if (stat.size === data.length && sha256(fs.readFileSync(candidate)) === want) return candidate;
  }
}
