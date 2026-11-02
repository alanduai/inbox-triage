import { Readable } from "node:stream";
import type { OAuth2Client } from "google-auth-library";
import { GmailReader } from "../gmail/client.js";
import type { MailboxApi } from "./types.js";

/**
 * The phase 1 reader plus drafts. A draft is uploaded as raw MIME through the media endpoint, so
 * attachments up to Gmail's 25 MB fit; the JSON `raw` field is meant for small messages only.
 * Nothing here sends mail.
 */
export class ExpenseMailbox extends GmailReader implements MailboxApi {
  constructor(auth: OAuth2Client) {
    super(auth);
  }

  async createDraft(raw: Buffer, threadId: string): Promise<{ id: string; messageId: string }> {
    const res = await this.api.users.drafts.create({
      userId: "me",
      requestBody: { message: { threadId } },
      media: { mimeType: "message/rfc822", body: Readable.from(raw) },
    });
    return { id: res.data.id ?? "", messageId: res.data.message?.id ?? "" };
  }

  async updateDraft(id: string, raw: Buffer, threadId: string): Promise<{ id: string; messageId: string }> {
    const res = await this.api.users.drafts.update({
      userId: "me",
      id,
      requestBody: { id, message: { threadId } },
      media: { mimeType: "message/rfc822", body: Readable.from(raw) },
    });
    return { id: res.data.id ?? id, messageId: res.data.message?.id ?? "" };
  }

  async draftExists(id: string): Promise<boolean> {
    try {
      await this.api.users.drafts.get({ userId: "me", id, format: "minimal" });
      return true;
    } catch (err) {
      const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
      if (status === 404) return false;
      throw err;
    }
  }
}
