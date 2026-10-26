import { gmail, type gmail_v1 } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import { OUTBOX_HEADER } from "./mime.js";

/** The Gmail calls that change something: send, save a draft, mark read and archive. Needs gmail.modify. */
export class GmailSender {
  private readonly api: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this.api = gmail({ version: "v1", auth });
  }

  /** Sends a raw message into an existing thread; returns the new message's id. */
  async send(raw: string, threadId: string): Promise<string> {
    const res = await this.api.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
    return res.data.id ?? "";
  }

  /** Saves a raw message as a draft in the thread, for you to finish in Gmail or Superhuman. */
  async createDraft(raw: string, threadId: string): Promise<string> {
    const res = await this.api.users.drafts.create({ userId: "me", requestBody: { message: { raw, threadId } } });
    return res.data.id ?? "";
  }

  /**
   * Marks read and archives the thread's messages up to a time: the message you answered and the
   * ones before it. Anything newer stays unread in the inbox, so a message that arrived while you
   * were replying is never hidden.
   */
  async archiveUpTo(threadId: string, upTo: Date): Promise<void> {
    const res = await this.api.users.threads.get({ userId: "me", id: threadId, format: "minimal" });
    const ids = (res.data.messages ?? [])
      .filter((m) => Number(m.internalDate ?? 0) <= upTo.getTime())
      .filter((m) => (m.labelIds ?? []).some((l) => l === "INBOX" || l === "UNREAD"))
      .map((m) => m.id ?? "")
      .filter(Boolean);
    if (ids.length) await this.api.users.messages.batchModify({ userId: "me", requestBody: { ids, removeLabelIds: ["INBOX", "UNREAD"] } });
  }

  /** The id of a sent message in the thread that carries this outbox id, if one went out. */
  async findSent(threadId: string, outboxId: string): Promise<string | null> {
    const res = await this.api.users.threads.get({ userId: "me", id: threadId, format: "metadata", metadataHeaders: [OUTBOX_HEADER] });
    for (const m of res.data.messages ?? []) {
      const labels = m.labelIds ?? [];
      if (!labels.includes("SENT") || labels.includes("DRAFT")) continue;
      const value = (m.payload?.headers ?? []).find((h) => h.name?.toLowerCase() === OUTBOX_HEADER.toLowerCase())?.value ?? "";
      if (value.trim() === outboxId) return m.id ?? null;
    }
    return null;
  }

  /** Headers of one message as Gmail stored them, for the send test. */
  async headers(messageId: string, names: string[]): Promise<Record<string, string>> {
    const res = await this.api.users.messages.get({ userId: "me", id: messageId, format: "metadata", metadataHeaders: names });
    const out: Record<string, string> = {};
    for (const h of res.data.payload?.headers ?? []) if (h.name) out[h.name.toLowerCase()] = h.value ?? "";
    out["x-thread-id"] = res.data.threadId ?? "";
    return out;
  }

  /** Sends a raw message that starts a new thread (the send test only). */
  async sendNew(raw: string): Promise<{ id: string; threadId: string }> {
    const res = await this.api.users.messages.send({ userId: "me", requestBody: { raw } });
    return { id: res.data.id ?? "", threadId: res.data.threadId ?? "" };
  }
}
