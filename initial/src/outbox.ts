import { randomUUID } from "node:crypto";
import type { LoadedConfig } from "./config.js";
import type { GmailReader } from "./gmail/client.js";
import { buildReply, toRaw, withQuote, type MailAddress } from "./gmail/mime.js";
import type { GmailSender } from "./gmail/sender.js";
import type { ParsedMessage } from "./gmail/parse.js";
import type { ThreadNotes } from "./notes.js";
import { normalizeEmail } from "./scope.js";
import { cleanRecipients } from "./sending.js";
import { EFFECT_ARCHIVE, EFFECT_NOTE, EFFECT_STATUS, type Item, type OutboxEntry, type Store } from "./store/db.js";
import { log } from "./util/time.js";

// A send still queued this long after its Undo window ended (the service was stopped) is not sent
// late on its own: it waits for you to press Retry.
const STALE_MS = 10 * 60_000;
// A send whose Gmail call started this long ago, with no answer recorded, is checked in Gmail.
const UNCERTAIN_MS = 60_000;

export class OutboxError extends Error {}

export interface OutboxDeps {
  cfg: LoadedConfig;
  store: Store;
  reader: GmailReader;
  sender: GmailSender;
  notes: ThreadNotes;
}

/**
 * Sends from the dashboard. A send waits out the Undo window in the store, so a restart never
 * loses it; it then goes to Gmail exactly once: each message carries its outbox id, and a send
 * whose outcome is unknown (a timeout, a crash) is looked up in the thread before it is ever
 * called failed. Nothing is sent again without you pressing Retry.
 */
export class Outbox {
  // Sends with a Gmail call in progress in this process.
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: OutboxDeps) {}

  get undoSeconds(): number {
    return this.deps.cfg.sending.undoSeconds;
  }

  /** Puts a checked reply or acknowledgement into the Undo window. */
  queue(item: Item, kind: "reply" | "ack", to: string[], cc: string[], body: string): OutboxEntry {
    const id = randomUUID();
    const sendAt = new Date(Date.now() + this.undoSeconds * 1000).toISOString();
    const cleanTo = cleanRecipients(to);
    const cleanCc = cleanRecipients(cc).filter((e) => !cleanTo.includes(e));
    if (!this.deps.store.outboxAdd({ id, itemId: item.id, kind, to: cleanTo, cc: cleanCc, body, sendAt })) {
      throw new OutboxError("A reply to this message is already on its way. Undo it first, or wait until it is sent.");
    }
    return this.deps.store.outboxGet(id)!;
  }

  undo(id: string): boolean {
    return this.deps.store.outboxCancel(id);
  }

  /** Retry a failed send: checked in Gmail first, then back into the Undo window. */
  async retry(id: string): Promise<OutboxEntry> {
    const { store } = this.deps;
    const e = store.outboxGet(id);
    if (!e || e.state !== "failed") throw new OutboxError("Only a send that failed can be retried.");
    const item = store.get(e.itemId);
    if (!item) throw new OutboxError("The message is no longer in the store.");
    const found = await this.deps.sender.findSent(item.threadId, e.id);
    if (found) {
      store.outboxSent(e.id, found);
      await this.finish(store.outboxGet(e.id)!);
      return store.outboxGet(e.id)!;
    }
    if (!store.outboxRequeue(id, new Date(Date.now() + this.undoSeconds * 1000).toISOString())) {
      throw new OutboxError("Another reply to this message is already on its way.");
    }
    return store.outboxGet(id)!;
  }

  /** At start: sends left waiting while the service was stopped, and Gmail calls cut off by a stop. */
  async recover(): Promise<void> {
    const { store } = this.deps;
    const now = Date.now();
    for (const e of store.outboxInState("queued")) {
      if (now - new Date(e.sendAt).getTime() > STALE_MS) {
        store.outboxFailed(e.id, "Not sent: the service was stopped before it went out. Press Retry to send it now.");
      }
    }
    await this.reconcile(0);
  }

  /** Sends whose Undo window has passed. Called every second by the service. */
  async tick(): Promise<void> {
    for (const e of this.deps.store.outboxDue(new Date().toISOString())) await this.deliver(e);
  }

  /** Unknown outcomes and unfinished follow-ups. Called every half minute by the service. */
  async maintain(): Promise<void> {
    await this.reconcile(UNCERTAIN_MS);
    for (const e of this.deps.store.outboxUnfinished()) await this.finish(e);
  }

  private async deliver(e: OutboxEntry): Promise<void> {
    const { store, reader, sender } = this.deps;
    if (!store.outboxClaim(e.id)) return;
    this.inFlight.add(e.id);
    const item = store.get(e.itemId);
    try {
      if (!item) throw new Error("the message is no longer in the store");
      // Read before sending: Message-ID and References keep the reply in the thread.
      const original = await reader.message(item.id);
      const raw = toRaw(this.message(item, original, e));
      const gmailId = await sender.send(raw, item.threadId);
      store.outboxSent(e.id, gmailId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`send ${e.id} failed or timed out`, err);
      // The call may have reached Gmail before it failed: look before calling it failed.
      try {
        const found = item ? await sender.findSent(item.threadId, e.id) : null;
        if (found) store.outboxSent(e.id, found);
        else store.outboxFailed(e.id, `Not sent: ${message}`);
      } catch (checkErr) {
        // Outcome unknown: it stays "sending" and is checked again in a minute.
        store.outboxNote(e.id, `Checking whether it went out: ${checkErr instanceof Error ? checkErr.message : String(checkErr)}`);
      }
    } finally {
      this.inFlight.delete(e.id);
    }
    const done = store.outboxGet(e.id);
    if (done?.state === "sent") await this.finish(done);
  }

  /** Looks up sends stuck in "sending" (older than minAgeMs) in Gmail, and settles them. */
  private async reconcile(minAgeMs: number): Promise<void> {
    const { store, sender } = this.deps;
    for (const e of store.outboxInState("sending")) {
      if (this.inFlight.has(e.id)) continue;
      if (Date.now() - new Date(e.attemptAt ?? e.sendAt).getTime() < minAgeMs) continue;
      const item = store.get(e.itemId);
      if (!item) {
        store.outboxFailed(e.id, "Not sent: the message is no longer in the store.");
        continue;
      }
      try {
        const found = await sender.findSent(item.threadId, e.id);
        if (found) {
          store.outboxSent(e.id, found);
          await this.finish(store.outboxGet(e.id)!);
        } else store.outboxFailed(e.id, `Not sent${e.error ? ` (${e.error})` : ""}. Press Retry to send it.`);
      } catch (err) {
        store.outboxNote(e.id, `Checking whether it went out: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** After a send: the item's status, the note, and the archive in Gmail. Each step is done once. */
  private async finish(e: OutboxEntry): Promise<void> {
    const { store, notes, sender } = this.deps;
    const item = store.get(e.itemId);
    if (!item) return;
    if (!(e.effects & EFFECT_STATUS)) {
      // A reply answers the message; an acknowledgement is a holding reply, so it stays open.
      if (e.kind === "reply") notes.setStatus(item.id, "replied", "sent from the dashboard");
      else {
        store.setAcked(item.id, e.sentAt ?? new Date().toISOString());
        notes.sync(item.threadId, item.projectId);
      }
      store.addEffects(e.id, EFFECT_STATUS);
    }
    if (!(e.effects & EFFECT_NOTE) && notes.recordSent(item, e)) store.addEffects(e.id, EFFECT_NOTE);
    if (!(e.effects & EFFECT_ARCHIVE)) {
      try {
        await sender.archiveThread(item.threadId);
        store.addEffects(e.id, EFFECT_ARCHIVE);
      } catch (err) {
        log(`could not archive thread ${item.threadId} yet`, err);
      }
    }
  }

  /** The reply as it goes out: your text with the original quoted, threaded under the original. */
  private message(item: Item, original: ParsedMessage, e: OutboxEntry): string {
    const { cfg } = this.deps;
    const names = new Map<string, string>();
    for (const a of [original.from, ...original.to, ...original.cc, ...original.replyTo]) if (a.name) names.set(normalizeEmail(a.email), a.name);
    const counsel = cfg.projects.find((p) => p.id === item.projectId)?.counsel;
    if (counsel) names.set(normalizeEmail(counsel.email), counsel.name);
    const addr = (email: string): MailAddress => ({ email, name: names.get(normalizeEmail(email)) ?? "" });
    const language = item.replyLanguage || item.triage?.message_language || "en";
    return buildReply({
      from: { name: cfg.owner.name, email: cfg.gmail.account },
      to: e.to.map(addr),
      cc: e.cc.map(addr),
      subject: original.subject === "(no subject)" ? "" : original.subject,
      inReplyTo: original.rfc822MessageId,
      references: original.references,
      body: withQuote(e.body, { date: original.internalDate, fromName: original.from.name, fromEmail: original.from.email, text: original.text }, language, cfg.tz),
      outboxId: e.id,
      kind: e.kind,
      date: new Date(),
    });
  }

  /** A Gmail draft in the thread with the same content; nothing is sent. */
  async saveDraft(item: Item, to: string[], cc: string[], body: string): Promise<string> {
    const original = await this.deps.reader.message(item.id);
    const e: OutboxEntry = {
      id: `draft-${randomUUID()}`, itemId: item.id, kind: "reply", to: cleanRecipients(to), cc: cleanRecipients(cc), body,
      state: "queued", sendAt: "", createdAt: "", attemptAt: null, gmailId: null, sentAt: null, error: "", effects: 0,
    };
    const id = await this.deps.sender.createDraft(toRaw(this.message(item, original, e)), item.threadId);
    this.deps.store.log(item.id, "gmail_draft", id);
    return id;
  }
}
