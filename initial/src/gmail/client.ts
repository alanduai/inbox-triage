import { gmail, type gmail_v1 } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import { KIND_HEADER } from "./mime.js";
import { completeBody, decodeBase64Url, parseAddressList, parseMessage, type AttachmentRef, type ParsedMessage } from "./parse.js";

export interface ThreadMeta {
  id: string;
  internalDate: Date;
  labelIds: string[];
  fromEmail: string;
  recipients: string[];
  // "ack" for an acknowledgement sent from the dashboard: a holding reply, so it closes nothing.
  kind: string;
}

/** The Gmail calls for reading. Sending is in GmailSender. */
export class GmailReader {
  private readonly api: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this.api = gmail({ version: "v1", auth });
  }

  async profileEmail(): Promise<string> {
    const res = await this.api.users.getProfile({ userId: "me" });
    return res.data.emailAddress ?? "";
  }

  /** Message ids matching a Gmail search, newest first, up to maxPages × 100; truncated when more remained. */
  async listIds(query: string, maxPages = 20): Promise<{ ids: string[]; truncated: boolean }> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.api.users.messages.list({ userId: "me", q: query, maxResults: 100, pageToken });
      for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
      pageToken = res.data.nextPageToken ?? undefined;
      if (!pageToken) return { ids, truncated: false };
    }
    return { ids, truncated: true };
  }

  async message(id: string): Promise<ParsedMessage> {
    const res = await this.api.users.messages.get({ userId: "me", id, format: "full" });
    return this.complete(parseMessage(res.data));
  }

  /** Every message of a thread, oldest first, without drafts. */
  async thread(id: string): Promise<ParsedMessage[]> {
    const res = await this.api.users.threads.get({ userId: "me", id, format: "full" });
    const messages = (res.data.messages ?? []).filter((m) => !(m.labelIds ?? []).includes("DRAFT")).map(parseMessage);
    const complete = await Promise.all(messages.map((m) => this.complete(m)));
    return complete.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());
  }

  /** Large messages keep their text behind an attachment id; fetch it so the body is not empty. */
  private async complete(msg: ParsedMessage): Promise<ParsedMessage> {
    if (!msg.deferredBody.length) return msg;
    const fetched = [];
    for (const part of msg.deferredBody) {
      const res = await this.api.users.messages.attachments.get({ userId: "me", messageId: msg.id, id: part.attachmentId });
      fetched.push({ mimeType: part.mimeType, data: decodeBase64Url(res.data.data ?? ""), charset: part.charset });
    }
    return completeBody(msg, fetched);
  }

  /** Light view of a thread: who wrote each message, to whom and when, without bodies. */
  async threadMeta(id: string): Promise<ThreadMeta[]> {
    const res = await this.api.users.threads.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "To", "Cc", KIND_HEADER] });
    return (res.data.messages ?? []).map((m) => {
      const h = (name: string) =>
        (m.payload?.headers ?? []).filter((x) => x.name?.toLowerCase() === name).map((x) => x.value ?? "").join(", ");
      return {
        id: m.id ?? "",
        internalDate: new Date(Number(m.internalDate ?? 0)),
        labelIds: m.labelIds ?? [],
        fromEmail: parseAddressList(h("from"))[0]?.email ?? "",
        recipients: [...parseAddressList(h("to")), ...parseAddressList(h("cc"))].map((a) => a.email),
        kind: h(KIND_HEADER.toLowerCase()).trim(),
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
