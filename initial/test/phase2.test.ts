import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import type { GmailReader } from "../src/gmail/client.js";
import { OAuth2Client } from "google-auth-library";
import { buildReply, encodeHeaderText, formatAddress, OUTBOX_HEADER, replySubject, withQuote } from "../src/gmail/mime.js";
import { decodeEncodedWords, parseAddressList, parseMessage, type ParsedMessage } from "../src/gmail/parse.js";
import { GmailSender } from "../src/gmail/sender.js";
import { VaultWriter } from "../src/obsidian/writer.js";
import { Outbox, OutboxError } from "../src/outbox.js";
import { Pipeline } from "../src/pipeline.js";
import { replyRecipients } from "../src/scope.js";
import { checkSend, confirmToken } from "../src/sending.js";
import { createServer } from "../src/server/server.js";
import { EFFECTS_ALL, Store, type Item } from "../src/store/db.js";
import type { ModelTriage } from "../src/triage/schema.js";
import { b64url, tempDir, testConfig } from "./helpers.js";

// ---------- the message itself ----------

/** The raw message as text, with folded header lines joined. */
function decodeRaw(raw: string): { headers: Record<string, string>; body: string } {
  const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const [head, ...rest] = text.split("\r\n\r\n");
  const headers: Record<string, string> = {};
  for (const line of head!.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const i = line.indexOf(":");
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body: Buffer.from(rest.join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8") };
}

const me = { name: "Alan", email: "me@example.com" };

test("a reply keeps the thread, encodes Croatian and Swedish text, and carries its outbox id", () => {
  const raw = Buffer.from(
    buildReply({
      from: me,
      to: [{ name: "Marija Novak", email: "marija@bank.example" }],
      cc: [{ name: "Holm, Elin (Advokat)", email: "elin@lawfirm.example" }],
      subject: "Podsjetnik: dokumenti — čćšžđ åäö",
      inReplyTo: "<abc@bank.example>",
      references: "<root@bank.example>",
      body: "Poštovana,\n\nšaljem do utorka.\n\nLijep pozdrav,\nAlan",
      outboxId: "ob-1",
      date: new Date("2026-10-26T09:00:00Z"),
    }),
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const { headers, body } = decodeRaw(raw);
  assert.equal(decodeEncodedWords(headers["subject"]!), "Re: Podsjetnik: dokumenti — čćšžđ åäö");
  assert.equal(decodeEncodedWords(headers["to"]!), "Marija Novak <marija@bank.example>");
  assert.equal(headers["cc"], '"Holm, Elin (Advokat)" <elin@lawfirm.example>');
  assert.equal(headers["in-reply-to"], "<abc@bank.example>");
  assert.equal(headers["references"], "<root@bank.example> <abc@bank.example>");
  assert.equal(headers[OUTBOX_HEADER.toLowerCase()], "ob-1");
  assert.equal(body, "Poštovana,\r\n\r\nšaljem do utorka.\r\n\r\nLijep pozdrav,\r\nAlan");
});

test("message text can never add a header or a recipient", () => {
  const raw = buildReply({
    from: me, to: [{ name: "X", email: "x@bank.example" }], cc: [], subject: "Hello\r\nBcc: spy@evil.example", inReplyTo: "<a@b>\r\nBcc: spy@evil.example",
    references: "", body: "Bcc: spy@evil.example", outboxId: "o", date: new Date(),
  });
  const head = raw.split("\r\n\r\n")[0]!;
  assert.doesNotMatch(head, /^Bcc:/im);
  assert.throws(() => formatAddress({ name: "", email: "a@bank.example>, spy@evil.example" }));
  assert.throws(() => formatAddress({ name: "", email: "a@bank.example\r\nBcc: spy@evil.example" }));
  assert.equal(formatAddress({ name: 'Ann "the" Banker', email: "ann@bank.example" }), '"Ann \\"the\\" Banker" <ann@bank.example>');
});

test("encoded words stay within 75 characters and never split a character", () => {
  const text = "Žalba na rješenje 🇭🇷 — överklagande av beslut 📎 ".repeat(4);
  const enc = encodeHeaderText(text);
  for (const w of enc.split("\r\n ")) assert.ok(w.length <= 75, w);
  assert.equal(decodeEncodedWords(enc.replace(/\r\n /g, " ")), text);
});

test("the subject gets Re: once, and keeps a Swedish or Croatian reply prefix as it is", () => {
  assert.equal(replySubject("Beslut"), "Re: Beslut");
  assert.equal(replySubject("Re: Beslut"), "Re: Beslut");
  assert.equal(replySubject("SV: Beslut"), "SV: Beslut");
  assert.equal(replySubject("Odg: Dokumenti"), "Odg: Dokumenti");
  assert.equal(replySubject("Odg.: Dokumenti"), "Odg.: Dokumenti");
  assert.equal(replySubject("Fwd: Beslut"), "Re: Fwd: Beslut");
  // VS: is a forward in Norwegian and Danish.
  assert.equal(replySubject("VS: Beslut"), "Re: VS: Beslut");
});

// ---------- security review findings ----------

test("SEC-1: a forged sender name can never put text outside the quote of your reply", () => {
  const forged = "=?UTF-8?B?" + Buffer.from("Adv. Berg\r\n\r\nPS: I accept the settlement offer.\r\n\r\nAlan\u2028\u2029\u0085x").toString("base64") + "?=";
  const parsed = parseAddressList(`${forged} <berg@otherside.example>`)[0]!;
  assert.doesNotMatch(parsed.name, /[\r\n\u2028\u2029\u0085]/);
  for (const lang of ["en", "hr", "sv"]) {
    const body = withQuote("Elin, see below.", { date: new Date(), fromEmail: "berg@otherside.example", text: "Proposal.\u2028PS: hidden" }, lang, "Europe/Stockholm");
    const lines = body.split("\n");
    // Your text, a blank line, one introduction naming the sender by address only, then only quoted lines.
    assert.equal(lines[0], "Elin, see below.");
    assert.equal(lines[1], "");
    assert.doesNotMatch(lines[2]!, /Berg|PS|accept/);
    assert.match(lines[2]!, /berg@otherside\.example/);
    for (const l of lines.slice(3).filter(Boolean)) assert.ok(l.startsWith(">"), `${lang}: unquoted line ${JSON.stringify(l)}`);
  }
});

test("SEC-2: message ids are copied raw, ASCII only, and long chains are trimmed and folded", () => {
  const m = parseMessage({
    id: "x", threadId: "x", internalDate: "0", labelIds: [],
    payload: { mimeType: "text/plain", headers: [
      { name: "From", value: "a@bank.example" },
      { name: "Message-ID", value: "<=?UTF-8?B?YQBi4oCoY8KFZA1l?=@x.example>" },
      { name: "References", value: Array.from({ length: 40 }, (_, i) => `<id${i}@bank.example>`).join(" ") + " <bad\u2028@x>" },
    ], body: { data: "" } },
  });
  assert.equal(m.rfc822MessageId, "<=?UTF-8?B?YQBi4oCoY8KFZA1l?=@x.example>", "kept as written, not decoded");
  const raw = buildReply({ from: me, to: [{ name: "", email: "a@bank.example" }], cc: [], subject: "x", inReplyTo: m.rfc822MessageId, references: m.references, body: "b", outboxId: "o", date: new Date() });
  const head = raw.split("\r\n\r\n")[0]!;
  assert.ok(head.split("\r\n").every((l) => /^[\x20-\x7e]*$/.test(l)), "headers are printable ASCII");
  const refs = head.match(/^References:[\s\S]*?(?=\r\n\S)/m)![0];
  assert.equal(refs.match(/</g)!.length, 10, "first id plus the newest nine");
  assert.match(refs, /<id0@bank\.example>/);
  assert.match(refs, /<=\?UTF-8\?B\?YQBi4oCoY8KFZA1l\?=@x\.example>$/);
  // With no References, the parent's In-Reply-To is used.
  const p = parseMessage({ id: "y", threadId: "y", internalDate: "0", labelIds: [], payload: { mimeType: "text/plain", headers: [{ name: "From", value: "a@b.example" }, { name: "In-Reply-To", value: "<parent@b.example>" }], body: { data: "" } } });
  assert.equal(p.references, "<parent@b.example>");
});

test("SEC-3: long subjects and names fold; lines with encoded words stay within 76 characters", () => {
  const raw = buildReply({
    from: me,
    to: [{ name: "Ž".repeat(60) + " Novak", email: "marija@bank.example" }, { name: "A very long plain name ".repeat(10), email: "long@bank.example" }],
    cc: [],
    subject: "Statement ".repeat(120) + "čćšž".repeat(30),
    inReplyTo: "", references: "", body: "b", outboxId: "o", date: new Date(),
  });
  const lines = raw.split("\r\n\r\n")[0]!.split("\r\n");
  for (const l of lines) {
    assert.ok(l.length <= 998, `over 998: ${l.slice(0, 40)}`);
    if (l.includes("=?")) assert.ok(l.length <= 76, `encoded word line ${l.length}: ${l}`);
  }
  const subject = raw.match(/^Subject: [\s\S]*?(?=\r\n\S)/m)![0].replace(/\r\n /g, " ");
  assert.ok(decodeEncodedWords(subject.slice(9)).startsWith("Re: Statement Statement"));
});

test("SEC-4: recipients learn nothing about the tool: no product name, no acknowledgement marker", () => {
  const raw = buildReply({ from: me, to: [{ name: "", email: "a@bank.example" }], cc: [], subject: "x", inReplyTo: "", references: "", body: "Hvala.", outboxId: "4f1c2b9e-0d7a-4f43-9b52-2f7a7b1d3c11", date: new Date() });
  const head = raw.split("\r\n\r\n")[0]!;
  assert.doesNotMatch(head, /triage|inbox|ack|kind/i);
  assert.match(head, /^X-Ref-ID: 4f1c2b9e-0d7a-4f43-9b52-2f7a7b1d3c11$/m);
});

test("SEC-5: archiving marks read only the answered message and older ones; newer mail stays in the inbox", async () => {
  const sender = new GmailSender(new OAuth2Client());
  const modified: string[][] = [];
  (sender as unknown as { api: unknown }).api = {
    users: {
      threads: { get: async () => ({ data: { messages: [
        { id: "m1", internalDate: "1000", labelIds: ["INBOX", "UNREAD"] },
        { id: "m2", internalDate: "2000", labelIds: ["INBOX"] },
        { id: "sent", internalDate: "2500", labelIds: ["SENT"] },
        { id: "m3", internalDate: "3000", labelIds: ["INBOX", "UNREAD"] },
      ] } }) },
      messages: { batchModify: async (r: { requestBody: { ids: string[] } }) => void modified.push(r.requestBody.ids) },
    },
  };
  await sender.archiveUpTo("t", new Date(2000));
  assert.deepEqual(modified, [["m1", "m2"]]);
});

test("SEC-6: an acknowledgement whose Gmail id is not recorded yet still never closes the message", async () => {
  const h = harness();
  h.add(msg({ id: "1a", thread: "t1", from: "Marija <marija@bank.example>", at: T0 }));
  await h.pipeline.pollOnce();
  const it = h.store.get("1a")!;
  const e = h.outbox.queue(it, "ack", ["marija@bank.example"], [], it.triage!.ack_reply);
  // Gmail took it, the connection dropped, and the lookup failed: the outcome is not recorded.
  h.sender.failSend = "after";
  h.sender.failFind = 1;
  h.due();
  await h.outbox.tick();
  assert.equal(h.store.outboxGet(e.id)!.state, "sending");
  await h.pipeline.pollOnce();
  assert.equal(h.store.get("1a")!.status, "needs_reply");
});

test("the original is quoted under your text, introduced in the reply's language", () => {
  const original = { date: new Date("2026-10-26T08:15:00Z"), fromEmail: "marija@bank.example", text: "Molimo dokumente.\n> starije" };
  const hr = withQuote("Hvala.", original, "hr", "Europe/Zagreb");
  assert.match(hr, /^Hvala\.\n\n.*, marija@bank\.example je napisao\/la:\n> Molimo dokumente\.\n>> starije\n$/);
  assert.match(withQuote("Tack.", original, "sv", "Europe/Stockholm"), / skrev marija@bank\.example:/);
  assert.match(withQuote("Thanks.", original, "en", "Europe/Zagreb"), /^Thanks\.\n\nOn .*, marija@bank\.example wrote:\n/);
});

// ---------- recipients and checks ----------

test("reply all: the sender and the original To, then Cc; you are left out; court mail goes to your lawyer alone", () => {
  const cfg = testConfig({ owner: { name: "Alan", emails: ["me@example.com", "alan@alias.example"] } });
  const r = replyRecipients(cfg, { replyToEmail: "Marija@Bank.example", replyRedirected: false, to: ["me@example.com", "ivan@bank.example"], cc: ["alan@alias.example", "advisor@advisor.example", "ivan@bank.example"] });
  assert.deepEqual(r, { to: ["marija@bank.example", "ivan@bank.example"], cc: ["advisor@advisor.example"] });
  const court = replyRecipients(cfg, { replyToEmail: "elin@lawfirm.example", replyRedirected: true, to: ["me@example.com"], cc: ["registry@court.example", "x@otherside.example"] });
  assert.deepEqual(court, { to: ["elin@lawfirm.example"], cc: [] });
});

function item(o: Partial<Item> = {}): Item {
  const now = new Date().toISOString();
  return {
    id: "1a", channel: "gmail", threadId: "t1", projectId: "croatia-bank", role: "bank", fromName: "Marija", fromEmail: "marija@bank.example",
    to: ["me@example.com"], cc: ["advisor@bank.example"], subject: "Dokumenti", receivedAt: now, body: "Molimo dokumente.", fullText: "Molimo dokumente.",
    onlyCc: false, senderVerified: true, replyToName: "Marija", replyToEmail: "marija@bank.example", replyRedirected: false, replyLanguage: "",
    link: "https://mail.google.com/x", attachments: [], notePath: "", status: "needs_reply", draft: null, userUrgency: null, reopenedAt: null,
    triageError: "", createdAt: now, updatedAt: now,
    triage: {
      title: "T", summary: "S", needs_reply: true, urgency: "today", urgency_score: 60, urgency_reason: "R", task: "Reply", due_date: "", reply_by: "", reply_by_utc: "",
      message_language: "hr", suggested_reply: "Poštovana,", draft_assumption: "", ack_reply: "Hvala, primljeno.\n\nLijep pozdrav,\nAlan", review_required: false, always_urgent: false, model: "m",
    },
    ...o,
  };
}

test("checks: brackets, empty text and bad addresses block a send; a Gmail draft may keep brackets", () => {
  const cfg = testConfig();
  const it = item();
  assert.match(checkSend(cfg, it, { kind: "reply", to: ["marija@bank.example"], cc: [], text: "Transfer on [date]." }).blockers.join(), /\[date\]/);
  assert.match(checkSend(cfg, it, { kind: "reply", to: ["marija@bank.example"], cc: [], text: "  " }).blockers.join(), /empty/);
  assert.match(checkSend(cfg, it, { kind: "reply", to: [], cc: [], text: "x" }).blockers.join(), /recipient/);
  assert.match(checkSend(cfg, it, { kind: "reply", to: ["marija@bank.example", "not an address"], cc: [], text: "x" }).blockers.join(), /not an address/);
  assert.deepEqual(checkSend(cfg, it, { kind: "draft", to: ["marija@bank.example"], cc: [], text: "Transfer on [date]." }), { blockers: [], confirm: [] });
});

test("checks: who needs a second confirmation, and who doesn't", () => {
  const cfg = testConfig();
  const it = item();
  const ok = checkSend(cfg, it, { kind: "reply", to: ["marija@bank.example"], cc: ["advisor@bank.example"], text: "Hvala." });
  assert.deepEqual(ok, { blockers: [], confirm: [] }, "people on the original need no confirmation");
  const added = checkSend(cfg, it, { kind: "reply", to: ["marija@bank.example"], cc: ["friend@gmail.example"], text: "Hvala." });
  assert.match(added.confirm.join(), /friend@gmail\.example was not on the original/);
  const otherMatter = checkSend(cfg, it, { kind: "reply", to: ["marija@bank.example"], cc: ["elin@lawfirm.example"], text: "Hvala." });
  assert.match(otherMatter.confirm.join(), /other matter/);
  const court = checkSend(cfg, it, { kind: "reply", to: ["marija@bank.example"], cc: ["registry@court.example"], text: "Hvala." });
  assert.match(court.confirm.join(), /the court/);
  const unverified = checkSend(cfg, item({ senderVerified: false }), { kind: "reply", to: ["marija@bank.example"], cc: [], text: "Hvala." });
  assert.match(unverified.confirm.join(), /could not verify/);
  const courtItem = item({ projectId: "sweden-legal", fromEmail: "registry@court.example", replyToEmail: "elin@lawfirm.example", replyRedirected: true, cc: [] });
  const viaLawyer = checkSend(cfg, courtItem, { kind: "reply", to: ["elin@lawfirm.example"], cc: [], text: "Elin, see below." });
  assert.match(viaLawyer.confirm.join(), /review required/);
  assert.match(checkSend(cfg, courtItem, { kind: "ack", to: ["elin@lawfirm.example"], cc: [], text: "x" }).blockers.join(), /no quick acknowledgement/);
});

test("a confirmation covers exactly what was shown", () => {
  const req = { kind: "reply" as const, to: ["marija@bank.example"], cc: [], text: "Hvala." };
  const t = confirmToken("s", "1a", req);
  assert.equal(confirmToken("s", "1a", { ...req, to: ["MARIJA@bank.example "] }), t, "the same addresses written differently");
  assert.notEqual(confirmToken("s", "1a", { ...req, text: "Hvala!" }), t);
  assert.notEqual(confirmToken("s", "1a", { ...req, cc: ["x@bank.example"] }), t);
  assert.notEqual(confirmToken("other", "1a", req), t);
});

// ---------- the outbox ----------

const ok = (o: Partial<ModelTriage> = {}): ModelTriage => ({
  title: "T", summary: "S", needs_reply: true, urgency: "today", urgency_score: 60, urgency_reason: "R", task: "Reply", due_date: "", reply_by: "",
  message_language: "hr", suggested_reply: "Poštovana,", draft_assumption: "", ack_reply: "Hvala, primljeno.\n\nLijep pozdrav,\nAlan", ...o,
});

function msg(o: { id: string; thread?: string; from: string; to?: string; cc?: string; subject?: string; at: number }): ParsedMessage {
  return parseMessage({
    id: o.id,
    threadId: o.thread ?? o.id,
    internalDate: String(o.at),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: o.from },
        { name: "To", value: o.to ?? "me@example.com" },
        { name: "Cc", value: o.cc ?? "" },
        { name: "Subject", value: o.subject ?? "Dokumenti" },
        { name: "Message-ID", value: `<${o.id}@mail.example>` },
        { name: "References", value: "<root@mail.example>" },
      ],
      body: { data: b64url("Molimo dokumente do srijede.") },
    },
  });
}

type Meta = { id: string; internalDate: Date; labelIds: string[]; fromEmail: string; recipients: string[]; ref: string };

class FakeSender {
  sent: { raw: string; threadId: string; id: string }[] = [];
  drafts: { raw: string; threadId: string }[] = [];
  archived: { threadId: string; upTo: string }[] = [];
  // "before": fails without sending; "after": Gmail took it, then the connection dropped.
  failSend: "before" | "after" | null = null;
  failFind = 0;
  failArchive = 0;
  constructor(private readonly onSent: (m: Meta) => void) {}
  async send(raw: string, threadId: string): Promise<string> {
    if (this.failSend === "before") {
      this.failSend = null;
      throw new Error("ETIMEDOUT");
    }
    const id = `sent${this.sent.length + 1}`;
    this.sent.push({ raw, threadId, id });
    const { headers } = decodeRaw(raw);
    const rcpt = [headers["to"] ?? "", headers["cc"] ?? ""].join(",").match(/[^\s<>,"]+@[^\s<>,"]+/g) ?? [];
    this.onSent({ id: `${threadId}:${id}`, internalDate: new Date(), labelIds: ["SENT"], fromEmail: "me@example.com", recipients: rcpt, ref: headers[OUTBOX_HEADER.toLowerCase()] ?? "" });
    if (this.failSend === "after") {
      this.failSend = null;
      throw new Error("socket hang up");
    }
    return id;
  }
  async findSent(threadId: string, outboxId: string): Promise<string | null> {
    if (this.failFind > 0) {
      this.failFind--;
      throw new Error("Gmail 503");
    }
    return this.sent.find((s) => s.threadId === threadId && decodeRaw(s.raw).headers[OUTBOX_HEADER.toLowerCase()] === outboxId)?.id ?? null;
  }
  async archiveUpTo(threadId: string, upTo: Date): Promise<void> {
    if (this.failArchive > 0) {
      this.failArchive--;
      throw new Error("Gmail 500");
    }
    this.archived.push({ threadId, upTo: upTo.toISOString() });
  }
  async createDraft(raw: string, threadId: string): Promise<string> {
    this.drafts.push({ raw, threadId });
    return "draft1";
  }
}

class FlakyVault extends VaultWriter {
  failWrites = 0;
  override write(rel: string, content: string): void {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("EBUSY");
    }
    super.write(rel, content);
  }
}

const HOUR = 3_600_000;
const T0 = Date.now() - 6 * HOUR;

function harness(cfgOverrides: Record<string, unknown> = {}) {
  const vaultDir = tempDir("vault-");
  const cfg = testConfig({ vault: { path: vaultDir }, sending: { enabled: true, undoSeconds: 5 }, ...cfgOverrides });
  const store = new Store(":memory:");
  const msgs = new Map<string, ParsedMessage>();
  const meta: Meta[] = [];
  const gmail = {
    listIds: async () => ({ ids: [...msgs.keys()], truncated: false }),
    message: async (id: string) => msgs.get(id)!,
    thread: async (id: string) => [...msgs.values()].filter((m) => m.threadId === id),
    threadMeta: async (id: string) => [
      ...[...msgs.values()].filter((m) => m.threadId === id).map((m) => ({ id: m.id, internalDate: m.internalDate, labelIds: m.labelIds, fromEmail: m.from.email, recipients: [], ref: "" })),
      ...meta.filter((m) => m.id.startsWith(id + ":")),
    ],
    attachment: async () => Buffer.from(""),
  };
  const answers: ModelTriage[] = [];
  const claude = {
    beta: { messages: { create: async () => ({ model: "m", stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify(answers.shift() ?? ok()) }] }) } },
  };
  const vault = new FlakyVault(vaultDir, 1e6, path.join(vaultDir, "..", "large"));
  const pipeline = new Pipeline(cfg, store, gmail as unknown as GmailReader, claude as unknown as Anthropic, vault);
  const sender = new FakeSender((m) => meta.push(m));
  const outbox = new Outbox({ cfg, store, reader: gmail as unknown as GmailReader, sender: sender as unknown as GmailSender, notes: pipeline.notes });
  return {
    cfg, store, pipeline, sender, outbox, vault, answers, meta,
    add: (m: ParsedMessage) => msgs.set(m.id, m),
    note: (rel: string) => fs.readFileSync(path.join(vaultDir, rel), "utf8"),
    /** Ends the Undo window of every queued send now. */
    due: () => store.db.prepare("UPDATE outbox SET send_at = ? WHERE state = 'queued'").run(new Date(Date.now() - 1000).toISOString()),
  };
}

test("outbox: nothing goes before the Undo window ends, and Undo stops it for good", async () => {
  const h = harness();
  h.add(msg({ id: "1a", from: "Marija <marija@bank.example>", at: T0 }));
  await h.pipeline.pollOnce();
  const e = h.outbox.queue(h.store.get("1a")!, "reply", ["marija@bank.example"], [], "Hvala.");
  await h.outbox.tick();
  assert.equal(h.sender.sent.length, 0, "still in the Undo window");
  assert.equal(h.outbox.undo(e.id), true);
  h.due();
  await h.outbox.tick();
  assert.equal(h.sender.sent.length, 0);
  assert.equal(h.store.outboxGet(e.id)!.state, "cancelled");
  assert.equal(h.store.get("1a")!.status, "needs_reply");
  assert.equal(h.outbox.undo(e.id), false);
});

test("outbox: a reply goes out once, threaded, then the item is replied, the note has it and the thread is archived", async () => {
  const h = harness();
  h.add(msg({ id: "1a", thread: "t1", from: "Marija <marija@bank.example>", cc: "Ivan <ivan@bank.example>", at: T0 }));
  await h.pipeline.pollOnce();
  const it = h.store.get("1a")!;
  const e = h.outbox.queue(it, "reply", ["marija@bank.example"], ["ivan@bank.example"], "Poštovana,\n\nšaljem do utorka.\n\nLijep pozdrav,\nAlan");
  assert.throws(() => h.outbox.queue(it, "reply", ["marija@bank.example"], [], "again"), OutboxError, "one send per message at a time");
  h.due();
  await h.outbox.tick();
  await h.outbox.tick();
  assert.equal(h.sender.sent.length, 1);
  const { headers, body } = decodeRaw(h.sender.sent[0]!.raw);
  assert.equal(h.sender.sent[0]!.threadId, "t1");
  assert.equal(headers["in-reply-to"], "<1a@mail.example>");
  assert.equal(headers["references"], "<root@mail.example> <1a@mail.example>");
  assert.equal(decodeEncodedWords(headers["to"]!), "Marija <marija@bank.example>");
  assert.equal(decodeEncodedWords(headers["cc"]!), "Ivan <ivan@bank.example>");
  assert.match(body, /šaljem do utorka\.[\s\S]*> Molimo dokumente do srijede\./);
  const done = h.store.outboxGet(e.id)!;
  assert.equal(done.state, "sent");
  assert.equal(done.effects, EFFECTS_ALL);
  assert.equal(h.store.get("1a")!.status, "replied");
  assert.deepEqual(h.sender.archived, [{ threadId: "t1", upTo: it.receivedAt }], "only up to the message you answered");
  const note = h.note(it.notePath);
  assert.match(note, /^## .* · You replied$/m);
  assert.match(note, new RegExp(`To: marija@bank\\.example · Cc: ivan@bank\\.example \\^out-${e.id}$`, "m"));
  assert.match(note, /> šaljem do utorka\./);
  assert.match(note, /^- \[x\] Reply \^it-1a$/m);
  // The poll that sees your sent reply changes nothing more.
  await h.pipeline.pollOnce();
  assert.equal(h.store.get("1a")!.status, "replied");
});

test("outbox: Gmail took it but the connection dropped: found by its id, not sent twice", async () => {
  const h = harness();
  h.add(msg({ id: "1a", from: "Marija <marija@bank.example>", at: T0 }));
  await h.pipeline.pollOnce();
  const e = h.outbox.queue(h.store.get("1a")!, "reply", ["marija@bank.example"], [], "Hvala.");
  h.sender.failSend = "after";
  h.due();
  await h.outbox.tick();
  assert.equal(h.sender.sent.length, 1);
  assert.equal(h.store.outboxGet(e.id)!.state, "sent");
  await h.outbox.maintain();
  assert.equal(h.sender.sent.length, 1);
});

test("outbox: a send that failed is shown as failed and goes again only on Retry", async () => {
  const h = harness();
  h.add(msg({ id: "1a", from: "Marija <marija@bank.example>", at: T0 }));
  await h.pipeline.pollOnce();
  const e = h.outbox.queue(h.store.get("1a")!, "reply", ["marija@bank.example"], [], "Hvala.");
  h.sender.failSend = "before";
  h.due();
  await h.outbox.tick();
  assert.equal(h.store.outboxGet(e.id)!.state, "failed");
  assert.match(h.store.outboxGet(e.id)!.error, /ETIMEDOUT/);
  await h.outbox.maintain();
  await h.outbox.tick();
  assert.equal(h.sender.sent.length, 0, "never sent again on its own");
  const again = await h.outbox.retry(e.id);
  assert.equal(again.state, "queued", "Retry gives a fresh Undo window");
  h.due();
  await h.outbox.tick();
  assert.equal(h.sender.sent.length, 1);
  assert.equal(h.store.get("1a")!.status, "replied");
});

test("outbox: when even the lookup fails, the send stays unknown and is settled later, never resent", async () => {
  const h = harness();
  h.add(msg({ id: "1a", from: "Marija <marija@bank.example>", at: T0 }));
  await h.pipeline.pollOnce();
  const e = h.outbox.queue(h.store.get("1a")!, "reply", ["marija@bank.example"], [], "Hvala.");
  h.sender.failSend = "after";
  h.sender.failFind = 1;
  h.due();
  await h.outbox.tick();
  assert.equal(h.store.outboxGet(e.id)!.state, "sending");
  await h.outbox.maintain();
  assert.equal(h.store.outboxGet(e.id)!.state, "sending", "checked again only after a minute");
  h.store.db.prepare("UPDATE outbox SET attempt_at = ? WHERE id = ?").run(new Date(Date.now() - 120_000).toISOString(), e.id);
  await h.outbox.maintain();
  assert.equal(h.store.outboxGet(e.id)!.state, "sent");
  assert.equal(h.sender.sent.length, 1);
  assert.equal(h.store.get("1a")!.status, "replied");
});

test("outbox: after a restart, a send left long in the queue waits for Retry, and one cut off mid-call is looked up", async () => {
  const h = harness();
  h.add(msg({ id: "1a", from: "Marija <marija@bank.example>", at: T0 }));
  h.add(msg({ id: "1b", from: "Ivan <ivan@bank.example>", at: T0 + HOUR }));
  await h.pipeline.pollOnce();
  const stale = h.outbox.queue(h.store.get("1a")!, "reply", ["marija@bank.example"], [], "Hvala.");
  h.store.db.prepare("UPDATE outbox SET send_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60_000).toISOString(), stale.id);
  const cut = h.outbox.queue(h.store.get("1b")!, "reply", ["ivan@bank.example"], [], "Hvala.");
  h.store.db.prepare("UPDATE outbox SET state = 'sending', attempt_at = ? WHERE id = ?").run(new Date().toISOString(), cut.id);
  const restarted = new Outbox({ cfg: h.cfg, store: h.store, reader: (h.outbox as unknown as { deps: { reader: GmailReader } }).deps.reader, sender: h.sender as unknown as GmailSender, notes: h.pipeline.notes });
  await restarted.recover();
  await restarted.tick();
  assert.equal(h.store.outboxGet(stale.id)!.state, "failed");
  assert.match(h.store.outboxGet(stale.id)!.error, /service was stopped/);
  assert.equal(h.store.outboxGet(cut.id)!.state, "failed", "not in Gmail, so it is failed, for you to retry");
  assert.equal(h.sender.sent.length, 0);
});

test("outbox: an acknowledgement keeps the message open, and only a real reply closes it", async () => {
  const h = harness();
  h.add(msg({ id: "1a", thread: "t1", from: "Marija <marija@bank.example>", at: T0 }));
  await h.pipeline.pollOnce();
  const it = h.store.get("1a")!;
  h.outbox.queue(it, "ack", ["marija@bank.example"], [], it.triage!.ack_reply);
  h.due();
  await h.outbox.tick();
  const acked = h.store.get("1a")!;
  assert.equal(acked.status, "needs_reply");
  assert.ok(acked.ackedAt);
  assert.match(h.note(it.notePath), /You acknowledged/);
  assert.deepEqual(h.sender.archived.map((a) => a.threadId), ["t1"]);
  // The poll sees the acknowledgement in Gmail and leaves the item open.
  await h.pipeline.pollOnce();
  assert.equal(h.store.get("1a")!.status, "needs_reply");
  // A real reply, sent from Gmail, closes it.
  h.meta.push({ id: "t1:gmail-reply", internalDate: new Date(), labelIds: ["SENT"], fromEmail: "me@example.com", recipients: ["marija@bank.example"], ref: "" });
  await h.pipeline.pollOnce();
  assert.equal(h.store.get("1a")!.status, "replied");
});

test("outbox: a failed archive or note write is finished later, each step once", async () => {
  const h = harness();
  h.add(msg({ id: "1a", thread: "t1", from: "Marija <marija@bank.example>", at: T0 }));
  await h.pipeline.pollOnce();
  const it = h.store.get("1a")!;
  const e = h.outbox.queue(it, "reply", ["marija@bank.example"], [], "Hvala.");
  h.sender.failArchive = 1;
  // Status sync and the "You replied" section both write the note: fail both.
  h.vault.failWrites = 2;
  h.due();
  await h.outbox.tick();
  assert.equal(h.store.outboxGet(e.id)!.state, "sent");
  assert.notEqual(h.store.outboxGet(e.id)!.effects, EFFECTS_ALL);
  await h.outbox.maintain();
  await h.outbox.maintain();
  assert.equal(h.store.outboxGet(e.id)!.effects, EFFECTS_ALL);
  assert.deepEqual(h.sender.archived.map((a) => a.threadId), ["t1"]);
  const note = h.note(it.notePath);
  assert.equal(note.match(/You replied/g)?.length, 1);
  const statusEvents = h.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE item_id = '1a' AND kind = 'status'").get() as { n: number };
  assert.equal(statusEvents.n, 1);
  // The note catches up on the next poll too.
  await h.pipeline.pollOnce();
  assert.match(h.note(it.notePath), /^status: replied$/m);
});

test("outbox: court mail is answered to your lawyer only, with the court's letter quoted", async () => {
  const h = harness();
  h.add(msg({ id: "2a", thread: "t2", from: "Registry <registry@court.example>", cc: "x@otherside.example, elin@lawfirm.example", subject: "Föreläggande", at: T0 }));
  await h.pipeline.pollOnce();
  const it = h.store.get("2a")!;
  const r = replyRecipients(h.cfg, it);
  assert.deepEqual(r, { to: ["elin@lawfirm.example"], cc: [] });
  h.outbox.queue(it, "reply", r.to, r.cc, "Elin, see the court's letter below.");
  h.due();
  await h.outbox.tick();
  const { headers, body } = decodeRaw(h.sender.sent[0]!.raw);
  assert.equal(decodeEncodedWords(headers["to"]!), "Elin Holm <elin@lawfirm.example>");
  assert.equal(headers["cc"], undefined);
  assert.equal(decodeEncodedWords(headers["subject"]!), "Re: Föreläggande");
  assert.match(body, /> Molimo dokumente do srijede\./);
});

// ---------- the server ----------

async function serve(h: ReturnType<typeof harness>, enabled = true) {
  const cfg = { ...h.cfg, sending: { ...h.cfg.sending, enabled } };
  const server = createServer({ cfg, store: h.store, pipeline: h.pipeline, vault: h.vault, lastPoll: () => null, outbox: h.outbox });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, body: unknown) =>
    fetch(base + p, { method: "POST", headers: { "x-inbox-triage": "1", "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));
  return { server, base, post };
}

test("server: court mail needs the second confirmation, bound to the exact text; then it is queued and can be undone", async () => {
  const h = harness();
  h.add(msg({ id: "2a", thread: "t2", from: "Registry <registry@court.example>", subject: "Föreläggande", at: T0 }));
  await h.pipeline.pollOnce();
  const { server, base, post } = await serve(h);
  try {
    const detail = (await (await fetch(`${base}/api/items/2a`)).json()) as { recipients: { to: string[] }; sending: { enabled: boolean } };
    assert.deepEqual(detail.recipients.to, ["elin@lawfirm.example"]);
    const req = { kind: "reply", to: ["elin@lawfirm.example"], cc: [], text: "Elin, see below." };
    const first = await post("/api/items/2a/send", req);
    assert.equal(first.status, 409);
    assert.equal(first.json.needsConfirm, true);
    assert.match(String(first.json.reasons), /review required/);
    assert.equal(h.store.outboxForItem("2a").length, 0, "nothing queued before the second confirmation");
    const changed = await post("/api/items/2a/send", { ...req, text: "Elin, see below!", confirm: first.json.token });
    assert.equal(changed.status, 409, "a confirmation for different text does not count");
    const queued = await post("/api/items/2a/send", { ...req, confirm: first.json.token });
    assert.equal(queued.status, 202);
    const undo = await post(`/api/outbox/${String(queued.json.id)}/undo`, {});
    assert.equal(undo.status, 200);
    assert.equal(h.store.outboxGet(String(queued.json.id))!.state, "cancelled");
  } finally {
    server.close();
  }
});

test("server: sending off blocks Send but not a Gmail draft; brackets and acknowledgements are checked on the server", async () => {
  const h = harness();
  h.add(msg({ id: "1a", thread: "t1", from: "Marija <marija@bank.example>", at: T0 }));
  h.add(msg({ id: "2a", thread: "t2", from: "Registry <registry@court.example>", at: T0 }));
  await h.pipeline.pollOnce();
  const off = await serve(h, false);
  try {
    const r = await off.post("/api/items/1a/send", { kind: "reply", to: ["marija@bank.example"], cc: [], text: "Hvala." });
    assert.equal(r.status, 403);
    const d = await off.post("/api/items/1a/gmail-draft", { to: ["marija@bank.example"], cc: [], text: "Transfer on [date]." });
    assert.equal(d.status, 200);
    assert.equal(h.sender.drafts.length, 1);
    assert.equal(h.sender.drafts[0]!.threadId, "t1");
  } finally {
    off.server.close();
  }
  const on = await serve(h, true);
  try {
    const br = await on.post("/api/items/1a/send", { kind: "reply", to: ["marija@bank.example"], cc: [], text: "Transfer on [date]." });
    assert.equal(br.status, 400);
    assert.match(String(br.json.error), /\[date\]/);
    const ack = await on.post("/api/items/2a/send", { kind: "ack", to: ["elin@lawfirm.example"], cc: [] });
    assert.equal(ack.status, 400, "no quick acknowledgement to court mail, whatever the page sends");
    const fine = await on.post("/api/items/1a/send", { kind: "ack", to: ["marija@bank.example"], cc: [], text: "ignored" });
    assert.equal(fine.status, 202);
    assert.equal(h.store.outboxGet(String(fine.json.id))!.body, h.store.get("1a")!.triage!.ack_reply, "the acknowledgement is Claude's text, not the page's");
    const twice = await on.post("/api/items/1a/send", { kind: "reply", to: ["marija@bank.example"], cc: [], text: "Hvala." });
    assert.equal(twice.status, 409, "one send per message at a time");
  } finally {
    on.server.close();
  }
});
