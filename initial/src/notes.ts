import fs from "node:fs";
import path from "node:path";
import type { LoadedConfig } from "./config.js";
import {
  attachmentLine,
  blockId,
  insertSection,
  sentBlockId,
  sentSection,
  replaceAttachmentLine,
  replaceByHandTask,
  replaceTriageFailed,
  setTaskDone,
  taskLine,
  updateFrontmatter,
} from "./obsidian/note.js";
import type { VaultWriter } from "./obsidian/writer.js";
import { matchContact, needsReview } from "./scope.js";
import { OPEN_STATUSES, type Item, type OutboxEntry, type Status, type Store } from "./store/db.js";
import { URGENCIES, type Urgency } from "./triage/schema.js";
import { localIso, localStamp, log } from "./util/time.js";

// Renamed or moved notes are looked for in at most this many Markdown files.
const MAX_NOTES_SCANNED = 5_000;

const urgencyOf = (i: Item): Urgency | undefined => i.userUrgency ?? i.triage?.urgency;

/**
 * Keeps each thread's note in line with the store. It needs only the vault, so choices made in the
 * dashboard reach the notes even while Gmail is signed out. Every update is safe to repeat: one
 * that fails is redone on the next poll.
 */
export class ThreadNotes {
  constructor(
    private readonly cfg: LoadedConfig,
    private readonly store: Store,
    private readonly vault: VaultWriter,
  ) {}

  /**
   * The thread's note in this matter, if it still exists and still holds this thread. A note you
   * renamed or moved in Obsidian is found again by its markers; a file that now holds something
   * else (another thread's note, or one of yours) is left alone. With search, a thread with no
   * recorded note is looked for in its matter's folder, where new notes are made: a retry after a
   * stop between writing a note and recording it.
   */
  noteFor(threadId: string, projectId: string, search = false): string | null {
    const stored = this.store.threadNote(threadId, projectId);
    if (!stored && !search) return null;
    const items = this.store.threadItems(threadId, projectId);
    if (stored && this.vault.exists(stored) && holdsThread(this.vault.read(stored), items)) return stored;
    const found = this.locate(items, projectId, Boolean(stored));
    if (found && found !== stored) {
      log(`note for thread ${threadId} is now ${found}`);
      this.store.setThreadNote(threadId, projectId, found);
    }
    return found;
  }

  /** Looks in the matter's folder first, then, with wholeVault, everywhere else. */
  private locate(items: Item[], projectId: string, wholeVault: boolean): string | null {
    if (!items.length) return null;
    const project = this.cfg.projects.find((p) => p.id === projectId);
    const roots = [project ? path.join(this.vault.vaultPath, project.folder) : null, wholeVault ? this.vault.vaultPath : null].filter((r): r is string => Boolean(r));
    let scanned = 0;
    const seen = new Set<string>();
    for (const root of roots) {
      const stack = [root];
      while (stack.length && scanned < MAX_NOTES_SCANNED) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.name.endsWith(".md") && !seen.has(full)) {
            seen.add(full);
            scanned++;
            try {
              if (holdsThread(fs.readFileSync(full, "utf8"), items)) return path.relative(this.vault.vaultPath, full).split(path.sep).join("/");
            } catch {
              // unreadable file: skip
            }
          }
        }
      }
    }
    return null;
  }

  /**
   * Brings the thread's note up to date with the store:
   *  - the frontmatter describes the open item that needs you most, otherwise the latest one;
   *  - a task's checkbox follows its item's status after the status changes;
   *  - a triage that succeeded on retry replaces its "Triage failed" lines;
   *  - an attachment saved on retry replaces its "not saved yet" line.
   * Your own text, and tasks you ticked yourself, are left alone. Returns false when the note could
   * not be written; it stays marked and the next poll tries again.
   */
  sync(threadId: string, projectId: string): boolean {
    try {
      const items = this.store.threadItems(threadId, projectId);
      const filed = items.filter((i) => i.notePath);
      const notePath = filed.length ? this.noteFor(threadId, projectId) : null;
      if (!notePath) {
        // Nothing filed yet (filing writes the current state), or you deleted the note.
        this.store.setNoteStale(threadId, projectId, false);
        return true;
      }
      const changed = new Set(this.store.statusChangedIds(threadId, projectId));
      const before = this.vault.read(notePath);
      let next = before;
      for (const i of filed) {
        if (i.triage) {
          next = replaceTriageFailed(next, i.id, i.triage);
          next = replaceByHandTask(next, i.id, taskLine(i.id, i.triage));
        }
        for (const a of i.attachments) {
          if (a.saved !== false && a.index !== undefined) next = replaceAttachmentLine(next, i.id, a.index, attachmentLine(i.id, a));
        }
        if (changed.has(i.id)) next = setTaskDone(next, i.id, !OPEN_STATUSES.includes(i.status));
      }
      const lead = leadItem(filed);
      const contact = matchContact(this.cfg, lead.fromEmail)?.contact;
      next = updateFrontmatter(next, {
        gmail: lead.link,
        from: lead.fromName ? `${lead.fromName} <${lead.fromEmail}>` : lead.fromEmail,
        status: lead.status,
        urgency: urgencyOf(lead) ?? "",
        reply_by: lead.triage?.reply_by ?? "",
        due: lead.triage?.due_date ?? "",
        review_required: lead.triage?.review_required ?? (Boolean(contact && needsReview(contact)) || lead.senderVerified === false),
      });
      if (next !== before) this.vault.write(notePath, updateFrontmatter(next, { updated: localIso(new Date(), this.cfg.tz) }));
      this.store.setNoteStale(threadId, projectId, false);
      return true;
    } catch (err) {
      log(`could not update the note for thread ${threadId}; it is tried again on the next poll`, err);
      try {
        this.store.setNoteStale(threadId, projectId, true);
      } catch {
        // the store is unavailable too; the flags set with the change itself still stand
      }
      return false;
    }
  }

  /**
   * Adds what you sent from the dashboard to the thread's note, in date order. Safe to repeat: a
   * reply already in the note is not added again. False when the note could not be written yet.
   */
  recordSent(item: Item, sent: OutboxEntry): boolean {
    try {
      const notePath = this.noteFor(item.threadId, item.projectId);
      if (!notePath) return true;
      const content = this.vault.read(notePath);
      if (new RegExp(`\\^${sentBlockId(sent.id)}[ \\t]*$`, "m").test(content)) return true;
      const stamp = localStamp(new Date(sent.sentAt ?? Date.now()), this.cfg.tz);
      const section = sentSection({ outboxId: sent.id, sentLocal: stamp, kind: sent.kind, to: sent.to, cc: sent.cc, body: sent.body });
      this.vault.write(notePath, insertSection(content, section, stamp));
      return true;
    } catch (err) {
      log(`could not add the sent reply ${sent.id} to the note; it is tried again`, err);
      return false;
    }
  }

  /** Changes an item's status and its note. noteUpdated is false when the note waits for the next poll. */
  setStatus(id: string, status: Status, reason: string): { item: Item; noteUpdated: boolean } | null {
    const before = this.store.get(id);
    if (!before) return null;
    if (status === "needs_reply" && !OPEN_STATUSES.includes(before.status)) this.store.reopen(id);
    else this.store.setStatus(id, status, reason);
    const item = this.store.get(id);
    if (!item) return null;
    return { item, noteUpdated: this.sync(item.threadId, item.projectId) };
  }

  /** Your own urgency rating: it replaces Claude's in the dashboard and in the note. */
  setUserUrgency(id: string, urgency: Urgency | null): boolean {
    this.store.setUserUrgency(id, urgency);
    const item = this.store.get(id);
    return item ? this.sync(item.threadId, item.projectId) : true;
  }
}

/** Whether a note holds one of these items: its task line, an attachment line or its Gmail link. */
function holdsThread(content: string, items: Item[]): boolean {
  return items.some((i) => {
    const id = blockId(i.id);
    return new RegExp(`\\^${id}(?![A-Za-z0-9-])|\\^at-${id.slice(3)}-\\d`).test(content) || (i.link !== "" && content.includes(`(<${i.link}>)`));
  });
}

/** The most urgent open item, the earliest first among equals; with nothing open, the latest item. */
function leadItem(items: Item[]): Item {
  const open = items.filter((i) => OPEN_STATUSES.includes(i.status));
  if (!open.length) return items[items.length - 1]!;
  const rank = (i: Item) => {
    const u = urgencyOf(i);
    return u ? URGENCIES.indexOf(u) : URGENCIES.length;
  };
  return [...open].sort((a, b) => rank(a) - rank(b))[0]!;
}
