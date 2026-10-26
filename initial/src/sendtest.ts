import { randomUUID } from "node:crypto";
import type { LoadedConfig } from "./config.js";
import { buildMessage, buildReply, OUTBOX_HEADER, toRaw } from "./gmail/mime.js";
import { decodeEncodedWords } from "./gmail/parse.js";
import type { GmailSender } from "./gmail/sender.js";

export interface SendTestStep {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Two messages to yourself, to check on the real account what sending relies on: the reply stays
 * in the thread, our outbox header survives (so a retry can tell whether a send went out), and a
 * Croatian and Swedish subject comes back intact. Both are archived afterwards.
 */
export async function sendTest(cfg: LoadedConfig, sender: GmailSender): Promise<SendTestStep[]> {
  const steps: SendTestStep[] = [];
  const add = (name: string, ok: boolean, detail: string) => steps.push({ name, ok, detail });
  const me = { name: cfg.owner.name, email: cfg.gmail.account };
  const subject = "inbox-triage send test: č ć š ž đ å ä ö";
  const firstId = randomUUID();
  const first = await sender.sendNew(
    toRaw(
      buildMessage({
        from: me, to: [me], cc: [], subject, inReplyTo: "", references: "", outboxId: firstId, date: new Date(),
        body: "A test from inbox-triage. It is archived when the test ends; you can delete it.\n\nLijep pozdrav · Med vänlig hälsning",
      }),
    ),
  );
  add("Send a message to yourself", Boolean(first.id), first.id ? `message ${first.id}` : "Gmail returned no id");
  const h1 = await sender.headers(first.id, ["Message-ID", "Subject", OUTBOX_HEADER]);
  add("The reference header is kept", (h1[OUTBOX_HEADER.toLowerCase()] ?? "").trim() === firstId, h1[OUTBOX_HEADER.toLowerCase()] ? "present" : "missing: a retry could not tell whether a send went out");
  const gotSubject = decodeEncodedWords(h1["subject"] ?? "");
  add("Croatian and Swedish letters survive", gotSubject === subject, `subject came back as "${gotSubject}"`);

  const replyId = randomUUID();
  const replyGmailId = await sender.send(
    toRaw(
      buildReply({
        from: me, to: [me], cc: [], subject, inReplyTo: h1["message-id"] ?? "", references: "", outboxId: replyId, date: new Date(),
        body: "The reply half of the test.",
      }),
    ),
    first.threadId,
  );
  const h2 = await sender.headers(replyGmailId, ["Subject"]);
  add("The reply stays in the thread", h2["x-thread-id"] === first.threadId, h2["x-thread-id"] === first.threadId ? `thread ${first.threadId}` : `went to thread ${h2["x-thread-id"]}, expected ${first.threadId}`);
  const found = await sender.findSent(first.threadId, replyId);
  add("A sent reply can be found by its outbox id", found === replyGmailId, found ? `found ${found}` : "not found");
  await sender.archiveUpTo(first.threadId, new Date());
  add("Mark read and archive", true, "the test thread is out of your inbox");
  return steps;
}
