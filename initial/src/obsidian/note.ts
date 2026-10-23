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

/**
 * A YAML scalar that Obsidian reads back as the same text. Plain only when it starts with a letter
 * and cannot be read as a boolean or null (YAML 1.1 included), or when it is a date we wrote.
 */
export function yamlValue(value: string | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === "") return '""';
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value)) return value;
  const plain =
    /^\p{L}[\p{L}\p{N} ._\-–—@+/()&,']*$/u.test(value) && !/^(y|n|yes|no|true|false|on|off|null)$/i.test(value) && !/\s$/.test(value);
  return plain ? value : JSON.stringify(value);
}

/** One line of text: newlines and runs of spaces become one space. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Makes email text inert in Obsidian: no images or links ([ ]), no HTML (<), no code or Dataview
 * (`), no tags (#), no comments (%), no escapes (\). It still reads as the same text.
 */
export function escapeMd(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/[`\[\]#%]/g, (c) => `\\${c}`)
    .replace(/</g, "&lt;");
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
  const task = triage ? escapeMd(singleLine(triage.task)) : "Triage this message by hand";
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

/** The summary and urgency lines a successful triage adds to a message section. */
function triageLines(t: Triage): string[] {
  return [`**Summary:** ${escapeMd(singleLine(t.summary))}`, `**Urgency:** ${t.urgency} (${t.urgency_score}). ${escapeMd(singleLine(t.urgency_reason))}`];
}

/**
 * After a retried triage succeeds: swaps the item's "Triage failed" line for the summary and
 * urgency lines. Only looks inside the item's own section, between its heading and its task line.
 */
export function replaceTriageFailed(content: string, itemId: string, triage: Triage): string {
  const lines = content.split("\n");
  const taskAt = lines.findIndex((l) => new RegExp(`\\^${blockId(itemId)}\\s*$`).test(l));
  if (taskAt === -1) return content;
  for (let i = taskAt - 1; i >= 0 && !(lines[i] ?? "").startsWith("## "); i--) {
    if ((lines[i] ?? "").startsWith("**Triage failed:**")) {
      lines.splice(i, 1, ...triageLines(triage));
      return lines.join("\n");
    }
  }
  return content;
}

export interface SectionInput {
  itemId: string;
  receivedLocal: string;
  fromName: string;
  fromEmail: string;
  // Gmail's sender authentication; false is flagged in the note.
  senderVerified: boolean | null;
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
  const flags = [`[Open in Gmail](<${s.link}>)`];
  if (s.senderVerified === false) flags.push("**sender not verified by Gmail: check before trusting it**");
  if (s.onlyCc) flags.push("you were in cc");
  if (s.triage?.review_required) flags.push("review required");
  const who = escapeMd(singleLine(s.fromName ? `${s.fromName} (${s.fromEmail})` : s.fromEmail));
  const lines = [`## ${s.receivedLocal} · ${who}`, flags.join(" · "), "", quote(escapeMd(s.body)), ""];

  if (s.triage) {
    lines.push(...triageLines(s.triage), "");
  } else if (s.triageError) {
    lines.push(`**Triage failed:** ${escapeMd(singleLine(s.triageError))}`, "");
  }

  if (s.attachments.length) {
    lines.push("**Attachments:**");
    for (const a of s.attachments) {
      const label = singleLine(a.filename).replace(/[[\]|#^]/g, " ").trim() || "attachment";
      lines.push(
        a.inVault
          ? `- [[${a.path}|${label}]]`
          : `- ${escapeMd(label)} (${sizeLabel(a.size)}, over the Obsidian Sync file limit; kept on the Mac mini at ${escapeMd(a.path)})`,
      );
    }
    lines.push("");
  }

  const task = taskLine(s.itemId, s.triage);
  if (task) lines.push(task, "");
  return lines.join("\n");
}

export function newNote(fm: Partial<Record<AppKey, string | boolean>>, title: string, firstSection: string): string {
  return `${frontmatter(fm, ["tags: [inbox, gmail]"])}\n# ${escapeMd(singleLine(title))}\n\n${firstSection}`;
}

export function appendSection(content: string, section: string): string {
  const base = content.endsWith("\n") ? content : `${content}\n`;
  return `${base}\n${section}`;
}
