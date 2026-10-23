import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { LANGUAGES, type Language, type LoadedConfig, type ProjectConfig } from "./config.js";
import type { GmailReader } from "./gmail/client.js";
import { gmailLink } from "./gmail/links.js";
import { isNoiseAttachment, quotedRest, type ParsedMessage } from "./gmail/parse.js";
import {
  attachmentLine,
  blockId,
  insertSection,
  messageSection,
  newNote,
  replaceAttachmentLine,
  replaceTaskLine,
  replaceTriageFailed,
  setTaskDone,
  taskLine,
  updateFrontmatter,
  type AppKey,
} from "./obsidian/note.js";
import { cleanSubject, noteRelPath, type VaultWriter } from "./obsidian/writer.js";
import { answers, isOnlyCc, isOwner, gmailScopeQuery, matchContact, needsReview, replyRoute, rulesFingerprint } from "./scope.js";
import { OPEN_STATUSES, type FiledAttachment, type Item, type Status, type Store } from "./store/db.js";
import { callClaude, finalize, TriageError, type Triage } from "./triage/claude.js";
import { URGENCIES, type Urgency } from "./triage/schema.js";
import { localIso, localStamp, log } from "./util/time.js";

const LAST_SEEN_KEY = "gmail.lastSeenEpoch";
const RULES_KEY = "rules.fingerprint";
// Each poll re-reads the last week. Messages already seen are skipped by id, so this costs one
// list call, and it catches mail that reaches the inbox late: rescued from spam, restored from
// trash, or indexed slowly.
const OVERLAP_SECONDS = 7 * 86_400;
// Renamed or moved notes are looked for in at most this many Markdown files.
const MAX_NOTES_SCANNED = 5_000;

/** A reply of yours: sent, not a draft or a scheduled message. */
function isSentReply(labelIds: string[]): boolean {
  return labelIds.includes("SENT") && !labelIds.includes("DRAFT") && !labelIds.includes("SCHEDULED");
}

/** Messages before msg in its thread; equal times are ordered by id, so two messages never quote each other. */
function earlierThan(thread: ParsedMessage[], msg: ParsedMessage): ParsedMessage[] {
  const t = msg.internalDate.getTime();
  return thread.filter((m) => m.id !== msg.id && (m.internalDate.getTime() < t || (m.internalDate.getTime() === t && m.id < msg.id)));
}

export interface PollResult {
  matched: number;
  ingested: number;
  failed: number;
  refiled: number;
  closedByReply: number;
}

export class Pipeline {
  constructor(
    private readonly cfg: LoadedConfig,
    private readonly store: Store,
    private readonly gmail: GmailReader,
    private readonly claude: Anthropic,
    private readonly vault: VaultWriter,
  ) {}

  async pollOnce(): Promise<PollResult> {
    const result: PollResult = { matched: 0, ingested: 0, failed: 0, refiled: 0, closedByReply: 0 };

    // Changed contact rules: mail skipped for having no rule is looked at again.
    const fingerprint = rulesFingerprint(this.cfg);
    if (this.store.getState(RULES_KEY) !== fingerprint) {
      const n = this.store.forgetUnmatchedSkips();
      if (n) log(`contact rules changed: ${n} skipped messages will be checked again`);
      this.store.setState(RULES_KEY, fingerprint);
    }

    const since = this.store.getState(LAST_SEEN_KEY);
    const query = gmailScopeQuery(this.cfg, since ? Number(since) - OVERLAP_SECONDS : undefined, this.cfg.gmail.initialLookbackDays);
    const listing = await this.gmail.listIds(query);
    if (listing.truncated) log(`Gmail returned more than ${listing.ids.length} matches; the oldest are not checked this time`);
    const ids = listing.ids.filter((id) => !this.store.has(id) && !this.store.isSkipped(id));

    // Fetch each message on its own, so one that cannot be read never blocks the others.
    const messages: ParsedMessage[] = [];
    for (const id of ids) {
      try {
        messages.push(await this.gmail.message(id));
      } catch (err) {
        result.failed++;
        log(`could not read message ${id}`, err);
        this.store.log(id, "fetch_failed", err instanceof Error ? err.message : String(err));
      }
    }
    // Oldest first, so sections land in a thread note in the order they were sent.
    messages.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime() || a.id.localeCompare(b.id));

    const nowSeconds = Math.floor(Date.now() / 1000);
    let newest = since ? Number(since) : 0;
    for (const msg of messages) {
      if (!msg.from.email) {
        // Unreadable From: leave it for the next poll rather than skipping it for good.
        result.failed++;
        this.store.log(msg.id, "ingest_failed", "From header could not be read");
        continue;
      }
      const match = matchContact(this.cfg, msg.from.email);
      if (!match || isOwner(this.cfg, msg.from.email)) {
        this.store.markSkipped(msg.id, match ? "from owner" : `no contact rule for ${msg.from.email}`);
        continue;
      }
      result.matched++;
      try {
        await this.ingest(msg);
        result.ingested++;
        // A message dated in the future never pushes the checkpoint past now.
        newest = Math.max(newest, Math.min(Math.floor(msg.internalDate.getTime() / 1000), nowSeconds));
      } catch (err) {
        result.failed++;
        log(`ingest failed for ${msg.id}`, err);
        this.store.log(msg.id, "ingest_failed", err instanceof Error ? err.message : String(err));
      }
    }
    if (newest) this.store.setState(LAST_SEEN_KEY, String(Math.min(newest, nowSeconds)));

    const refile = await this.refileUnfiled();
    result.refiled = refile.done;
    result.failed += refile.failed;
    await this.retryAttachments();
    result.closedByReply = await this.closeAnswered();
    return result;
  }

  private async ingest(msg: ParsedMessage): Promise<void> {
    const cfg = this.cfg;
    const match = matchContact(cfg, msg.from.email);
    if (!match) throw new Error(`no contact rule for ${msg.from.email}`);
    const { project, contact } = match;

    const thread = await this.gmail.thread(msg.threadId);
    const link = gmailLink({
      account: cfg.gmail.account,
      threadId: msg.threadId,
      messageId: msg.id,
      rfc822MessageId: msg.rfc822MessageId,
      threadIdIsMessageId: thread.some((m) => m.id === msg.threadId),
    });
    const onlyCc = isOnlyCc(cfg, msg.to.map((a) => a.email), msg.cc.map((a) => a.email));
    const route = replyRoute(match, msg.from, msg.replyTo);
    const attachments = await this.saveAttachments(msg, project, localIso(msg.internalDate, cfg.tz));

    const now = new Date().toISOString();
    const item: Item = {
      id: msg.id,
      channel: "gmail",
      threadId: msg.threadId,
      projectId: project.id,
      role: contact.role,
      fromName: msg.from.name,
      fromEmail: msg.from.email,
      to: msg.to.map((a) => a.email),
      cc: msg.cc.map((a) => a.email),
      subject: msg.subject,
      receivedAt: msg.internalDate.toISOString(),
      body: msg.latestText,
      fullText: msg.text,
      onlyCc,
      senderVerified: msg.senderVerified,
      replyToName: route.name,
      replyToEmail: route.email,
      replyRedirected: route.redirected,
      replyLanguage: route.language ?? "",
      link,
      attachments,
      notePath: "",
      status: "pending_triage",
      triage: null,
      triageError: "",
      draft: null,
      userUrgency: null,
      reopenedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    // Stored before triage and filing: if either fails or the service stops, refileUnfiled finishes it.
    this.store.insert(item);
    await this.file(item, msg, thread);
  }

  /** Saves a message's attachments; one that fails is recorded as not saved and retried later. */
  private async saveAttachments(msg: ParsedMessage, project: ProjectConfig, receivedIso: string): Promise<FiledAttachment[]> {
    const out: FiledAttachment[] = [];
    const refs = msg.attachments.filter((a) => !isNoiseAttachment(a));
    for (const [index, ref] of refs.entries()) {
      try {
        const data = await this.gmail.attachment(msg.id, ref);
        out.push({ ...this.vault.saveAttachment(project.folder, receivedIso, ref.filename, data, project.id), saved: true, index });
      } catch (err) {
        log(`attachment ${ref.filename} of ${msg.id} not saved yet`, err);
        this.store.log(msg.id, "attachment_failed", `${ref.filename}: ${err instanceof Error ? err.message : String(err)}`);
        out.push({ filename: ref.filename, size: ref.size, path: "", inVault: false, saved: false, index });
      }
    }
    return out;
  }

  /** Triage (when still needed) and the note for one stored item. */
  private async file(item: Item, msg: ParsedMessage, thread: ParsedMessage[]): Promise<void> {
    const cfg = this.cfg;
    const project = cfg.projects.find((p) => p.id === item.projectId);
    if (!project) throw new Error(`project ${item.projectId} is no longer in the config`);

    let triage = item.triage;
    let triageError = item.triageError;
    if (item.status === "pending_triage") ({ triage, triageError } = await this.runTriage(msg, earlierThan(thread, msg), item.onlyCc));

    const stamp = localStamp(msg.internalDate, cfg.tz);
    const section = messageSection({
      itemId: item.id,
      receivedLocal: stamp,
      fromName: item.fromName,
      fromEmail: item.fromEmail,
      senderVerified: item.senderVerified,
      link: item.link,
      onlyCc: item.onlyCc,
      body: item.body,
      quoted: quotedRest(item.fullText, item.body),
      attachments: item.attachments,
      triage,
      triageError,
    });

    // The note's identity (subject, sender, link) follows the newest message in the thread.
    const siblings = this.store.threadItems(item.threadId, item.projectId).filter((i) => i.id !== item.id && i.notePath);
    const isNewest = siblings.every((i) => i.receivedAt <= item.receivedAt);
    const identity: Partial<Record<AppKey, string | boolean>> = {
      source: "gmail",
      project: project.name,
      subject: cleanSubject(item.subject),
      gmail: item.link,
      from: item.fromName ? `${item.fromName} <${item.fromEmail}>` : item.fromEmail,
    };

    let rel = this.noteFor(item.threadId, item.projectId);
    if (rel) {
      const content = updateFrontmatter(this.vault.read(rel), isNewest ? identity : { project: project.name });
      this.vault.write(rel, insertSection(content, section, stamp));
    } else {
      rel = this.vault.freeNotePath(noteRelPath(project.folder, localIso(msg.internalDate, cfg.tz), item.subject));
      this.vault.write(rel, newNote(identity, cleanSubject(item.subject), section));
    }
    this.store.setNotePath(item.id, rel);
    this.store.setThreadNote(item.threadId, item.projectId, rel);
    this.syncNoteStatus(item.threadId, item.projectId);
    log(`filed ${item.id} (${project.id}) ${triage ? `${triage.urgency} ${triage.urgency_score}` : "triage failed"}`);
  }

  /**
   * The thread's note in this matter, if it still exists. A note you renamed or moved in Obsidian is
   * found again by its task markers, so the thread does not split into a second note.
   */
  private noteFor(threadId: string, projectId: string): string | null {
    const stored = this.store.threadNote(threadId, projectId);
    if (!stored) return null;
    if (this.vault.exists(stored)) return stored;
    const found = this.locateNote(threadId, projectId);
    if (found) {
      log(`note for thread ${threadId} moved to ${found}`);
      this.store.setThreadNote(threadId, projectId, found);
    }
    return found;
  }

  private locateNote(threadId: string, projectId: string): string | null {
    const markers = this.store.threadItems(threadId, projectId).flatMap((i) => [`^${blockId(i.id)}`, `^at-${blockId(i.id).slice(3)}-`]);
    if (!markers.length) return null;
    const project = this.cfg.projects.find((p) => p.id === projectId);
    const roots = [project ? path.join(this.vault.vaultPath, project.folder) : null, this.vault.vaultPath].filter((r): r is string => Boolean(r));
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
              const text = fs.readFileSync(full, "utf8");
              if (markers.some((m) => text.includes(m))) return path.relative(this.vault.vaultPath, full).split(path.sep).join("/");
            } catch {
              // unreadable file: skip
            }
          }
        }
      }
    }
    return null;
  }

  /** Finishes items stored without a note: a failed vault write, or a stop in the middle of triage. */
  private async refileUnfiled(): Promise<{ done: number; failed: number }> {
    let done = 0;
    let failed = 0;
    for (const item of this.store.unfiled()) {
      try {
        const msg = await this.gmail.message(item.id);
        const thread = await this.gmail.thread(item.threadId);
        await this.file(item, msg, thread);
        done++;
      } catch (err) {
        failed++;
        log(`could not file ${item.id} yet`, err);
        this.store.log(item.id, "file_failed", err instanceof Error ? err.message : String(err));
      }
    }
    return { done, failed };
  }

  /** Tries again to save attachments that failed to download, and updates their lines in the note. */
  private async retryAttachments(): Promise<void> {
    for (const item of this.store.withUnsavedAttachments()) {
      const project = this.cfg.projects.find((p) => p.id === item.projectId);
      if (!project) continue;
      let msg: ParsedMessage;
      try {
        msg = await this.gmail.message(item.id);
      } catch {
        continue;
      }
      const refs = msg.attachments.filter((a) => !isNoiseAttachment(a));
      const updated = [...item.attachments];
      let changed = false;
      for (const [i, a] of updated.entries()) {
        if (a.saved !== false) continue;
        const ref = refs[a.index ?? -1];
        if (!ref || ref.filename !== a.filename) continue;
        try {
          const data = await this.gmail.attachment(item.id, ref);
          updated[i] = { ...this.vault.saveAttachment(project.folder, localIso(new Date(item.receivedAt), this.cfg.tz), ref.filename, data, project.id), saved: true, index: a.index };
          changed = true;
          if (item.notePath && this.vault.exists(item.notePath)) {
            this.vault.write(item.notePath, replaceAttachmentLine(this.vault.read(item.notePath), item.id, a.index ?? 0, attachmentLine(item.id, updated[i]!)));
          }
        } catch (err) {
          log(`attachment ${a.filename} of ${item.id} still not saved`, err);
        }
      }
      if (changed) this.store.setAttachments(item.id, updated);
    }
  }

  /** Calls Claude and applies the fixed rules; stores the result or the error. */
  private async runTriage(msg: ParsedMessage, earlier: ParsedMessage[], onlyCc: boolean): Promise<{ triage: Triage | null; triageError: string }> {
    const cfg = this.cfg;
    const match = matchContact(cfg, msg.from.email);
    if (!match) throw new Error(`no contact rule for ${msg.from.email}`);
    const { project, contact } = match;
    const route = replyRoute(match, msg.from, msg.replyTo);
    try {
      const { result, model } = await callClaude(this.claude, cfg, {
        ownerName: cfg.owner.name,
        now: new Date(),
        tz: cfg.tz,
        projectName: project.name,
        role: contact.role,
        reviewRequired: needsReview(contact),
        onlyCc,
        senderVerified: msg.senderVerified,
        route,
        replyLanguage: route.language ?? null,
        signOffs: cfg.signOffs,
        message: msg,
        earlier,
      });
      const lang: Language =
        route.language ?? ((LANGUAGES as readonly string[]).includes(result.message_language) ? (result.message_language as Language) : "en");
      const triage = finalize(result, {
        reviewRequired: needsReview(contact),
        alwaysUrgent: contact.alwaysUrgent,
        signOff: cfg.signOffs[lang],
        model,
        senderVerified: msg.senderVerified,
        tz: cfg.tz,
      });
      this.store.saveTriage(msg.id, triage);
      return { triage, triageError: "" };
    } catch (err) {
      const triageError = err instanceof TriageError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      this.store.saveTriageError(msg.id, triageError);
      return { triage: null, triageError };
    }
  }

  /** Runs triage again for an item that failed or never finished, and repairs its note. */
  async retriage(id: string): Promise<Item | null> {
    const item = this.store.get(id);
    if (!item) return null;
    if (item.status !== "triage_failed" && item.status !== "pending_triage") return item;
    const msg = await this.gmail.message(id);
    const thread = await this.gmail.thread(msg.threadId);
    const { triage } = await this.runTriage(msg, earlierThan(thread, msg), item.onlyCc);
    const notePath = triage ? this.noteFor(item.threadId, item.projectId) : null;
    if (triage && notePath) {
      let content = this.vault.read(notePath);
      content = replaceTriageFailed(content, id, triage);
      content = replaceTaskLine(content, id, taskLine(id, triage));
      this.vault.write(notePath, content);
      this.syncNoteStatus(item.threadId, item.projectId);
    }
    return this.store.get(id);
  }

  /**
   * Open items answered elsewhere (Gmail, Superhuman): a later sent message of yours in the thread,
   * addressed to the sender, the reply address or the sender's domain. A forward to someone else
   * does not count.
   */
  private async closeAnswered(): Promise<number> {
    let closed = 0;
    for (const threadId of this.store.openThreadIds()) {
      let meta;
      try {
        meta = await this.gmail.threadMeta(threadId);
      } catch (err) {
        log(`could not check thread ${threadId}`, err);
        continue;
      }
      const sent = meta.filter((m) => isSentReply(m.labelIds));
      for (const item of this.store.openInThread(threadId)) {
        // A reply closes what asked for a reply; a task without a reply (needs_action) waits for you.
        if (item.status === "pending_triage" || item.status === "needs_action") continue;
        const after = Math.max(new Date(item.receivedAt).getTime(), item.reopenedAt ? new Date(item.reopenedAt).getTime() : 0);
        if (sent.some((m) => m.internalDate.getTime() > after && answers(m.recipients, item))) {
          this.setStatus(item.id, "replied", "reply found in Gmail");
          closed++;
        }
      }
    }
    return closed;
  }

  /** Changes an item's status and mirrors it in its note: the task checkbox and the thread's status. */
  setStatus(id: string, status: Status, reason: string): Item | null {
    const before = this.store.get(id);
    if (!before) return null;
    if (status === "needs_reply" && !OPEN_STATUSES.includes(before.status)) this.store.reopen(id);
    else this.store.setStatus(id, status, reason);
    const item = this.store.get(id);
    if (!item) return null;
    const notePath = this.noteFor(item.threadId, item.projectId);
    if (!notePath) return item;
    try {
      this.vault.write(notePath, setTaskDone(this.vault.read(notePath), id, !OPEN_STATUSES.includes(item.status)));
      this.syncNoteStatus(item.threadId, item.projectId);
    } catch (err) {
      log(`could not update note for ${id}`, err);
    }
    return item;
  }

  /** Your own urgency rating: it replaces Claude's in the dashboard and in the note. */
  setUserUrgency(id: string, urgency: Urgency | null): void {
    this.store.setUserUrgency(id, urgency);
    const item = this.store.get(id);
    if (item) this.syncNoteStatus(item.threadId, item.projectId);
  }

  /**
   * One note holds a thread within one matter, so its status, urgency, dates and review flag
   * describe the thread: the most urgent open item if any is open, otherwise the latest item.
   */
  private syncNoteStatus(threadId: string, projectId: string): void {
    const items = this.store.threadItems(threadId, projectId);
    const notePath = this.noteFor(threadId, projectId);
    if (!items.length || !notePath) return;
    const open = items.filter((i) => OPEN_STATUSES.includes(i.status));
    const urgencyOf = (i: Item) => i.userUrgency ?? i.triage?.urgency;
    const rank = (i: Item) => {
      const u = urgencyOf(i);
      return u ? URGENCIES.indexOf(u) : URGENCIES.length;
    };
    const lead = open.length ? [...open].sort((a, b) => rank(a) - rank(b))[0]! : items[items.length - 1]!;
    const contact = matchContact(this.cfg, lead.fromEmail)?.contact;
    try {
      const content = updateFrontmatter(this.vault.read(notePath), {
        status: lead.status,
        urgency: urgencyOf(lead) ?? "",
        reply_by: lead.triage?.reply_by ?? "",
        due: lead.triage?.due_date ?? "",
        review_required: lead.triage?.review_required ?? (Boolean(contact && needsReview(contact)) || lead.senderVerified === false),
        updated: localIso(new Date(), this.cfg.tz),
      });
      this.vault.write(notePath, content);
    } catch (err) {
      log(`could not update the status of ${notePath}`, err);
    }
  }
}
