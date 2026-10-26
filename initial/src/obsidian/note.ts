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
 * Makes email text inert and faithful in Obsidian: it renders as exactly the characters sent.
 * Inline: no links or images ([ ]), HTML or entities (< &), code or Dataview (`), tags (#),
 * comments (%), emphasis (* _ ~ =), maths ($) or tables (|). At the start of a line: no
 * numbered or bulleted list ("30. 10. 2026." stays a date), quote (>) or heading underline.
 */
export function escapeMd(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/\\/g, "\\\\")
        .replace(/[`\[\]#%*_~=$|]/g, (c) => `\\${c}`)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/^(\s*)(\d{1,9})([.)])/, "$1$2\\$3")
        .replace(/^(\s*)([-+>])/, "$1\\$2"),
    )
    .join("\n");
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
  // [ \t], not \s: a blank line after the task, and your text below it, must stay where they are.
  const re = new RegExp(`^([ \\t]*- \\[)[ xX](\\].*\\^${id})[ \\t]*$`, "m");
  return content.replace(re, `$1${done ? "x" : " "}$2`);
}

const BY_HAND = "Triage this message by hand";

/** The app's task line for an item: "- [ ] Task 📅 2026-10-26 ^it-<id>". */
export function taskLine(itemId: string, triage: Triage | null, done = false): string {
  const task = triage ? escapeMd(singleLine(triage.task)) : BY_HAND;
  if (!task) return "";
  const due = triage?.due_date ? ` 📅 ${triage.due_date}` : "";
  // Open until you reply, finish it or mark it as needing nothing.
  return `- [${done ? "x" : " "}] ${task}${due} ^${blockId(itemId)}`;
}

/**
 * After a retried triage succeeds: swaps the "Triage this message by hand" line for the real task,
 * or removes it when there is none. A task line you edited, or one already swapped, stays.
 */
export function replaceByHandTask(content: string, itemId: string, line: string): string {
  const re = new RegExp(`^[ \\t]*- \\[[ xX]\\] ${BY_HAND} \\^${blockId(itemId)}[ \\t]*$\\n?`, "m");
  return content.replace(re, line ? `${line}\n` : "");
}

/** Whether the note already holds an item's section: its task line or its Gmail link. */
export function hasSection(content: string, itemId: string, link: string): boolean {
  return new RegExp(`\\^${blockId(itemId)}[ \\t]*$`, "m").test(content) || content.includes(`(<${link}>)`);
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

/** The app's line for one attachment; an unsaved one carries a block id so a later retry can replace it. */
export function attachmentLine(itemId: string, a: FiledAttachment): string {
  const label = singleLine(a.filename).replace(/[[\]|#^]/g, " ").trim() || "attachment";
  if (a.saved === false) {
    return `- ${escapeMd(label)} (${sizeLabel(a.size)}): not saved yet, it is retried; open the message in Gmail meanwhile ^at-${blockId(itemId).slice(3)}-${a.index ?? 0}`;
  }
  return a.inVault
    ? `- [[${a.path}|${label}]]`
    : `- ${escapeMd(label)} (${sizeLabel(a.size)}, over the Obsidian Sync file limit; kept on the Mac mini at ${escapeMd(a.path)})`;
}

/** Swaps the "not saved yet" line of an attachment for its saved line. */
export function replaceAttachmentLine(content: string, itemId: string, index: number, line: string): string {
  const re = new RegExp(`^- .*\\^at-${blockId(itemId).slice(3)}-${index}[ \\t]*$`, "m");
  return content.replace(re, line);
}

const HEADING_STAMP = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) /;

/**
 * Adds a message section in date order: before the first section that is later, by its heading's
 * minute or, within the same minute, by holding one of laterLinks (the Gmail links of later
 * messages). Otherwise at the end. Your own text between sections stays where it is.
 */
export function insertSection(content: string, section: string, stamp: string, laterLinks: string[] = []): string {
  const lines = content.split("\n");
  const holdsLater = (from: number) => {
    for (let j = from + 1; j < lines.length && !HEADING_STAMP.test(lines[j]!); j++) {
      if (laterLinks.some((link) => link && lines[j]!.includes(`(<${link}>)`))) return true;
    }
    return false;
  };
  const at = lines.findIndex((l, idx) => {
    const m = l.match(HEADING_STAMP);
    return m !== null && (m[1]! > stamp || (m[1] === stamp && holdsLater(idx)));
  });
  if (at === -1) return appendSection(content, section);
  const block = section.endsWith("\n") ? section : `${section}\n`;
  return [...lines.slice(0, at), ...block.split("\n"), ...lines.slice(at)].join("\n");
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
  // Quoted or forwarded text after the new part; shown folded under it.
  quoted: string;
  attachments: FiledAttachment[];
  triage: Triage | null;
  triageError: string;
  // The item is closed already (answered, or marked in the dashboard), so its task starts ticked.
  done?: boolean;
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
  if (s.quoted) lines.push("> [!quote]- Quoted or forwarded text", quote(escapeMd(s.quoted)), "");

  if (s.triage) {
    lines.push(...triageLines(s.triage), "");
  } else if (s.triageError) {
    lines.push(`**Triage failed:** ${escapeMd(singleLine(s.triageError))}`, "");
  }

  if (s.attachments.length) {
    lines.push("**Attachments:**");
    for (const a of s.attachments) lines.push(attachmentLine(s.itemId, a));
    lines.push("");
  }

  const task = taskLine(s.itemId, s.triage, s.done);
  if (task) lines.push(task, "");
  return lines.join("\n");
}

/** Block id of the app's line for a reply sent from the dashboard. */
export function sentBlockId(outboxId: string): string {
  return `out-${outboxId.replace(/[^a-zA-Z0-9-]/g, "")}`;
}

/** What you sent from the dashboard, in the thread's note: who it went to, then your text quoted. */
export function sentSection(s: { outboxId: string; sentLocal: string; kind: "reply" | "ack"; to: string[]; cc: string[]; body: string }): string {
  const who = [`To: ${s.to.join(", ")}`, ...(s.cc.length ? [`Cc: ${s.cc.join(", ")}`] : [])].join(" · ");
  return [
    `## ${s.sentLocal} · ${s.kind === "ack" ? "You acknowledged" : "You replied"}`,
    `${escapeMd(singleLine(who))} ^${sentBlockId(s.outboxId)}`,
    "",
    quote(escapeMd(s.body)),
    "",
  ].join("\n");
}

export function newNote(fm: Partial<Record<AppKey, string | boolean>>, title: string, firstSection: string): string {
  return `${frontmatter(fm, ["tags: [inbox, gmail]"])}\n# ${escapeMd(singleLine(title))}\n\n${firstSection}`;
}

export function appendSection(content: string, section: string): string {
  const base = content.endsWith("\n") ? content : `${content}\n`;
  return `${base}\n${section}`;
}
