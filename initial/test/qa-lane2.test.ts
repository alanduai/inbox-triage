import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { parseConfig } from "../src/config.js";
import type { GmailReader } from "../src/gmail/client.js";
import { htmlToText, parseMessage, stripQuoted, type ParsedMessage } from "../src/gmail/parse.js";
import { escapeMd } from "../src/obsidian/note.js";
import { noteRelPath, VaultWriter } from "../src/obsidian/writer.js";
import { Pipeline } from "../src/pipeline.js";
import { replyRoute, matchContact } from "../src/scope.js";
import { createServer } from "../src/server/server.js";
import { Store } from "../src/store/db.js";
import { finalize } from "../src/triage/claude.js";
import type { ModelTriage } from "../src/triage/schema.js";
import { safeFileName } from "../src/util/files.js";
import { b64url, tempDir, testConfig } from "./helpers.js";

// ---------- a small harness: fake Gmail and Claude around the real pipeline ----------

type Meta = { id: string; internalDate: Date; labelIds: string[]; fromEmail: string; recipients: string[] };
function msg(o: { id: string; thread?: string; from: string; to?: string; cc?: string; subject?: string; body: string; at: number; replyTo?: string; attach?: boolean }): ParsedMessage {
  return parseMessage({
    id: o.id,
    threadId: o.thread ?? o.id,
    internalDate: String(o.at),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: o.from },
        { name: "To", value: o.to ?? "me@example.com" },
        { name: "Cc", value: o.cc ?? "" },
        { name: "Subject", value: o.subject ?? "Subject" },
        ...(o.replyTo ? [{ name: "Reply-To", value: o.replyTo }] : []),
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64url(o.body) } },
        ...(o.attach ? [{ mimeType: "application/pdf", filename: "Dom T 1234-26.pdf", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { attachmentId: "a", size: 5 } }] : []),
      ],
    },
  });
}

const ok = (o: Partial<ModelTriage> = {}): ModelTriage => ({
  title: "T", summary: "S", needs_reply: true, urgency: "today", urgency_score: 60, urgency_reason: "R", task: "Reply", due_date: "", reply_by: "",
  message_language: "en", suggested_reply: "Hi", draft_assumption: "", ack_reply: "Received.", ...o,
});

function harness(cfgOverrides: Record<string, unknown> = {}, store = new Store(":memory:")) {
  const vaultDir = (cfgOverrides.vault as { path: string } | undefined)?.path ?? tempDir("vault-");
  const cfg = testConfig({ vault: { path: vaultDir }, ...cfgOverrides });
  const msgs = new Map<string, ParsedMessage>();
  const meta: Meta[] = [];
  let attachmentFails = 0;
  const prompts: string[] = [];
  const gmail = {
    listIds: async () => ({ ids: [...msgs.keys()], truncated: false }),
    message: async (id: string) => msgs.get(id)!,
    thread: async (id: string) => [...msgs.values()].filter((m) => m.threadId === id),
    threadMeta: async (id: string) => [
      ...[...msgs.values()].filter((m) => m.threadId === id).map((m) => ({ id: m.id, internalDate: m.internalDate, labelIds: m.labelIds, fromEmail: m.from.email, recipients: [] })),
      ...meta.filter((m) => m.id.startsWith(id + ":")),
    ],
    attachment: async () => {
      if (attachmentFails > 0) {
        attachmentFails--;
        throw new Error("socket hang up");
      }
      return Buffer.from("%PDF");
    },
  };
  const answers: ModelTriage[] = [];
  const claude = {
    beta: {
      messages: {
        create: async (p: { messages: { content: string }[] }) => {
          prompts.push(p.messages[0]!.content);
          return { model: "m", stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify(answers.shift() ?? ok()) }] };
        },
      },
    },
  };
  const pipeline = new Pipeline(cfg, store, gmail as unknown as GmailReader, claude as unknown as Anthropic, new VaultWriter(vaultDir, 1e6, path.join(vaultDir, "..", "large")));
  return {
    cfg, store, msgs, pipeline, vaultDir, prompts, answers,
    add: (m: ParsedMessage) => msgs.set(m.id, m),
    sent: (thread: string, at: number, recipients: string[]) => meta.push({ id: `${thread}:sent${meta.length}`, internalDate: new Date(at), labelIds: ["SENT"], fromEmail: "me@example.com", recipients }),
    failAttachments: (n: number) => (attachmentFails = n),
    note: (rel: string) => fs.readFileSync(path.join(vaultDir, rel), "utf8"),
  };
}
const T0 = Date.UTC(2026, 9, 23, 8, 0);

// ---------- L2-1 quoted and forwarded text ----------

test("L2-1: forwards keep their content, and ordinary sentences are not mistaken for quote headers", () => {
  const fwd = "Please see the court's decision below.\n\n---------- Forwarded message ---------\nFrom: Tingsrätten <registry@court.example>\nDate: Thu, 22 Oct 2026\nSubject: Beslut\nTo: Elin <elin@lawfirm.example>\n\n…att yttra sig senast den 6 november 2026.";
  assert.equal(stripQuoted(fwd), fwd);
  const vb = "Se nedan.\n\nFrån: Tingsrätten <registry@court.example>\nSkickat: den 22 oktober 2026\nTill: Elin\nÄmne: Beslut\n\nYttrande senast 6 november.";
  assert.equal(stripQuoted(vb, "VB: Beslut"), vb);
  for (const t of [
    "Poštovani,\nkao što sam napisao u prošlom mailu, trebamo sljedeće:\n- izjava\n- osobna iskaznica\nRok: 30. 10. 2026.",
    "Hej Alan,\nDen 12 november skrev domstolen följande:\nYttrande senast 6 november.",
    "Hi Alan,\nOn Monday the court wrote:\nThe hearing is moved.",
    "Izvadak\nOd: 01.10.2026.\nDo: 31.10.2026.\nDatum: 01.11.2026.\nStanje: 1.000,00",
  ]) {
    assert.equal(stripQuoted(t), t);
  }
  // Inline answers under a quote: everything is the message.
  const inline = "See my answers.\n\nOn Mon, 19 Oct 2026 at 10:00, Elin <elin@lawfirm.example> wrote:\n> Date of transfer?\n12 March.\n> Which accounts?\nBoth.";
  assert.equal(stripQuoted(inline), inline);
  // A real quote is still dropped.
  assert.equal(stripQuoted("Thanks.\n\nOn Mon, 19 Oct 2026 at 10:00, Elin <elin@lawfirm.example> wrote:\n> old"), "Thanks.");
});

test("L2-1: quoted or forwarded text reaches Claude and sits folded in the note", async () => {
  const h = harness();
  h.add(msg({ id: "1a", from: "Elin <elin@lawfirm.example>", body: "Thanks, see below.\n\nOn Mon, 19 Oct 2026 at 10:00, Registry <registry@court.example> wrote:\n> Yttrande senast den 6 november 2026.", at: T0 }));
  await h.pipeline.pollOnce();
  assert.match(h.prompts[0]!, /<quoted>\nOn Mon, 19 Oct 2026 at 10:00, Registry <registry@court.example> wrote:\n> Yttrande senast den 6 november 2026\.\n<\/quoted>/);
  const item = h.store.get("1a")!;
  assert.equal(item.body, "Thanks, see below.");
  assert.match(h.note(item.notePath), /> \[!quote\]- Quoted or forwarded text\n> On Mon, 19 Oct 2026 at 10:00, Registry &lt;registry@court\.example> wrote:\n> \\> Yttrande senast den 6 november 2026\./);
});

// ---------- L2-2 and L2-11 dates and times ----------

test("L2-2/L2-11: deadlines are stored as real instants, impossible dates are dropped, variants normalised", () => {
  const f = (reply_by: string, due_date = "") => finalize(ok({ reply_by, due_date }), { reviewRequired: false, alwaysUrgent: false, signOff: "x", model: "m", tz: "Europe/Zagreb" });
  assert.equal(f("2026-10-26T10:00").reply_by_utc, "2026-10-26T09:00:00.000Z");
  // 02:30 on 25 October happens twice in Zagreb: the earlier one is the deadline.
  assert.equal(f("2026-10-25T02:30").reply_by_utc, "2026-10-25T00:30:00.000Z");
  assert.equal(f("2026-10-26T10:00:00").reply_by, "2026-10-26T10:00");
  assert.equal(f("2026-10-26T09:00Z").reply_by, "2026-10-26T10:00");
  for (const bad of ["2026-02-30T10:00", "2026-10-26T24:00", "2026-10-26T25:99", "0000-00-00T00:00"]) assert.equal(f(bad).reply_by, "", bad);
  assert.equal(f("", "2026-02-30").due_date, "");
  assert.equal(f("", "2026-10-30").due_date, "2026-10-30");
});

// ---------- L2-3 Markdown that renders as written ----------

test("L2-3: Croatian dates, emphasis and entities render as written", () => {
  assert.equal(escapeMd("30. 10. 2026. pripremno ročište"), "30\\. 10. 2026. pripremno ročište");
  assert.equal(escapeMd("- item\n+ item\n> quote\n---"), "\\- item\n\\+ item\n\\> quote\n\\---");
  assert.equal(escapeMd("*1234* _x_ ~~y~~ ==z== $5 a|b &copy;"), "\\*1234\\* \\_x\\_ \\~\\~y\\~\\~ \\=\\=z\\=\\= \\$5 a\\|b &amp;copy;");
});

// ---------- L2-4 one thread, two matters ----------

test("L2-4: a thread involving both matters gets a note in each, and the matter never flips", async () => {
  const h = harness();
  h.add(msg({ id: "4a", thread: "t4", from: "Elin <elin@lawfirm.example>", subject: "Documents for the bank", body: "a", at: T0 }));
  h.add(msg({ id: "4b", thread: "t4", from: "Marija <marija@bank.example>", subject: "Re: Documents for the bank", body: "b", at: T0 + 60_000 }));
  h.add(msg({ id: "4c", thread: "t4", from: "Elin <elin@lawfirm.example>", subject: "Re: Documents for the bank", body: "c", at: T0 + 120_000 }));
  await h.pipeline.pollOnce();
  const [a, b, c] = ["4a", "4b", "4c"].map((id) => h.store.get(id)!);
  assert.equal(a!.notePath, c!.notePath);
  assert.notEqual(a!.notePath, b!.notePath);
  assert.ok(b!.notePath.startsWith("Projects/Croatia bank and advisors/"));
  assert.match(h.note(a!.notePath), /project: Sweden — legal matter/);
  assert.match(h.note(b!.notePath), /project: Croatia — bank & advisors/);
});

// ---------- L2-5 court rules and Reply-To ----------

test("L2-5: the court and the other side never get a quick acknowledgement, whatever the flags", async () => {
  const h = harness({
    projects: [
      {
        id: "sweden-legal", name: "Sweden — legal matter", folder: "Projects/Sweden legal matter",
        counsel: { name: "Elin Holm", email: "elin@lawfirm.example", language: "en" },
        contacts: [{ match: "@court.example", role: "court", reviewRequired: true }, { match: "clerk@court.example", role: "court", alwaysUrgent: true }, { match: "@otherside.example", role: "opposing_counsel" }],
      },
    ],
  });
  h.add(msg({ id: "5a", from: "Clerk <clerk@court.example>", body: "x", at: T0 }));
  h.add(msg({ id: "5b", from: "Lawyer <l@otherside.example>", body: "y", at: T0 + 1 }));
  await h.pipeline.pollOnce();
  for (const id of ["5a", "5b"]) {
    const t = h.store.get(id)!.triage!;
    assert.equal(t.ack_reply, "", id);
    assert.equal(t.review_required, true, id);
  }
});

test("L2-5: Reply-To on the sender's own domain is used; one elsewhere is ignored", () => {
  const cfg = testConfig();
  const m = matchContact(cfg, "noreply@bank.example")!;
  assert.equal(replyRoute(m, { name: "Bank", email: "noreply@bank.example" }, [{ name: "Marija", email: "marija@bank.example" }]).email, "marija@bank.example");
  assert.equal(replyRoute(m, { name: "Bank", email: "noreply@bank.example" }, [{ name: "X", email: "x@evil.example" }]).email, "noreply@bank.example");
});

test("L2-5/L2-9: config rejects bare domains, a sender in two matters, and court contacts without your lawyer", () => {
  const base = () => JSON.parse(JSON.stringify(testConfig()));
  const c1 = base();
  c1.projects[1].contacts[0].match = "bank.example";
  assert.throws(() => parseConfig(c1, "/tmp/c.json"), /domain starting with "@"/);
  const c2 = base();
  c2.projects[1].contacts.push({ match: "@court.example", role: "bank" });
  assert.throws(() => parseConfig(c2, "/tmp/c.json"), /listed in both/);
  const c3 = base();
  delete c3.projects[0].counsel;
  assert.throws(() => parseConfig(c3, "/tmp/c.json"), /no "counsel"/);
});

// ---------- L2-6 attachments retried ----------

test("L2-6: an attachment that fails to download is listed and saved on a later poll", async () => {
  const h = harness();
  // Fails on the first download and on the retry in the same poll; works on the next poll.
  h.failAttachments(2);
  h.add(msg({ id: "6a", from: "Elin <elin@lawfirm.example>", body: "Decision attached.", at: T0, attach: true }));
  await h.pipeline.pollOnce();
  let item = h.store.get("6a")!;
  assert.equal(item.attachments[0]!.saved, false);
  assert.match(h.note(item.notePath), /Dom T 1234-26\.pdf \(0\.0 MB\): not saved yet/);
  await h.pipeline.pollOnce();
  item = h.store.get("6a")!;
  assert.equal(item.attachments[0]!.saved, true);
  const note = h.note(item.notePath);
  assert.doesNotMatch(note, /not saved yet/);
  assert.match(note, /\[\[Projects\/Sweden legal matter\/attachments\/2026-10-23 Dom T 1234-26\.pdf\|Dom T 1234-26\.pdf\]\]/);
});

// ---------- L2-7 forwards do not close ----------

test("L2-7: forwarding a message to someone else does not close it; replying to the sender does", async () => {
  const h = harness();
  h.add(msg({ id: "7a", thread: "t7", from: "Marija <marija@bank.example>", body: "Please sign by Friday.", at: T0 }));
  await h.pipeline.pollOnce();
  h.sent("t7", T0 + 600_000, ["advisor@advisor.example"]);
  assert.equal((await h.pipeline.pollOnce()).closedByReply, 0);
  h.sent("t7", T0 + 900_000, ["marija@bank.example"]);
  assert.equal((await h.pipeline.pollOnce()).closedByReply, 1);
});

// ---------- L2-8 renamed notes ----------

test("L2-8: a note you renamed in Obsidian keeps receiving the thread", async () => {
  const h = harness();
  h.add(msg({ id: "8a", thread: "t8", from: "Marija <marija@bank.example>", subject: "Dokumenti", body: "first", at: T0 }));
  await h.pipeline.pollOnce();
  const old = h.store.get("8a")!.notePath;
  const renamed = "Projects/Croatia bank and advisors/Bank documents (my title).md";
  fs.renameSync(path.join(h.vaultDir, old), path.join(h.vaultDir, renamed));
  h.add(msg({ id: "8b", thread: "t8", from: "Marija <marija@bank.example>", subject: "Re: Dokumenti", body: "reminder", at: T0 + 3_600_000 }));
  await h.pipeline.pollOnce();
  assert.equal(h.store.get("8b")!.notePath, renamed);
  assert.equal(h.store.get("8a")!.notePath, renamed);
  assert.match(h.note(renamed), /reminder/);
  assert.ok(!fs.existsSync(path.join(h.vaultDir, old)));
});

// ---------- L2-9 skipped mail looked at again after a rule change ----------

test("L2-9: mail skipped for lack of a rule is checked again once the rules change", async () => {
  const store = new Store(":memory:");
  const vaultDir = tempDir("vault-");
  const noBank = { vault: { path: vaultDir }, projects: [JSON.parse(JSON.stringify(testConfig().projects[0]))] };
  const h1 = harness(noBank, store);
  h1.add(msg({ id: "9a", from: "Marija <marija@other-bank.example>", body: "x", at: T0 }));
  await h1.pipeline.pollOnce();
  assert.ok(store.isSkipped("9a"));
  const withBank = JSON.parse(JSON.stringify(testConfig()));
  withBank.projects[1].contacts.push({ match: "@other-bank.example", role: "bank" });
  const h2 = harness({ vault: { path: vaultDir }, projects: withBank.projects }, store);
  h2.add(h1.msgs.get("9a")!);
  await h2.pipeline.pollOnce();
  assert.equal(store.get("9a")?.projectId, "croatia-bank");
});

// ---------- L2-10 thread note fields and order ----------

test("L2-10: the note's review flag follows the lead item, identity follows the newest, and late older mail sorts in", async () => {
  const h = harness();
  h.answers.push(ok({ urgency: "urgent", urgency_score: 90 }), ok({ needs_reply: false, task: "", urgency: "fyi", suggested_reply: "", ack_reply: "" }));
  h.add(msg({ id: "10a", thread: "t10", from: "Registry <registry@court.example>", subject: "Kallelse", body: "court", at: T0 }));
  h.add(msg({ id: "10b", thread: "t10", from: "Elin <elin@lawfirm.example>", subject: "Re: Kallelse", body: "fyi", at: T0 + 60_000 }));
  await h.pipeline.pollOnce();
  let note = h.note(h.store.get("10a")!.notePath);
  assert.match(note, /review_required: true/);
  assert.match(note, /urgency: urgent/);
  assert.match(note, /from: "Elin <elin@lawfirm.example>"/);
  // An older message found later goes before the newer section, and the identity stays with the newest.
  h.add(msg({ id: "10c", thread: "t10", from: "Registry <registry@court.example>", subject: "Kallelse", body: "older", at: T0 - 3_600_000 }));
  await h.pipeline.pollOnce();
  note = h.note(h.store.get("10a")!.notePath);
  assert.ok(note.indexOf("older") < note.indexOf("> court"));
  assert.match(note, /from: "Elin <elin@lawfirm.example>"/);
});

// ---------- L2-12 HTML text ----------

test("L2-12: named entities, table cells and a blank plain part", () => {
  assert.equal(htmlToText("F&ouml;rel&auml;ggande &ndash; 5 &euro; Po&scaron;tovani &bdquo;hitno&ldquo; &amp;lt;"), "Föreläggande – 5 € Poštovani „hitno“ &lt;");
  assert.equal(htmlToText("<table><tr><td>Rok za odgovor</td><td>30.10.2026.</td></tr></table>"), "Rok za odgovor 30.10.2026.");
  const m = parseMessage({
    id: "12", threadId: "12", internalDate: "0",
    payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: "a@bank.example" }], parts: [{ mimeType: "text/plain", body: { data: b64url(" \r\n") } }, { mimeType: "text/html", body: { data: b64url("<p>Molimo dokumente.</p>") } }] },
  });
  assert.equal(m.text, "Molimo dokumente.");
});

// ---------- L2-13 file names ----------

test("L2-13: file names fit macOS limits, never split a character, and drop VB:", () => {
  const cjk = "決定".repeat(200);
  const rel = noteRelPath("Projects/X", "2026-10-23T10:00", cjk);
  assert.ok(Buffer.byteLength(path.basename(rel)) <= 255);
  const emoji = safeFileName("a".repeat(179) + "😀😀", 180);
  assert.ok(!emoji.includes("\ufffd"));
  assert.equal(emoji, "a".repeat(179));
  assert.equal(noteRelPath("P", "2026-10-23T10:00", "VB: Kallelse"), "P/2026-10-23 Kallelse.md");
});

// ---------- L2-14 oldest unanswered ----------

test("L2-14: oldest unanswered counts messages that could not be triaged", async () => {
  const store = new Store(":memory:");
  const base = { channel: "gmail" as const, projectId: "croatia-bank", role: "bank" as const, fromName: "", fromEmail: "a@bank.example", to: [], cc: [], subject: "s", body: "", fullText: "", onlyCc: false, senderVerified: true, replyToName: "", replyToEmail: "", replyRedirected: false, replyLanguage: "", link: "", attachments: [], notePath: "x", triage: null, triageError: "", draft: null, userUrgency: null, reopenedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.insert({ ...base, id: "14a", threadId: "14a", receivedAt: new Date(Date.now() - 50 * 3_600_000).toISOString(), status: "triage_failed" });
  store.insert({ ...base, id: "14b", threadId: "14b", receivedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), status: "needs_reply" });
  const server = createServer({ cfg: testConfig(), store, pipeline: null, vault: new VaultWriter(tempDir("v-"), 1e6, tempDir("l-")), lastPoll: () => null });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const s = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/summary`)).json()) as { oldestUnansweredHours: number; tz: string };
    assert.equal(s.oldestUnansweredHours, 50);
    assert.equal(s.tz, "Europe/Zagreb");
  } finally {
    server.close();
  }
});

// ---------- L2-15 future-dated mail ----------

test("L2-15: a message dated in the future does not push the checkpoint past now", async () => {
  const h = harness();
  h.add(msg({ id: "15a", from: "Marija <marija@bank.example>", body: "x", at: Date.UTC(2027, 5, 1) }));
  await h.pipeline.pollOnce();
  assert.ok(Number(h.store.getState("gmail.lastSeenEpoch")) <= Math.floor(Date.now() / 1000));
});
