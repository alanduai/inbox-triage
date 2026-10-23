import type Anthropic from "@anthropic-ai/sdk";
import { LANGUAGES, type Language, type LoadedConfig } from "./config.js";
import type { GmailReader } from "./gmail/client.js";
import { gmailLink } from "./gmail/links.js";
import { isNoiseAttachment, type ParsedMessage } from "./gmail/parse.js";
import { appendSection, messageSection, newNote, replaceTaskLine, setTaskDone, taskLine, updateFrontmatter, type AppKey } from "./obsidian/note.js";
import { cleanSubject, noteRelPath, type VaultWriter } from "./obsidian/writer.js";
import { isOnlyCc, isOwner, gmailScopeQuery, matchContact, replyRoute } from "./scope.js";
import type { FiledAttachment, Item, Status, Store } from "./store/db.js";
import { callClaude, finalize, TriageError, type Triage } from "./triage/claude.js";
import { localIso, localStamp, log } from "./util/time.js";

const LAST_SEEN_KEY = "gmail.lastSeenEpoch";
// Re-reads the last hour on each poll so a message that arrives late in Gmail's index is not missed.
const OVERLAP_SECONDS = 3600;

export interface PollResult {
  matched: number;
  ingested: number;
  failed: number;
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
    const since = this.store.getState(LAST_SEEN_KEY);
    const query = gmailScopeQuery(this.cfg, since ? Number(since) - OVERLAP_SECONDS : undefined, this.cfg.gmail.initialLookbackDays);
    const ids = (await this.gmail.listIds(query)).filter((id) => !this.store.has(id) && !this.store.isSkipped(id));
    const result: PollResult = { matched: 0, ingested: 0, failed: 0, closedByReply: 0 };

    // Oldest first, so sections land in a thread note in the order they were sent.
    const messages: ParsedMessage[] = [];
    for (const id of ids) messages.push(await this.gmail.message(id));
    messages.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());

    let newest = since ? Number(since) : 0;
    // A failed message must be fetched again, so the checkpoint never moves past it.
    let earliestFailure = Infinity;
    for (const msg of messages) {
      const match = matchContact(this.cfg, msg.from.email);
      if (!match || isOwner(this.cfg, msg.from.email)) {
        this.store.markSkipped(msg.id, match ? "from owner" : `no contact rule for ${msg.from.email}`);
        continue;
      }
      result.matched++;
      try {
        await this.ingest(msg);
        result.ingested++;
      } catch (err) {
        result.failed++;
        earliestFailure = Math.min(earliestFailure, Math.floor(msg.internalDate.getTime() / 1000));
        log(`ingest failed for ${msg.id}`, err);
        this.store.log(msg.id, "ingest_failed", err instanceof Error ? err.message : String(err));
        continue;
      }
      newest = Math.max(newest, Math.floor(msg.internalDate.getTime() / 1000));
    }
    if (earliestFailure !== Infinity) newest = Math.min(newest, earliestFailure - 1);
    if (newest) this.store.setState(LAST_SEEN_KEY, String(newest));

    result.closedByReply = await this.closeAnswered();
    return result;
  }

  private async ingest(msg: ParsedMessage): Promise<void> {
    const cfg = this.cfg;
    const match = matchContact(cfg, msg.from.email);
    if (!match) throw new Error(`no contact rule for ${msg.from.email}`);
    const { project, contact } = match;

    const thread = await this.gmail.thread(msg.threadId);
    const earlier = thread.filter((m) => m.id !== msg.id && m.internalDate.getTime() <= msg.internalDate.getTime());
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
      createdAt: now,
      updatedAt: now,
    };
    this.store.insert(item);

    const { triage, triageError } = await this.runTriage(msg, earlier, onlyCc);

    const section = messageSection({
      itemId: msg.id,
      receivedLocal: localStamp(msg.internalDate, cfg.tz),
      fromName: msg.from.name,
      fromEmail: msg.from.email,
      link,
      onlyCc,
      body: msg.latestText,
      attachments,
      triage,
      triageError,
    });
    const fm: Partial<Record<AppKey, string | boolean>> = {
      source: "gmail",
      project: project.name,
      subject: cleanSubject(msg.subject),
      gmail: link,
      from: msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email,
      status: (this.store.get(msg.id)?.status ?? "pending_triage") as string,
      urgency: triage?.urgency ?? "",
      reply_by: triage?.reply_by ?? "",
      due: triage?.due_date ?? "",
      review_required: contact.reviewRequired,
      updated: localIso(new Date(), cfg.tz),
    };

    const existing = this.store.threadNote(msg.threadId);
    if (existing && this.vault.exists(existing)) {
      this.vault.write(existing, appendSection(updateFrontmatter(this.vault.read(existing), fm), section));
      this.store.setNotePath(msg.id, existing);
    } else {
      const rel = this.vault.freeNotePath(noteRelPath(project.folder, receivedIso, msg.subject));
      this.vault.write(rel, newNote(fm, cleanSubject(msg.subject), section));
      this.store.setThreadNote(msg.threadId, project.id, rel);
      this.store.setNotePath(msg.id, rel);
    }
    log(`filed ${msg.id} (${project.id}) ${triage ? `${triage.urgency} ${triage.urgency_score}` : "triage failed"}`);
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
        route,
        replyLanguage: route.language ?? null,
        signOffs: cfg.signOffs,
        message: msg,
        earlier,
      });
      const lang: Language =
        route.language ?? ((LANGUAGES as readonly string[]).includes(result.message_language) ? (result.message_language as Language) : "en");
      const triage = finalize(result, { reviewRequired: contact.reviewRequired, alwaysUrgent: contact.alwaysUrgent, signOff: cfg.signOffs[lang], model });
      this.store.saveTriage(msg.id, triage);
      return { triage, triageError: "" };
    } catch (err) {
      const triageError = err instanceof TriageError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      this.store.saveTriageError(msg.id, triageError);
      return { triage: null, triageError };
    }
  }

  /** Runs triage again for one item (after a failure) and updates its note. */
  async retriage(id: string): Promise<Item | null> {
    const item = this.store.get(id);
    if (!item) return null;
    const msg = await this.gmail.message(id);
    const thread = await this.gmail.thread(msg.threadId);
    const earlier = thread.filter((m) => m.id !== msg.id && m.internalDate.getTime() <= msg.internalDate.getTime());
    const { triage } = await this.runTriage(msg, earlier, item.onlyCc);
    if (triage && item.notePath && this.vault.exists(item.notePath)) {
      let content = this.vault.read(item.notePath);
      content = replaceTaskLine(content, id, taskLine(id, triage));
      content = updateFrontmatter(content, {
        status: triage.needs_reply ? "needs_reply" : "no_reply_needed",
        urgency: triage.urgency,
        reply_by: triage.reply_by,
        due: triage.due_date,
        updated: localIso(new Date(), this.cfg.tz),
      });
      this.vault.write(item.notePath, content);
    }
    return this.store.get(id);
  }

  /** Open items whose thread has a later message from you were answered elsewhere (Gmail, Superhuman). */
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
      const sentTimes = meta
        .filter((m) => m.labelIds.includes("SENT") || isOwner(this.cfg, m.fromEmail))
        .map((m) => m.internalDate.getTime());
      for (const item of this.store.openInThread(threadId)) {
        const received = new Date(item.receivedAt).getTime();
        if (sentTimes.some((t) => t > received)) {
          this.setStatus(item.id, "replied", "reply found in Gmail");
          closed++;
        }
      }
    }
    return closed;
  }

  /** Changes an item's status and mirrors it in its note: frontmatter status and the task checkbox. */
  setStatus(id: string, status: Status, reason: string): Item | null {
    this.store.setStatus(id, status, reason);
    const item = this.store.get(id);
    if (!item?.notePath || !this.vault.exists(item.notePath)) return item;
    try {
      let content = this.vault.read(item.notePath);
      content = setTaskDone(content, id, status === "replied" || status === "no_reply_needed");
      content = updateFrontmatter(content, { status, updated: localIso(new Date(), this.cfg.tz) });
      this.vault.write(item.notePath, content);
    } catch (err) {
      log(`could not update note for ${id}`, err);
    }
    return item;
  }
}
