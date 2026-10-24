import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import type { GmailReader } from "../src/gmail/client.js";
import { parseMessage, type ParsedMessage } from "../src/gmail/parse.js";
import { VaultWriter } from "../src/obsidian/writer.js";
import { Pipeline } from "../src/pipeline.js";
import { createServer } from "../src/server/server.js";
import { Store, type Item } from "../src/store/db.js";
import type { ModelTriage } from "../src/triage/schema.js";
import { b64url, tempDir, testConfig } from "./helpers.js";

// ---------- harness: fake Gmail and Claude, and a vault whose writes can fail ----------

class FlakyVault extends VaultWriter {
  failWrites = 0;
  override write(rel: string, content: string): void {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("EBUSY: resource busy or locked");
    }
    super.write(rel, content);
  }
}

function msg(o: { id: string; thread?: string; from: string; subject?: string; body?: string; at: number }): ParsedMessage {
  return parseMessage({
    id: o.id,
    threadId: o.thread ?? o.id,
    internalDate: String(o.at),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: o.from },
        { name: "To", value: "me@example.com" },
        { name: "Subject", value: o.subject ?? "Subject" },
      ],
      body: { data: b64url(o.body ?? "Please confirm.") },
    },
  });
}

const ok = (o: Partial<ModelTriage> = {}): ModelTriage => ({
  title: "T", summary: "S", needs_reply: true, urgency: "today", urgency_score: 60, urgency_reason: "R", task: "Reply", due_date: "", reply_by: "",
  message_language: "en", suggested_reply: "Hi", draft_assumption: "", ack_reply: "Received.", ...o,
});

function harness() {
  const vaultDir = tempDir("vault-");
  const cfg = testConfig({ vault: { path: vaultDir } });
  const store = new Store(":memory:");
  const msgs = new Map<string, ParsedMessage>();
  const sentMeta: { id: string; internalDate: Date; labelIds: string[]; fromEmail: string; recipients: string[] }[] = [];
  const gone = new Set<string>();
  const queries: string[] = [];
  let listTwice = false;
  const gmail = {
    // Honours after: and newer_than: like Gmail does.
    listIds: async (q: string) => {
      queries.push(q);
      const after = Number(q.match(/after:(\d+)/)?.[1] ?? 0) * 1000;
      const days = Number(q.match(/newer_than:(\d+)d/)?.[1] ?? 0);
      const from = days ? Date.now() - days * 86_400_000 : after;
      const ids = [...msgs.values()].filter((m) => m.internalDate.getTime() > from).map((m) => m.id);
      return { ids: listTwice ? [...ids, ...ids] : ids, truncated: false };
    },
    message: async (id: string) => {
      if (gone.has(id)) throw Object.assign(new Error("Requested entity was not found."), { status: 404 });
      return msgs.get(id)!;
    },
    thread: async (id: string) => [...msgs.values()].filter((m) => m.threadId === id),
    threadMeta: async (id: string) => [
      ...[...msgs.values()].filter((m) => m.threadId === id).map((m) => ({ id: m.id, internalDate: m.internalDate, labelIds: m.labelIds, fromEmail: m.from.email, recipients: [] })),
      ...sentMeta.filter((m) => m.id.startsWith(id + ":")),
    ],
    attachment: async () => Buffer.from("%PDF"),
  };
  const answers: unknown[] = [];
  let calls = 0;
  let hold: Promise<void> | null = null;
  const claude = {
    beta: {
      messages: {
        create: async () => {
          calls++;
          if (hold) await hold;
          return { model: "m", stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify(answers.shift() ?? ok()) }] };
        },
      },
    },
  };
  const vault = new FlakyVault(vaultDir, 1e6, path.join(vaultDir, "..", "large"));
  const pipeline = new Pipeline(cfg, store, gmail as unknown as GmailReader, claude as unknown as Anthropic, vault);
  return {
    cfg, store, pipeline, vault, vaultDir, answers, queries, gone,
    calls: () => calls,
    add: (m: ParsedMessage) => msgs.set(m.id, m),
    sent: (thread: string, at: number, recipients: string[]) =>
      sentMeta.push({ id: `${thread}:sent${sentMeta.length}`, internalDate: new Date(at), labelIds: ["SENT"], fromEmail: "me@example.com", recipients }),
    listTwice: () => (listTwice = true),
    /** Holds Claude's answers until the returned function is called. */
    holdClaude: () => {
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
    note: (rel: string) => fs.readFileSync(path.join(vaultDir, rel), "utf8"),
    taskOf: (rel: string, id: string) => fs.readFileSync(path.join(vaultDir, rel), "utf8").split("\n").find((l) => l.endsWith(`^it-${id}`)) ?? "",
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), "condition never became true");
}

const HOUR = 3_600_000;
// Earlier today, so the first poll's lookback includes it.
const T0 = Date.now() - 10 * HOUR;
const BANK = "Marija <marija@bank.example>";

// ---------- L1-1 a note's file name is never shared by two threads ----------

test("L1-1: a deleted note's name is not reused by another thread, and a thread never writes into a note that isn't its own", async () => {
  const h = harness();
  h.add(msg({ id: "a1", thread: "tA", from: BANK, subject: "Statement available", at: T0 }));
  await h.pipeline.pollOnce();
  const pathA = h.store.get("a1")!.notePath;
  fs.rmSync(path.join(h.vaultDir, pathA));

  // A new thread with the same subject on the same day.
  h.add(msg({ id: "b1", thread: "tB", from: BANK, subject: "Statement available", at: T0 + HOUR }));
  await h.pipeline.pollOnce();
  const pathB = h.store.get("b1")!.notePath;
  assert.notEqual(pathB, pathA, "B gets its own file name");

  // More mail in thread A, and your reply in A: B's note is untouched.
  h.add(msg({ id: "a2", thread: "tA", from: BANK, subject: "Re: Statement available", at: T0 + 2 * HOUR }));
  h.sent("tA", T0 + 3 * HOUR, ["marija@bank.example"]);
  await h.pipeline.pollOnce();
  const noteB = h.note(pathB);
  assert.doesNotMatch(noteB, /it-a2/);
  assert.match(noteB, /^status: needs_reply$/m);
  assert.notEqual(h.store.get("a2")!.notePath, pathB);
});

test("L1-1: a file you put at a thread's old note path is left alone", async () => {
  const h = harness();
  h.add(msg({ id: "a1", thread: "tA", from: BANK, subject: "Loan offer", at: T0 }));
  await h.pipeline.pollOnce();
  const rel = h.store.get("a1")!.notePath;
  const mine = "# My own note\n\nNothing from the app here.\n";
  fs.writeFileSync(path.join(h.vaultDir, rel), mine);
  h.add(msg({ id: "a2", thread: "tA", from: BANK, subject: "Re: Loan offer", at: T0 + HOUR }));
  await h.pipeline.pollOnce();
  assert.equal(h.note(rel), mine);
  const a2 = h.store.get("a2")!;
  assert.ok(a2.notePath && a2.notePath !== rel);
  assert.match(h.note(a2.notePath), /\^it-a2/);
});

// ---------- L1-2 the checkbox follows the item's status ----------

test("L1-2: a reply found while the vault was unavailable is ticked when the note is finally written", async () => {
  const h = harness();
  h.add(msg({ id: "a1", from: BANK, at: T0 }));
  h.sent("a1", T0 + HOUR, ["marija@bank.example"]);
  h.vault.failWrites = 99;
  await h.pipeline.pollOnce();
  assert.equal(h.store.get("a1")!.status, "replied");
  h.vault.failWrites = 0;
  await h.pipeline.pollOnce();
  const rel = h.store.get("a1")!.notePath;
  assert.match(h.taskOf(rel, "a1"), /^- \[x\] Reply/);
  assert.match(h.note(rel), /^status: replied$/m);
});

test("L1-2: 'No reply needed' pressed while Claude is still reading the message is kept, and the note agrees", async () => {
  const h = harness();
  h.add(msg({ id: "a1", from: BANK, at: T0 }));
  const release = h.holdClaude();
  const poll = h.pipeline.pollOnce();
  await until(() => h.calls() === 1);
  h.pipeline.setStatus("a1", "no_reply_needed", "set in dashboard");
  release();
  await poll;
  const item = h.store.get("a1")!;
  assert.equal(item.status, "no_reply_needed");
  assert.ok(item.triage, "the triage is still stored");
  assert.match(h.taskOf(item.notePath, "a1"), /^- \[x\] Reply/);
  assert.match(h.note(item.notePath), /^status: no_reply_needed$/m);
});

// ---------- L1-3 a failed note write is repaired on the next poll ----------

test("L1-3: a dashboard choice whose note write failed reaches the note on the next poll", async () => {
  const h = harness();
  h.add(msg({ id: "a1", from: BANK, at: T0 }));
  await h.pipeline.pollOnce();
  const rel = h.store.get("a1")!.notePath;
  h.vault.failWrites = 1;
  h.pipeline.setStatus("a1", "no_reply_needed", "set in dashboard");
  assert.match(h.taskOf(rel, "a1"), /^- \[ \]/);
  const r = await h.pipeline.pollOnce();
  assert.equal(r.failed, 0);
  assert.match(h.taskOf(rel, "a1"), /^- \[x\]/);
  assert.match(h.note(rel), /^status: no_reply_needed$/m);
});

test("L1-3: a retried triage whose note write failed is written on the next poll", async () => {
  const h = harness();
  h.answers.push({ title: "missing fields" });
  h.add(msg({ id: "a1", from: BANK, at: T0 }));
  await h.pipeline.pollOnce();
  const rel = h.store.get("a1")!.notePath;
  assert.match(h.note(rel), /\*\*Triage failed:\*\*/);
  h.vault.failWrites = 1;
  await h.pipeline.retriage("a1").catch(() => undefined);
  assert.equal(h.store.get("a1")!.status, "needs_reply");
  await h.pipeline.pollOnce();
  const note = h.note(rel);
  assert.doesNotMatch(note, /Triage failed|Triage this message by hand/);
  assert.match(note, /\*\*Summary:\*\* S/);
  assert.match(h.taskOf(rel, "a1"), /^- \[ \] Reply \^it-a1$/);
  assert.match(note, /^status: needs_reply$/m);
});

test("L1-3: with Gmail signed out, dashboard choices still reach the note", async () => {
  const h = harness();
  h.add(msg({ id: "a1", from: BANK, at: T0 }));
  await h.pipeline.pollOnce();
  const rel = h.store.get("a1")!.notePath;
  const server = createServer({ cfg: h.cfg, store: h.store, pipeline: null, vault: h.vault, lastPoll: () => null });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/items/a1/status`, {
      method: "POST",
      headers: { "x-inbox-triage": "1", "content-type": "application/json" },
      body: JSON.stringify({ status: "no_reply_needed" }),
    });
    assert.equal(res.status, 200);
    assert.match(h.taskOf(rel, "a1"), /^- \[x\]/);
    assert.match(h.note(rel), /^status: no_reply_needed$/m);
  } finally {
    server.close();
  }
});

test("L1-3: a task you ticked yourself stays ticked when you rate its urgency or an attachment is saved", async () => {
  const h = harness();
  h.add(msg({ id: "a1", from: BANK, at: T0 }));
  await h.pipeline.pollOnce();
  const rel = h.store.get("a1")!.notePath;
  fs.writeFileSync(path.join(h.vaultDir, rel), h.note(rel).replace("- [ ] Reply ^it-a1", "- [x] Reply ^it-a1"));
  h.pipeline.setUserUrgency("a1", "week");
  await h.pipeline.pollOnce();
  assert.match(h.taskOf(rel, "a1"), /^- \[x\]/);
  assert.match(h.note(rel), /^urgency: week$/m);
  // A status change still applies: back from closed, the task is open again.
  h.pipeline.setStatus("a1", "no_reply_needed", "set in dashboard");
  h.pipeline.setStatus("a1", "needs_reply", "set in dashboard");
  assert.match(h.taskOf(rel, "a1"), /^- \[ \]/);
});

// ---------- L1-5 the first start's lookback holds on later polls ----------

test("L1-5: mail older than the first start's lookback is not picked up by the second poll", async () => {
  const h = harness();
  h.add(msg({ id: "0d1d", from: BANK, at: Date.now() - 5 * 86_400_000 }));
  h.add(msg({ id: "0e2e", from: BANK, at: T0 }));
  await h.pipeline.pollOnce();
  await h.pipeline.pollOnce();
  assert.ok(h.store.get("0e2e"));
  assert.equal(h.store.get("0d1d"), null, "five days old at the first start: outside the 3-day lookback");
  const after = h.queries.map((q) => Number(q.match(/after:(\d+)/)?.[1]));
  assert.ok(after.every((a) => a >= Math.floor(Date.now() / 1000) - 3 * 86_400 - 60), h.queries.join("\n"));
});

// ---------- L1-6 the thread's current note follows a status change ----------

test("L1-6: 'Back to the queue' updates the thread's current note after its first note was deleted", async () => {
  const h = harness();
  h.add(msg({ id: "a1", thread: "t", from: BANK, subject: "Documents", at: T0 }));
  await h.pipeline.pollOnce();
  fs.rmSync(path.join(h.vaultDir, h.store.get("a1")!.notePath));
  h.add(msg({ id: "a2", thread: "t", from: BANK, subject: "Re: Documents", at: T0 + HOUR }));
  h.sent("t", T0 + 2 * HOUR, ["marija@bank.example"]);
  await h.pipeline.pollOnce();
  const rel = h.store.get("a2")!.notePath;
  assert.match(h.note(rel), /^status: replied$/m);
  h.pipeline.setStatus("a1", "needs_reply", "set in dashboard");
  assert.match(h.note(rel), /^status: needs_reply$/m);
});

// ---------- L1-7 filing the same message twice adds it once ----------

test("L1-7: a database error just after the note write does not add the message twice", async () => {
  const h = harness();
  const setNotePath = h.store.setNotePath.bind(h.store);
  let fail = 1;
  h.store.setNotePath = (id: string, p: string) => {
    if (fail-- > 0) throw new Error("database is locked");
    setNotePath(id, p);
  };
  h.add(msg({ id: "a1", from: BANK, at: T0 }));
  await h.pipeline.pollOnce();
  await h.pipeline.pollOnce();
  const note = h.note(h.store.get("a1")!.notePath);
  assert.equal(note.match(/\^it-a1/g)?.length, 1);
  assert.equal(note.match(/^## /gm)?.length, 1);
  const copies = fs.readdirSync(path.join(h.vaultDir, "Projects/Croatia bank and advisors")).filter((f) => f.endsWith(".md"));
  assert.equal(copies.length, 1, `one note, not ${copies.join(", ")}`);
});

// ---------- L1-8 one triage at a time per message ----------

test("L1-8: 'Retry triage' while the poll is triaging the same message calls Claude once", async () => {
  const h = harness();
  h.answers.push(ok({ needs_reply: false, task: "" }));
  h.add(msg({ id: "a1", from: BANK, at: T0 }));
  const release = h.holdClaude();
  const poll = h.pipeline.pollOnce();
  await until(() => h.calls() === 1);
  const retry = h.pipeline.retriage("a1");
  await new Promise((r) => setTimeout(r, 20));
  release();
  await Promise.all([poll, retry]);
  assert.equal(h.calls(), 1);
  const item = h.store.get("a1")!;
  assert.equal(item.status, "no_reply_needed");
  assert.equal(item.triage?.needs_reply, false);
});

// ---------- L1-10 items that keep failing don't block the rest ----------

test("L1-10: ten items that keep failing to file don't stop a later one being filed", async () => {
  const h = harness();
  // Ten older letters in the Swedish matter, then one from the bank.
  for (let i = 0; i < 10; i++) h.add(msg({ id: `d${String(i).padStart(2, "0")}`, from: "Elin Holm <elin@lawfirm.example>", subject: `Letter ${i}`, at: T0 + i * 60_000 }));
  h.add(msg({ id: "d10", from: BANK, subject: "Statement", at: T0 + HOUR }));
  h.vault.failWrites = 999;
  await h.pipeline.pollOnce();
  h.vault.failWrites = 0;
  // The Swedish matter's folder can't be written, for good: a file sits where the folder should be.
  fs.mkdirSync(path.join(h.vaultDir, "Projects"), { recursive: true });
  fs.writeFileSync(path.join(h.vaultDir, "Projects/Sweden legal matter"), "not a folder");
  const r = await h.pipeline.pollOnce();
  assert.ok(r.failed > 0);
  await h.pipeline.pollOnce();
  assert.ok(h.store.get("d10")!.notePath, "the bank letter is filed");
});

test("L1-10: a message deleted in Gmail before its note was written is filed from what was stored", async () => {
  const h = harness();
  h.add(msg({ id: "a1", from: BANK, body: "Please send the signed form.", at: T0 }));
  h.vault.failWrites = 99;
  await h.pipeline.pollOnce();
  h.vault.failWrites = 0;
  h.gone.add("a1");
  const r = await h.pipeline.pollOnce();
  assert.equal(r.failed, 0);
  const item = h.store.get("a1")!;
  assert.equal(item.status, "needs_reply");
  assert.match(h.note(item.notePath), /Please send the signed form\./);
});

test("L1-10: a message deleted before Claude read it is filed with its text, as not triaged", async () => {
  const h = harness();
  const now = new Date(T0).toISOString();
  const pending: Item = {
    id: "a2", channel: "gmail", threadId: "a2", projectId: "croatia-bank", role: "bank", fromName: "Marija", fromEmail: "marija@bank.example",
    to: ["me@example.com"], cc: [], subject: "Form", receivedAt: now, body: "Sign the form.", fullText: "Sign the form.", onlyCc: false, senderVerified: true,
    replyToName: "Marija", replyToEmail: "marija@bank.example", replyRedirected: false, replyLanguage: "", link: "https://mail.google.com/mail/u/0/#all/a2",
    attachments: [], notePath: "", status: "pending_triage", triage: null, triageError: "", draft: null, userUrgency: null, reopenedAt: null, createdAt: now, updatedAt: now,
  };
  // Stored, then the service stopped before Claude answered; the message was deleted meanwhile.
  h.store.insert(pending);
  h.gone.add("a2");
  const r = await h.pipeline.pollOnce();
  assert.equal(r.failed, 0);
  const item = h.store.get("a2")!;
  assert.equal(item.status, "triage_failed");
  assert.equal(h.calls(), 0);
  const note = h.note(item.notePath);
  assert.match(note, /Sign the form\./);
  assert.match(note, /deleted in Gmail before Claude read it/);
  // Retry triage says the same instead of failing.
  const again = await h.pipeline.retriage("a2");
  assert.match(again!.triageError, /deleted in Gmail/);
});

// ---------- L1-11 retried filing keeps date order ----------

test("L1-11: a message filed late sits above a newer one in the note", async () => {
  const h = harness();
  h.add(msg({ id: "a1", thread: "t", from: BANK, subject: "Loan", at: T0 }));
  h.vault.failWrites = 99;
  await h.pipeline.pollOnce();
  h.vault.failWrites = 0;
  h.add(msg({ id: "a2", thread: "t", from: BANK, subject: "Re: Loan", at: T0 + HOUR }));
  await h.pipeline.pollOnce();
  const note = h.note(h.store.get("a2")!.notePath);
  assert.ok(note.indexOf("^it-a1") < note.indexOf("^it-a2"));
});

test("L1-11: two messages in the same minute keep their order when the first is filed late", async () => {
  const h = harness();
  const minute = Math.floor(T0 / 60_000) * 60_000;
  h.add(msg({ id: "b1", thread: "t", from: BANK, subject: "Loan", at: minute + 5_000 }));
  h.add(msg({ id: "b2", thread: "t", from: BANK, subject: "Re: Loan", at: minute + 40_000 }));
  // The first write (b1's note) fails; b2 is filed in the same poll, b1 on the next.
  h.vault.failWrites = 1;
  await h.pipeline.pollOnce();
  await h.pipeline.pollOnce();
  const note = h.note(h.store.get("b2")!.notePath);
  assert.ok(note.indexOf("^it-b1") > 0 && note.indexOf("^it-b1") < note.indexOf("^it-b2"), note);
});

// ---------- L1-12 an id listed twice ----------

test("L1-12: an id Gmail lists twice is filed once and is not a failure", async () => {
  const h = harness();
  h.listTwice();
  h.add(msg({ id: "a1", from: BANK, at: T0 }));
  const r = await h.pipeline.pollOnce();
  assert.equal(r.failed, 0);
  assert.equal(r.ingested, 1);
});

// ---------- L1-13 the frontmatter describes the item that needs you ----------

test("L1-13: after a court letter and a harmless follow-up, the note's frontmatter still points at the court letter", async () => {
  const h = harness();
  h.answers.push(ok({ urgency: "urgent", urgency_score: 90 }), ok({ needs_reply: false, task: "", urgency: "fyi", urgency_score: 5 }));
  h.add(msg({ id: "c1", thread: "t", from: "Registry <registry@court.example>", subject: "Föreläggande", at: T0 }));
  h.add(msg({ id: "e1", thread: "t", from: "Elin Holm <elin@lawfirm.example>", subject: "Re: Föreläggande", at: T0 + HOUR }));
  await h.pipeline.pollOnce();
  const court = h.store.get("c1")!;
  const note = h.note(court.notePath);
  assert.match(note, /^status: needs_reply$/m);
  assert.match(note, /^urgency: urgent$/m);
  assert.match(note, /^review_required: true$/m);
  assert.match(note, /^from: .*registry@court\.example/m);
  assert.ok(note.includes(`gmail: ${JSON.stringify(court.link)}`) || note.includes(`gmail: ${court.link}`));
});
