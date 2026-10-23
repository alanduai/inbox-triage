import type Anthropic from "@anthropic-ai/sdk";
import { LANGUAGES, type Language, type LoadedConfig } from "./config.js";
import type { GmailReader } from "./gmail/client.js";
import { gmailLink } from "./gmail/links.js";
import { isNoiseAttachment, type ParsedMessage } from "./gmail/parse.js";
import {
  appendSection,
  messageSection,
  newNote,
  replaceTaskLine,
  replaceTriageFailed,
  setTaskDone,
  taskLine,
  updateFrontmatter,
  type AppKey,
} from "./obsidian/note.js";
import { cleanSubject, noteRelPath, type VaultWriter } from "./obsidian/writer.js";
import { isOnlyCc, isOwner, gmailScopeQuery, matchContact, replyRoute } from "./scope.js";
import { OPEN_STATUSES, type FiledAttachment, type Item, type Status, type Store } from "./store/db.js";
import { callClaude, finalize, TriageError, type Triage } from "./triage/claude.js";
import { URGENCIES } from "./triage/schema.js";
import { localIso, localStamp, log } from "./util/time.js";

const LAST_SEEN_KEY = "gmail.lastSeenEpoch";
// Each poll re-reads the last week. Messages already seen are skipped by id, so this costs one
// list call, and it catches mail that reaches the inbox late: rescued from spam, restored from
// trash, or indexed slowly.
const OVERLAP_SECONDS = 7 * 86_400;

/** A reply of yours: sent, not a draft or a scheduled message. */
function isSentReply(labelIds: string[]): boolean {
  return labelIds.includes("SENT") && !labelIds.includes("DRAFT") && !labelIds.includes("SCHEDULED");
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
    messages.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());

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
        newest = Math.max(newest, Math.floor(msg.internalDate.getTime() / 1000));
      } catch (err) {
        result.failed++;
        log(`ingest failed for ${msg.id}`, err);
        this.store.log(msg.id, "ingest_failed", err instanceof Error ? err.message : String(err));
      }
    }
    if (newest) this.store.setState(LAST_SEEN_KEY, String(newest));

    result.refiled = await this.refileUnfiled();
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
    const route = replyRoute(match, msg.from);
    const receivedIso = localIso(msg.internalDate, cfg.tz);

    const attachments: FiledAttachment[] = [];
    for (const ref of msg.attachments.filter((a) => !isNoiseAttachment(a))) {
      try {
        const data = await this.gmail.attachment(msg.id, ref);
        attachments.push(this.vault.saveAttachment(project.folder, receivedIso, ref.filename, data, project.id));
      } catch (err) {
        log(`attachment ${ref.filename} of ${msg.id} not saved`, err);
        this.store.log(msg.id, "attachment_failed", `${ref.filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

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

  /** Triage (when still needed) and the note for one stored item. */
  private async file(item: Item, msg: ParsedMessage, thread: ParsedMessage[]): Promise<void> {
    const cfg = this.cfg;
    const project = cfg.projects.find((p) => p.id === item.projectId);
    if (!project) throw new Error(`project ${item.projectId} is no longer in the config`);
    const earlier = thread.filter((m) => m.id !== msg.id && m.internalDate.getTime() <= msg.internalDate.getTime());

    let triage = item.triage;
    let triageError = item.triageError;
    if (item.status === "pending_triage") ({ triage, triageError } = await this.runTriage(msg, earlier, item.onlyCc));

    const section = messageSection({
      itemId: item.id,
      receivedLocal: localStamp(msg.internalDate, cfg.tz),
      fromName: item.fromName,
      fromEmail: item.fromEmail,
      senderVerified: item.senderVerified,
      link: item.link,
      onlyCc: item.onlyCc,
      body: item.body,
      attachments: item.attachments,
      triage,
      triageError,
    });
    const fm: Partial<Record<AppKey, string | boolean>> = {
      source: "gmail",
      project: project.name,
      subject: cleanSubject(item.subject),
      gmail: item.link,
      from: item.fromName ? `${item.fromName} <${item.fromEmail}>` : item.fromEmail,
      review_required: triage?.review_required ?? (Boolean(matchContact(cfg, item.fromEmail)?.contact.reviewRequired) || item.senderVerified === false),
      updated: localIso(new Date(), cfg.tz),
    };

    const existing = this.store.threadNote(item.threadId);
    let rel: string;
    if (existing && this.vault.exists(existing)) {
      rel = existing;
      this.vault.write(rel, appendSection(updateFrontmatter(this.vault.read(rel), fm), section));
    } else {
      rel = this.vault.freeNotePath(noteRelPath(project.folder, localIso(msg.internalDate, cfg.tz), item.subject));
      this.vault.write(rel, newNote(fm, cleanSubject(item.subject), section));
      this.store.setThreadNote(item.threadId, project.id, rel);
    }
    this.store.setNotePath(item.id, rel);
    this.syncNoteStatus(item.threadId);
    log(`filed ${item.id} (${project.id}) ${triage ? `${triage.urgency} ${triage.urgency_score}` : "triage failed"}`);
  }

  /** Finishes items stored without a note: a failed vault write, or a stop in the middle of triage. */
  private async refileUnfiled(): Promise<number> {
    let done = 0;
    for (const item of this.store.unfiled()) {
      try {
        const msg = await this.gmail.message(item.id);
        const thread = await this.gmail.thread(item.threadId);
        await this.file(item, msg, thread);
        done++;
      } catch (err) {
        log(`could not file ${item.id} yet`, err);
      }
    }
    return done;
  }

  /** Calls Claude and applies the fixed rules; stores the result or the error. */
  private async runTriage(msg: ParsedMessage, earlier: ParsedMessage[], onlyCc: boolean): Promise<{ triage: Triage | null; triageError: string }> {
    const cfg = this.cfg;
    const match = matchContact(cfg, msg.from.email);
    if (!match) throw new Error(`no contact rule for ${msg.from.email}`);
    const { project, contact } = match;
    const route = replyRoute(match, msg.from);
    try {
      const { result, model } = await callClaude(this.claude, cfg, {
        ownerName: cfg.owner.name,
        now: new Date(),
        tz: cfg.tz,
        projectName: project.name,
        role: contact.role,
        reviewRequired: contact.reviewRequired,
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
        reviewRequired: contact.reviewRequired,
        alwaysUrgent: contact.alwaysUrgent,
        signOff: cfg.signOffs[lang],
        model,
        senderVerified: msg.senderVerified,
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
    const earlier = thread.filter((m) => m.id !== msg.id && m.internalDate.getTime() <= msg.internalDate.getTime());
    const { triage } = await this.runTriage(msg, earlier, item.onlyCc);
    if (triage && item.notePath && this.vault.exists(item.notePath)) {
      let content = this.vault.read(item.notePath);
      content = replaceTriageFailed(content, id, triage);
      content = replaceTaskLine(content, id, taskLine(id, triage));
      content = updateFrontmatter(content, { review_required: triage.review_required, updated: localIso(new Date(), this.cfg.tz) });
      this.vault.write(item.notePath, content);
      this.syncNoteStatus(item.threadId);
    }
    return this.store.get(id);
  }

  /** Open items whose thread has a later sent message of yours were answered elsewhere (Gmail, Superhuman). */
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
      const sentTimes = meta.filter((m) => isSentReply(m.labelIds)).map((m) => m.internalDate.getTime());
      for (const item of this.store.openInThread(threadId)) {
        if (item.status === "pending_triage") continue;
        const after = Math.max(new Date(item.receivedAt).getTime(), item.reopenedAt ? new Date(item.reopenedAt).getTime() : 0);
        if (sentTimes.some((t) => t > after)) {
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
    if (!item?.notePath || !this.vault.exists(item.notePath)) return item;
    try {
      this.vault.write(item.notePath, setTaskDone(this.vault.read(item.notePath), id, status === "replied" || status === "no_reply_needed"));
      this.syncNoteStatus(item.threadId);
    } catch (err) {
      log(`could not update note for ${id}`, err);
    }
    return item;
  }

  /**
   * One note holds a whole thread, so its status, urgency and dates describe the thread: the most
   * urgent open item if any is open, otherwise the latest item.
   */
  private syncNoteStatus(threadId: string): void {
    const items = this.store.threadItems(threadId);
    const notePath = this.store.threadNote(threadId);
    if (!items.length || !notePath || !this.vault.exists(notePath)) return;
    const open = items.filter((i) => OPEN_STATUSES.includes(i.status));
    const rank = (i: Item) => (i.triage ? URGENCIES.indexOf(i.triage.urgency) : URGENCIES.length);
    const lead = open.length ? [...open].sort((a, b) => rank(a) - rank(b))[0]! : items[items.length - 1]!;
    try {
      const content = updateFrontmatter(this.vault.read(notePath), {
        status: lead.status,
        urgency: lead.triage?.urgency ?? "",
        reply_by: lead.triage?.reply_by ?? "",
        due: lead.triage?.due_date ?? "",
        updated: localIso(new Date(), this.cfg.tz),
      });
      this.vault.write(notePath, content);
    } catch (err) {
      log(`could not update the status of ${notePath}`, err);
    }
  }
}
