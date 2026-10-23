/**
 * Markdown for the vault. The app owns only:
 *  - the frontmatter keys in APP_KEYS (other keys you add are left alone),
 *  - the message sections it appends at the end of the note,
 *  - its own task lines, found by their ^it-<id> block id.
 * Everything else in a note is yours, so edits on another device never conflict with the app.
 */

import type { FiledAttachment } from "../store/db.js";
import type { Triage } from "../triage/claude.js";

export const APP_KEYS = ["source", "project", "subject", "gmail", "from", "status", "urgency", "reply_by", "due", "review_required", "updated"] as const;
export type AppKey = (typeof APP_KEYS)[number];

export function yamlValue(value: string | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === "") return '""';
  if (/^[\p{L}\p{N} ._\-–—@+/()&,']+$/u.test(value) && !/^[-?:,\[\]{}#&*!|>'"%@`]/.test(value) && !/^(true|false|null|yes|no|~)$/i.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function blockId(itemId: string): string {
  return `it-${itemId.replace(/[^a-zA-Z0-9-]/g, "")}`;
}

export function frontmatter(values: Partial<Record<AppKey, string | boolean>>, extra: string[] = []): string {
  const lines = ["---"];
  for (const key of APP_KEYS) {
    const v = values[key];
    if (v !== undefined) lines.push(`${key}: ${yamlValue(v)}`);
  }
  lines.push(...extra, "---");
  return lines.join("\n");
}

/** Replaces only the given top-level keys; adds missing ones; leaves a note without frontmatter as it is. */
export function updateFrontmatter(content: string, updates: Partial<Record<AppKey, string | boolean>>): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return content;
  const afterClose = content.indexOf("\n", end + 4);
  const head = content.slice(4, end).split("\n");
  const rest = afterClose === -1 ? "" : content.slice(afterClose);
  const seen = new Set<string>();
  const out = head.map((line) => {
    const m = line.match(/^([A-Za-z_][\w-]*):/);
    const key = m?.[1] as AppKey | undefined;
    if (key && key in updates && (APP_KEYS as readonly string[]).includes(key)) {
      seen.add(key);
      return `${key}: ${yamlValue(updates[key] as string | boolean)}`;
    }
    return line;
  });
  for (const key of APP_KEYS) {
    if (key in updates && !seen.has(key)) out.push(`${key}: ${yamlValue(updates[key] as string | boolean)}`);
  }
  return `---\n${out.join("\n")}\n---${rest}`;
}

/** Ticks or unticks the app's own task line for an item. Returns the content unchanged if the line is gone. */
export function setTaskDone(content: string, itemId: string, done: boolean): string {
  const id = blockId(itemId);
  const re = new RegExp(`^(\\s*- \\[)[ xX](\\].*\\^${id})\\s*$`, "m");
  return content.replace(re, `$1${done ? "x" : " "}$2`);
}

/** The app's task line for an item: "- [ ] Task 📅 2026-10-26 ^it-<id>". */
export function taskLine(itemId: string, triage: Triage | null): string {
  const task = triage?.task || (triage ? "" : "Triage this message by hand");
  if (!task) return "";
  const due = triage?.due_date ? ` 📅 ${triage.due_date}` : "";
  const done = triage && !triage.needs_reply ? "x" : " ";
  return `- [${done}] ${task}${due} ^${blockId(itemId)}`;
}

/** Swaps the app's task line for an item (after a retried triage). Adds it at the end if it is gone. */
export function replaceTaskLine(content: string, itemId: string, line: string): string {
  const re = new RegExp(`^\\s*- \\[[ xX]\\].*\\^${blockId(itemId)}\\s*$`, "m");
  if (re.test(content)) return content.replace(re, line);
  return line ? appendSection(content, `${line}\n`) : content;
}

export interface SectionInput {
  itemId: string;
  receivedLocal: string;
  fromName: string;
  fromEmail: string;
  link: string;
  onlyCc: boolean;
  body: string;
  attachments: FiledAttachment[];
  triage: Triage | null;
  triageError: string;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
}

function sizeLabel(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function messageSection(s: SectionInput): string {
  const flags = [`[Open in Gmail](${s.link})`];
  if (s.onlyCc) flags.push("you were in cc");
  if (s.triage?.review_required) flags.push("review required");
  const lines = [`## ${s.receivedLocal} · ${s.fromName || s.fromEmail}`, flags.join(" · "), "", quote(s.body), ""];

  if (s.triage) {
    lines.push(`**Summary:** ${s.triage.summary}`);
    lines.push(`**Urgency:** ${s.triage.urgency} (${s.triage.urgency_score}). ${s.triage.urgency_reason}`);
    lines.push("");
  } else if (s.triageError) {
    lines.push(`**Triage failed:** ${s.triageError}`, "");
  }

  if (s.attachments.length) {
    lines.push("**Attachments:**");
    for (const a of s.attachments) {
      lines.push(
        a.inVault
          ? `- [[${a.path}|${a.filename}]]`
          : `- ${a.filename} (${sizeLabel(a.size)}, over the Obsidian Sync file limit; kept on the Mac mini at \`${a.path}\`)`,
      );
    }
    lines.push("");
  }

  const task = taskLine(s.itemId, s.triage);
  if (task) lines.push(task, "");
  return lines.join("\n");
}

export function newNote(fm: Partial<Record<AppKey, string | boolean>>, title: string, firstSection: string): string {
  return `${frontmatter(fm, ["tags: [inbox, gmail]"])}\n# ${title}\n\n${firstSection}`;
}

export function appendSection(content: string, section: string): string {
  const base = content.endsWith("\n") ? content : `${content}\n`;
  return `${base}\n${section}`;
}
