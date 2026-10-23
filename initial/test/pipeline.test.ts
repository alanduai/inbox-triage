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

function gmailMessage(o: { id: string; threadId: string; from: string; to: string; cc?: string; subject: string; body: string; at: number; labels?: string[]; attachment?: boolean }) {
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
  sentInThread = new Map<string, number>();
  add(raw: ReturnType<typeof gmailMessage>) {
    this.messages.set(raw.id, parseMessage(raw));
  }
  async listIds() {
    return [...this.messages.keys()].reverse();
  }
  async message(id: string) {
    return this.messages.get(id)!;
  }
  async thread(id: string) {
    return [...this.messages.values()].filter((m) => m.threadId === id);
  }
  async threadMeta(id: string) {
    const out = [...this.messages.values()].filter((m) => m.threadId === id).map((m) => ({ id: m.id, internalDate: m.internalDate, labelIds: m.labelIds, fromEmail: m.from.email }));
    const sent = this.sentInThread.get(id);
    if (sent) out.push({ id: "sent1", internalDate: new Date(sent), labelIds: ["SENT"], fromEmail: "me@example.com" });
    return out;
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
  assert.deepEqual(r1, { matched: 1, ingested: 1, failed: 0, closedByReply: 0 });
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
  assert.match(params.messages[0]!.content, /Reply goes to: Elin Holm <elin@lawfirm.example> \(the sender\)/);

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

  // You answer from Gmail or Superhuman: the next poll closes both and ticks their tasks.
  gmail.sentInThread.set("19c421a3b46d9a6b", t0 + 7_200_000);
  const r3 = await pipeline.pollOnce();
  assert.equal(r3.closedByReply, 2);
  assert.equal(store.get("19c421a3b46d9a6b")!.status, "replied");
  const note3 = fs.readFileSync(path.join(vaultDir, item.notePath), "utf8");
  assert.match(note3, /- \[x\] Review sections 3 and 4/);
  assert.match(note3, /status: replied/);
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

test("config refuses a network-reachable dashboard without a token", () => {
  assert.throws(() => parseConfig({ ...JSON.parse(JSON.stringify(testConfig())), dashboard: { host: "0.0.0.0" } }, "/tmp/c.json"), /dashboard.token is required/);
});
