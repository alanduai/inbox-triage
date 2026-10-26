import type Anthropic from "@anthropic-ai/sdk";
import { LANGUAGES, type Language, type LoadedConfig, type ProjectConfig } from "./config.js";
import type { GmailReader } from "./gmail/client.js";
import { isNotFound } from "./gmail/errors.js";
import { gmailLink } from "./gmail/links.js";
import { isNoiseAttachment, quotedRest, type ParsedMessage } from "./gmail/parse.js";
import { ThreadNotes } from "./notes.js";
import { hasSection, insertSection, messageSection, newNote, updateFrontmatter, type AppKey } from "./obsidian/note.js";
import { cleanSubject, noteRelPath, type VaultWriter } from "./obsidian/writer.js";
import { answers, isOnlyCc, isOwner, gmailScopeQuery, matchContact, needsReview, replyRoute, rulesFingerprint } from "./scope.js";
import { OPEN_STATUSES, type FiledAttachment, type Item, type Status, type Store } from "./store/db.js";
import { callClaude, finalize, TriageError } from "./triage/claude.js";
import type { Urgency } from "./triage/schema.js";
import { localIso, localStamp, log } from "./util/time.js";

const LAST_SEEN_KEY = "gmail.lastSeenEpoch";
const NOT_BEFORE_KEY = "gmail.notBeforeEpoch";
const RULES_KEY = "rules.fingerprint";
// Each poll re-reads the last week. Messages already seen are skipped by id, so this costs one
// list call, and it catches mail that reaches the inbox late: rescued from spam, restored from
// trash, or indexed slowly.
const OVERLAP_SECONDS = 7 * 86_400;

/** A reply of yours: sent, not a draft or a scheduled message. */
function isSentReply(labelIds: string[]): boolean {
  return labelIds.includes("SENT") && !labelIds.includes("DRAFT") && !labelIds.includes("SCHEDULED");
}

const DELETED_BEFORE_TRIAGE = "The message was deleted in Gmail before Claude read it. The note keeps the text as it arrived.";

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
  readonly notes: ThreadNotes;
  // Triage calls in progress, by message id: a second request for the same message waits for the first.
  private readonly triaging = new Map<string, Promise<void>>();

  constructor(
    private readonly cfg: LoadedConfig,
    private readonly store: Store,
    private readonly gmail: GmailReader,
    private readonly claude: Anthropic,
    private readonly vault: VaultWriter,
  ) {
    this.notes = new ThreadNotes(cfg, store, vault);
  }

  async pollOnce(): Promise<PollResult> {
    const result: PollResult = { matched: 0, ingested: 0, failed: 0, refiled: 0, closedByReply: 0 };
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Changed contact rules: mail skipped for having no rule is looked at again.
    const fingerprint = rulesFingerprint(this.cfg);
    if (this.store.getState(RULES_KEY) !== fingerprint) {
      const n = this.store.forgetUnmatchedSkips();
      if (n) log(`contact rules changed: ${n} skipped messages will be checked again`);
      this.store.setState(RULES_KEY, fingerprint);
    }

    // Messages stored earlier but not filed yet go first, so a thread's sections are written in order.
    const refile = await this.refileUnfiled();
    result.refiled = refile.done;
    result.failed += refile.failed;

    const since = this.store.getState(LAST_SEEN_KEY);
    const after = Math.max(since ? Number(since) - OVERLAP_SECONDS : 0, this.notBefore(since, nowSeconds));
    const query = gmailScopeQuery(this.cfg, after || undefined, this.cfg.gmail.initialLookbackDays);
    const listing = await this.gmail.listIds(query);
    if (listing.truncated) log(`Gmail returned more than ${listing.ids.length} matches; the oldest are not checked this time`);
    const ids = [...new Set(listing.ids)].filter((id) => !this.store.has(id) && !this.store.isSkipped(id));

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

    await this.retryAttachments();
    result.closedByReply = await this.closeAnswered();
    // Notes left behind by a write that failed earlier.
    for (const t of this.store.staleNotes()) if (!this.notes.sync(t.threadId, t.projectId)) result.failed++;
    return result;
  }

  /**
   * The oldest mail any poll looks at: the first start looks back initialLookbackDays, and later
   * polls never reach further, so their week-long overlap doesn't pull in older mail a minute later.
   */
  private notBefore(since: string | null, nowSeconds: number): number {
    const stored = this.store.getState(NOT_BEFORE_KEY);
    if (stored !== null) return Number(stored);
    // An install that already has a checkpoint keeps its full overlap.
    const value = since ? 0 : nowSeconds - this.cfg.gmail.initialLookbackDays * 86_400;
    this.store.setState(NOT_BEFORE_KEY, String(value));
    return value;
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
    await this.file(item, { msg, thread });
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

  /**
   * Triage (when still needed, from the Gmail message in source) and the note for one stored item.
   * The note is written from the store alone. retry: an earlier attempt may have written part of it.
   */
  private async file(item: Item, source: { msg: ParsedMessage; thread: ParsedMessage[] } | null, retry = false): Promise<void> {
    const cfg = this.cfg;
    const project = cfg.projects.find((p) => p.id === item.projectId);
    if (!project) throw new Error(`project ${item.projectId} is no longer in the config`);

    if (item.status === "pending_triage" && source) await this.runTriage(source.msg, earlierThan(source.thread, source.msg), item.onlyCc);
    // Read back: the triage just stored, and any choice made in the dashboard meanwhile.
    const current = this.store.get(item.id) ?? item;
    const { triage, triageError } = current;

    const received = new Date(item.receivedAt);
    const stamp = localStamp(received, cfg.tz);
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
      done: !OPEN_STATUSES.includes(current.status),
    });

    // The note's subject follows the newest message in the thread; its sender, link and status
    // follow the item that needs you most (see ThreadNotes.sync).
    const siblings = this.store.threadItems(item.threadId, item.projectId).filter((i) => i.id !== item.id && i.notePath);
    const later = siblings.filter((i) => i.receivedAt > item.receivedAt || (i.receivedAt === item.receivedAt && i.id > item.id));
    const isNewest = later.length === 0;
    const identity: Partial<Record<AppKey, string | boolean>> = { source: "gmail", project: project.name, subject: cleanSubject(item.subject) };

    let rel = this.notes.noteFor(item.threadId, item.projectId, retry);
    if (rel) {
      const content = this.vault.read(rel);
      // Already there when an earlier attempt wrote the note but stopped before recording it.
      if (!hasSection(content, item.id, item.link)) {
        const fm = updateFrontmatter(content, isNewest ? identity : { project: project.name });
        this.vault.write(rel, insertSection(fm, section, stamp, later.map((i) => i.link)));
      }
    } else {
      rel = this.vault.freeNotePath(noteRelPath(project.folder, localIso(received, cfg.tz), item.subject), (p) =>
        this.store.notePathTaken(p, item.threadId, item.projectId),
      );
      this.vault.write(rel, newNote({ ...identity, gmail: item.link, from: item.fromName ? `${item.fromName} <${item.fromEmail}>` : item.fromEmail }, cleanSubject(item.subject), section));
    }
    this.store.setThreadNote(item.threadId, item.projectId, rel);
    this.store.setNotePath(item.id, rel);
    this.notes.sync(item.threadId, item.projectId);
    log(`filed ${item.id} (${project.id}) ${triage ? `${triage.urgency} ${triage.urgency_score}` : "triage failed"}`);
  }

  /** Finishes items stored without a note: a failed vault write, or a stop in the middle of triage. */
  private async refileUnfiled(): Promise<{ done: number; failed: number }> {
    let done = 0;
    let failed = 0;
    for (const stored of this.store.unfiled()) {
      try {
        let item = stored;
        // Only triage needs Gmail; a triaged item is filed from the store, even if the message was deleted since.
        let source: { msg: ParsedMessage; thread: ParsedMessage[] } | null = null;
        if (item.status === "pending_triage") {
          try {
            const msg = await this.gmail.message(item.id);
            source = { msg, thread: await this.gmail.thread(item.threadId) };
          } catch (err) {
            if (!isNotFound(err)) throw err;
            this.store.saveTriageError(item.id, DELETED_BEFORE_TRIAGE);
            item = this.store.get(item.id) ?? item;
          }
        }
        await this.file(item, source, true);
        done++;
      } catch (err) {
        failed++;
        this.store.fileFailed(stored.id);
        log(`could not file ${stored.id} yet`, err);
        this.store.log(stored.id, "file_failed", err instanceof Error ? err.message : String(err));
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
        } catch (err) {
          log(`attachment ${a.filename} of ${item.id} still not saved`, err);
        }
      }
      if (changed) {
        // The note's "not saved yet" line is swapped by the sync, now or on a later poll.
        this.store.setAttachments(item.id, updated);
        if (item.notePath) this.notes.sync(item.threadId, item.projectId);
      }
    }
  }

  /**
   * Calls Claude and applies the fixed rules; stores the result or the error. One call per message
   * at a time: a retry pressed while the poll is triaging the same message waits for that answer.
   */
  private runTriage(msg: ParsedMessage, earlier: ParsedMessage[], onlyCc: boolean): Promise<void> {
    const running = this.triaging.get(msg.id);
    if (running) return running;
    const call = this.triageOnce(msg, earlier, onlyCc).finally(() => this.triaging.delete(msg.id));
    this.triaging.set(msg.id, call);
    return call;
  }

  private async triageOnce(msg: ParsedMessage, earlier: ParsedMessage[], onlyCc: boolean): Promise<void> {
    if (this.store.get(msg.id)?.triage) return;
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
    } catch (err) {
      this.store.saveTriageError(msg.id, err instanceof TriageError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Runs triage again for an item that failed or never finished, and repairs its note. */
  async retriage(id: string): Promise<Item | null> {
    const item = this.store.get(id);
    if (!item) return null;
    if (item.status !== "triage_failed" && item.status !== "pending_triage") return item;
    let msg: ParsedMessage;
    try {
      msg = await this.gmail.message(id);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      this.store.saveTriageError(id, DELETED_BEFORE_TRIAGE);
      return this.store.get(id);
    }
    const thread = await this.gmail.thread(msg.threadId);
    await this.runTriage(msg, earlierThan(thread, msg), item.onlyCc);
    // The note gets the triage from the store; a write that fails now is redone on the next poll.
    const after = this.store.get(id);
    if (after?.notePath) this.notes.sync(after.threadId, after.projectId);
    return after;
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
      // An acknowledgement from the dashboard is a holding reply: it closes nothing. It is known by
      // its Gmail id, or by its outbox id while that is still being recorded.
      const acks = new Set(this.store.ackGmailIds(threadId));
      const outboxOf = (m: { ref?: string }) => (m.ref ? this.store.outboxGet(m.ref) : null);
      const sent = meta
        .filter((m) => isSentReply(m.labelIds) && !acks.has(m.id) && outboxOf(m)?.kind !== "ack")
        // A reply sent from the dashboard answers what was there when you pressed Send, not mail
        // that arrived during the Undo window or before it went out.
        .map((m) => ({ ...m, answeredAt: outboxOf(m)?.queuedAt ? new Date(outboxOf(m)!.queuedAt).getTime() : m.internalDate.getTime() }));
      for (const item of this.store.openInThread(threadId)) {
        // A reply closes what asked for a reply; a task without a reply (needs_action) waits for you.
        if (item.status === "pending_triage" || item.status === "needs_action") continue;
        const after = Math.max(new Date(item.receivedAt).getTime(), item.reopenedAt ? new Date(item.reopenedAt).getTime() : 0);
        if (sent.some((m) => m.answeredAt > after && answers(m.recipients, item))) {
          this.setStatus(item.id, "replied", "reply found in Gmail");
          closed++;
        }
      }
    }
    return closed;
  }

  /** Changes an item's status and mirrors it in its note: the task checkbox and the thread's status. */
  setStatus(id: string, status: Status, reason: string): Item | null {
    return this.notes.setStatus(id, status, reason)?.item ?? null;
  }

  /** Your own urgency rating: it replaces Claude's in the dashboard and in the note. */
  setUserUrgency(id: string, urgency: Urgency | null): void {
    this.notes.setUserUrgency(id, urgency);
  }
}
