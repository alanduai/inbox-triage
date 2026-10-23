import { gmail, type gmail_v1 } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import { decodeBase64Url, parseMessage, type AttachmentRef, type ParsedMessage } from "./parse.js";

/** The few Gmail calls phase 1 needs. Read-only. */
export class GmailReader {
  private readonly api: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this.api = gmail({ version: "v1", auth });
  }

  async profileEmail(): Promise<string> {
    const res = await this.api.users.getProfile({ userId: "me" });
    return res.data.emailAddress ?? "";
  }

  /** Message ids matching a Gmail search, newest first, up to maxPages × 100. */
  async listIds(query: string, maxPages = 5): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.api.users.messages.list({ userId: "me", q: query, maxResults: 100, pageToken });
      for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
      pageToken = res.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    return ids;
  }

  async message(id: string): Promise<ParsedMessage> {
    const res = await this.api.users.messages.get({ userId: "me", id, format: "full" });
    return parseMessage(res.data);
  }

  /** Every message of a thread, oldest first. */
  async thread(id: string): Promise<ParsedMessage[]> {
    const res = await this.api.users.threads.get({ userId: "me", id, format: "full" });
    return (res.data.messages ?? []).map(parseMessage).sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());
  }

  /** Light view of a thread: who wrote each message and when, without bodies. */
  async threadMeta(id: string): Promise<{ id: string; internalDate: Date; labelIds: string[]; fromEmail: string }[]> {
    const res = await this.api.users.threads.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From"] });
    return (res.data.messages ?? []).map((m) => {
      const from = m.payload?.headers?.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
      return {
        id: m.id ?? "",
        internalDate: new Date(Number(m.internalDate ?? 0)),
        labelIds: m.labelIds ?? [],
        fromEmail: (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase(),
      };
    });
  }

  async attachment(messageId: string, ref: AttachmentRef): Promise<Buffer> {
    if (ref.data) return decodeBase64Url(ref.data);
    if (!ref.attachmentId) throw new Error(`Attachment ${ref.filename} has no data`);
    const res = await this.api.users.messages.attachments.get({ userId: "me", messageId, id: ref.attachmentId });
    return decodeBase64Url(res.data.data ?? "");
  }
}
