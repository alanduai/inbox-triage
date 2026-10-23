import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { GmailReader } from "../src/gmail/client.js";
import { parseMessage, type ParsedMessage } from "../src/gmail/parse.js";
import { VaultWriter } from "../src/obsidian/writer.js";
import { Pipeline } from "../src/pipeline.js";
import { Store } from "../src/store/db.js";
import { parseConfig } from "../src/config.js";
import { b64url, tempDir, testConfig } from "./helpers.js";

function gmailMessage(o: { id: string; threadId: string; from: string; to: string; cc?: string; subject: string; body: string; at: number; labels?: string[]; attachment?: boolean; auth?: string }) {
  return {
    id: o.id,
    threadId: o.threadId,
    internalDate: String(o.at),
    labelIds: o.labels ?? ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: o.from },
        { name: "To", value: o.to },
        { name: "Cc", value: o.cc ?? "" },
        { name: "Subject", value: o.subject },
        { name: "Message-ID", value: `<${o.id}@mail.example>` },
        ...(o.auth ? [{ name: "Authentication-Results", value: o.auth }] : []),
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64url(o.body) } },
        ...(o.attachment ? [{ mimeType: "application/pdf", filename: "Draft statement.pdf", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { attachmentId: "att-" + o.id, size: 5 } }] : []),
      ],
    },
  };
}

class FakeGmail {
  messages = new Map<string, ParsedMessage>();
  // Extra thread entries (your sent replies, drafts) seen only by threadMeta.
  extra = new Map<string, { id: string; internalDate: Date; labelIds: string[]; fromEmail: string; recipients: string[] }[]>();
  broken = new Set<string>();
  add(raw: ReturnType<typeof gmailMessage>) {
    this.messages.set(raw.id, parseMessage(raw));
  }
  addMeta(threadId: string, at: number, labelIds: string[], recipients = ["elin@lawfirm.example"]) {
    const list = this.extra.get(threadId) ?? [];
    list.push({ id: `x${list.length}`, internalDate: new Date(at), labelIds, fromEmail: "me@example.com", recipients });
    this.extra.set(threadId, list);
  }
  async listIds() {
    return { ids: [...this.broken, ...this.messages.keys()].reverse(), truncated: false };
  }
  async message(id: string) {
    if (this.broken.has(id)) throw new RangeError("Invalid code point 1114112");
    return this.messages.get(id)!;
  }
  async thread(id: string) {
    return [...this.messages.values()].filter((m) => m.threadId === id);
  }
  async threadMeta(id: string) {
    const out = [...this.messages.values()]
      .filter((m) => m.threadId === id)
      .map((m) => ({ id: m.id, internalDate: m.internalDate, labelIds: m.labelIds, fromEmail: m.from.email, recipients: [...m.to, ...m.cc].map((a) => a.email) }));
    return [...out, ...(this.extra.get(id) ?? [])];
  }
  async attachment() {
    return Buffer.from("%PDF-");
  }
}

function fakeClaude(answers: Record<string, unknown>[]) {
  const calls: unknown[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: unknown) => {
          calls.push(params);
          const answer = answers.shift();
          if (!answer) throw new Error("no more fake answers");
          return { model: "claude-opus-5-5", stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify(answer) }] };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const answer = {
  title: "Comments on the draft statement by Monday",
  summary: "Elin sent the draft statement and needs comments.",
  needs_reply: true,
  urgency: "today",
  urgency_score: 70,
  urgency_reason: "Filing deadline Monday 12:00.",
  task: "Review sections 3 and 4",
  due_date: "2026-10-26",
  reply_by: "2026-10-26T10:00",
  message_language: "en",
  suggested_reply: "Hi Elin,\n\nI will send my comments by Monday 10:00. The transfer was on [date].",
  draft_assumption: "Commits you to Monday 10:00; one date left in brackets.",
  ack_reply: "Thanks Elin, received.",
};

test("a new message is triaged, filed to Obsidian, and closed when you reply", async () => {
  const vaultDir = tempDir("vault-");
  fs.mkdirSync(path.join(vaultDir, ".obsidian"));
  const cfg = testConfig({ vault: { path: vaultDir, maxSyncFileMB: 1 } });
  const store = new Store(":memory:");
  const gmail = new FakeGmail();
  const t0 = Date.UTC(2026, 9, 23, 8, 12);
  gmail.add(gmailMessage({ id: "19c421a3b46d9a6b", threadId: "19c421a3b46d9a6b", from: "Elin Holm <elin@lawfirm.example>", to: "me@example.com", subject: "Draft statement", body: "Please comment by Monday 12:00.\n\nOn Mon, Elin wrote:\n> old", at: t0, attachment: true }));
  gmail.add(gmailMessage({ id: "1a00000000000001", threadId: "1a00000000000001", from: "Spam <x@unknown.example>", to: "me@example.com", subject: "Offer", body: "Buy", at: t0 + 1000 }));
  const claude = fakeClaude([answer, { ...answer, title: "Reminder about the deadline", task: "Reply to the reminder", suggested_reply: "Hi Elin,\n\nYes, Monday.\n\nBest regards,\nAlan" }]);
  const pipeline = new Pipeline(cfg, store, gmail as unknown as GmailReader, claude.client, new VaultWriter(vaultDir, 1_000_000, path.join(vaultDir, "..", "large")));

  const r1 = await pipeline.pollOnce();
  assert.deepEqual(r1, { matched: 1, ingested: 1, failed: 0, refiled: 0, closedByReply: 0 });
  assert.ok(store.isSkipped("1a00000000000001"));

  const item = store.get("19c421a3b46d9a6b")!;
  assert.equal(item.status, "needs_reply");
  assert.equal(item.triage?.urgency, "urgent", "Elin is always urgent");
  assert.equal(item.triage?.suggested_reply.endsWith("Best regards,\nAlan"), true);
  assert.equal(item.body, "Please comment by Monday 12:00.");
  assert.equal(item.link, "https://mail.google.com/mail/?authuser=me%40example.com#all/thread-f:1856645933373954667|msg-f:1856645933373954667");
  assert.equal(item.notePath, "Projects/Sweden legal matter/2026-10-23 Draft statement.md");

  const note = fs.readFileSync(path.join(vaultDir, item.notePath), "utf8");
  assert.match(note, /^---\nsource: gmail\nproject: Sweden — legal matter\nsubject: Draft statement\n/);
  assert.match(note, /status: needs_reply/);
  assert.match(note, /urgency: urgent/);
  assert.match(note, /\[\[Projects\/Sweden legal matter\/attachments\/2026-10-23 Draft statement.pdf\|Draft statement.pdf\]\]/);
  assert.match(note, /- \[ \] Review sections 3 and 4 📅 2026-10-26 \^it-19c421a3b46d9a6b/);
  assert.ok(fs.existsSync(path.join(vaultDir, "Projects/Sweden legal matter/attachments/2026-10-23 Draft statement.pdf")));

  // The prompt carried the routing facts and the untrusted-data framing.
  const params = claude.calls[0] as { system: string; messages: { content: string }[]; fallbacks: string; output_config: { format: { type: string } } };
  assert.equal(params.fallbacks, "default");
  assert.equal(params.output_config.format.type, "json_schema");
  assert.match(params.system, /untrusted data/);
  assert.match(params.messages[0]!.content, /Reply goes to: the sender \(elin@lawfirm.example\)/);

  // You edit the note on another device; a second message in the thread keeps your edit.
  const edited = note.replace("# Draft statement\n", "# Draft statement\n\nMy own note.\n").replace("tags: [inbox, gmail]", "tags: [inbox, gmail]\nmine: keep");
  fs.writeFileSync(path.join(vaultDir, item.notePath), edited);
  gmail.add(gmailMessage({ id: "1a10000000000002", threadId: "19c421a3b46d9a6b", from: "Elin Holm <elin@lawfirm.example>", to: "me@example.com", subject: "Re: Draft statement", body: "Reminder: Monday.", at: t0 + 3_600_000 }));
  const r2 = await pipeline.pollOnce();
  assert.equal(r2.ingested, 1);
  const note2 = fs.readFileSync(path.join(vaultDir, item.notePath), "utf8");
  assert.match(note2, /My own note\./);
  assert.match(note2, /mine: keep/);
  assert.match(note2, /Reminder: Monday\./);
  assert.equal((note2.match(/^## /gm) ?? []).length, 2);

  // A draft you saved in Gmail is not a reply: nothing closes.
  gmail.addMeta("19c421a3b46d9a6b", t0 + 5_000_000, ["DRAFT"]);
  assert.equal((await pipeline.pollOnce()).closedByReply, 0);
  assert.equal(store.get("19c421a3b46d9a6b")!.status, "needs_reply");

  // You answer from Gmail or Superhuman: the next poll closes both and ticks their tasks.
  gmail.addMeta("19c421a3b46d9a6b", t0 + 7_200_000, ["SENT"]);
  const r3 = await pipeline.pollOnce();
  assert.equal(r3.closedByReply, 2);
  assert.equal(store.get("19c421a3b46d9a6b")!.status, "replied");
  const note3 = fs.readFileSync(path.join(vaultDir, item.notePath), "utf8");
  assert.match(note3, /- \[x\] Review sections 3 and 4/);
  assert.match(note3, /status: replied/);

  // You put it back in the queue: that same reply no longer closes it.
  pipeline.setStatus("19c421a3b46d9a6b", "needs_reply", "test");
  assert.ok(store.get("19c421a3b46d9a6b")!.reopenedAt);
  assert.equal((await pipeline.pollOnce()).closedByReply, 0);
  assert.equal(store.get("19c421a3b46d9a6b")!.status, "needs_reply");
  // The note describes the thread: one item still open, so the thread is open.
  assert.match(fs.readFileSync(path.join(vaultDir, item.notePath), "utf8"), /status: needs_reply/);
  store.close();
});

test("court mail in cc is routed to your lawyer, gets no acknowledgement, and a refusal is recorded", async () => {
  const vaultDir = tempDir("vault-");
  const cfg = testConfig({ vault: { path: vaultDir } });
  const store = new Store(":memory:");
  const gmail = new FakeGmail();
  const t0 = Date.UTC(2026, 9, 23, 9, 5);
  gmail.add(gmailMessage({ id: "1b00000000000001", threadId: "1b00000000000001", from: "Registry <registry@court.example>", to: "elin@lawfirm.example", cc: "me@example.com", subject: "Kallelse", body: "Kallelse till muntlig förberedelse.", at: t0 }));
  gmail.add(gmailMessage({ id: "1b00000000000002", threadId: "1b00000000000002", from: "Bank <info@bank.example>", to: "me@example.com", subject: "Notice", body: "New document.", at: t0 + 1000 }));
  const claude = fakeClaude([{ ...answer, message_language: "sv", ack_reply: "Tack, mottaget." }]);
  // Second call: a refusal.
  const create = (claude.client as unknown as { beta: { messages: { create: (p: unknown) => Promise<unknown> } } }).beta.messages;
  const original = create.create;
  let n = 0;
  create.create = async (p: unknown) => (n++ === 0 ? original(p) : { model: "claude-opus-5-5", stop_reason: "refusal", stop_details: { category: "general_harms" }, content: [] });

  const pipeline = new Pipeline(cfg, store, gmail as unknown as GmailReader, claude.client, new VaultWriter(vaultDir, 1_000_000, path.join(vaultDir, "..", "large")));
  await pipeline.pollOnce();

  const court = store.get("1b00000000000001")!;
  assert.equal(court.onlyCc, true);
  assert.equal(court.replyRedirected, true);
  assert.equal(court.replyToEmail, "elin@lawfirm.example");
  assert.equal(court.triage?.ack_reply, "");
  assert.equal(court.triage?.review_required, true);
  assert.ok(court.triage?.suggested_reply.endsWith("Best regards,\nAlan"), "the lawyer is written to in English");

  const bank = store.get("1b00000000000002")!;
  assert.equal(bank.status, "triage_failed");
  assert.match(bank.triageError, /declined/);
  const note = fs.readFileSync(path.join(vaultDir, bank.notePath), "utf8");
  assert.match(note, /- \[ \] Triage this message by hand \^it-1b00000000000002/);
  store.close();
});

test("one unreadable message does not block the others, and an unfiled item is finished later", async () => {
  const vaultDir = tempDir("vault-");
  const cfg = testConfig({ vault: { path: vaultDir } });
  const store = new Store(":memory:");
  const gmail = new FakeGmail();
  const t0 = Date.UTC(2026, 9, 23, 9, 0);
  gmail.broken.add("1c00000000000009");
  gmail.add(gmailMessage({ id: "1c00000000000001", threadId: "1c00000000000001", from: "Bank <info@bank.example>", to: "me@example.com", subject: "Statement", body: "Attached.", at: t0 }));
  const claude = fakeClaude([{ ...answer, needs_reply: false, task: "", urgency: "fyi" }]);
  const vault = new VaultWriter(vaultDir, 1_000_000, path.join(vaultDir, "..", "large"));
  // The first note write fails, as on a full disk.
  const realWrite = vault.write.bind(vault);
  let failOnce = true;
  vault.write = (rel: string, content: string) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("ENOSPC: no space left on device");
    }
    realWrite(rel, content);
  };
  const pipeline = new Pipeline(cfg, store, gmail as unknown as GmailReader, claude.client, vault);

  const r = await pipeline.pollOnce();
  assert.equal(r.failed, 2, "the unreadable message and the failed write");
  assert.equal(r.refiled, 1, "the stored item is finished in the same poll, without calling Claude again");
  const item = store.get("1c00000000000001")!;
  assert.equal(item.status, "no_reply_needed");
  assert.ok(item.notePath && fs.existsSync(path.join(vaultDir, item.notePath)));
  assert.equal(claude.calls.length, 1);
  store.close();
});

test("an unverified sender gets no acknowledgement, no always-urgent lift, and a warning in the note", async () => {
  const vaultDir = tempDir("vault-");
  const cfg = testConfig({ vault: { path: vaultDir } });
  const store = new Store(":memory:");
  const gmail = new FakeGmail();
  gmail.add(
    gmailMessage({
      id: "1d00000000000001",
      threadId: "1d00000000000001",
      from: "Elin Holm <elin@lawfirm.example>",
      to: "me@example.com",
      subject: "New bank details",
      body: "Please pay to the new account.",
      at: Date.UTC(2026, 9, 23, 9, 0),
      auth: "mx.google.com; dkim=fail header.i=@lawfirm.example; spf=softfail smtp.mailfrom=evil.example; dmarc=fail (p=NONE) header.from=lawfirm.example",
    }),
  );
  const claude = fakeClaude([{ ...answer, urgency: "today" }]);
  const pipeline = new Pipeline(cfg, store, gmail as unknown as GmailReader, claude.client, new VaultWriter(vaultDir, 1_000_000, path.join(vaultDir, "..", "large")));
  await pipeline.pollOnce();
  const item = store.get("1d00000000000001")!;
  assert.equal(item.senderVerified, false);
  assert.equal(item.triage?.urgency, "today", "not raised to urgent");
  assert.equal(item.triage?.ack_reply, "");
  assert.equal(item.triage?.review_required, true);
  assert.match((claude.calls[0] as { messages: { content: string }[] }).messages[0]!.content, /Sender authentication: FAILED/);
  assert.match(fs.readFileSync(path.join(vaultDir, item.notePath), "utf8"), /sender not verified by Gmail/);
  store.close();
});

test("config refuses a project folder outside the vault", () => {
  const base = JSON.parse(JSON.stringify(testConfig()));
  base.projects[0].folder = "../Elsewhere";
  assert.throws(() => parseConfig(base, "/tmp/c.json"), /inside the vault/);
});

test("config refuses a network-reachable dashboard without a token", () => {
  assert.throws(() => parseConfig({ ...JSON.parse(JSON.stringify(testConfig())), dashboard: { host: "0.0.0.0" } }, "/tmp/c.json"), /dashboard.token is required/);
});
