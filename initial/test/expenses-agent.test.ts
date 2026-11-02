import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { claudeBrain, ExpenseAgent } from "../src/expenses/agent.js";
import { RunStore } from "../src/expenses/runs.js";
import type { Notice } from "../src/expenses/notify.js";
import type { PortalFetcher, PortalResult, PortalTask, Renderer } from "../src/expenses/types.js";
import { decodeWords, expensesConfig, fakeClaude, FakeMailbox, parseMime, PDF, userText } from "./expenses-helpers.js";

const NOW = Date.UTC(2026, 10, 2, 9, 0);
const IVANA = "Ivana Nikolić <ivana@racunovodstvo.example>";
const REQUEST_TEXT = `Bok Alane,

za listopad mi nedostaju računi za sljedeće troškove s izvoda:

03.10. GRANOLA.AI 14,00 USD
05.10. NOTION LABS 10,00 USD
07.10. WISPRFLOW.AI 12,00 USD
12.10. CLAUDE.AI SUBSCRIPTION 18,00 EUR
20.10. OPENAI *CHATGPT SUBSCR 18,47 EUR
23.10. AMZN Mktp DE 45,99 EUR

Hvala,
Ivana`;

const EXTRACTED = {
  is_receipt_request: true,
  period: "2026-10",
  expenses: [
    { vendor: "GRANOLA.AI", description: "Granola subscription", date: "2026-10-03", amount: "14.00", currency: "USD", source_text: "03.10. GRANOLA.AI 14,00 USD" },
    { vendor: "NOTION LABS", description: "Notion subscription", date: "2026-10-05", amount: "10.00", currency: "USD", source_text: "05.10. NOTION LABS 10,00 USD" },
    { vendor: "WISPRFLOW.AI", description: "Wispr Flow subscription", date: "2026-10-07", amount: "12.00", currency: "USD", source_text: "07.10. WISPRFLOW.AI 12,00 USD" },
    { vendor: "CLAUDE.AI SUBSCRIPTION", description: "Claude subscription", date: "2026-10-12", amount: "18.00", currency: "EUR", source_text: "12.10. CLAUDE.AI SUBSCRIPTION 18,00 EUR" },
    { vendor: "OPENAI *CHATGPT SUBSCR", description: "ChatGPT subscription", date: "2026-10-20", amount: "18.47", currency: "EUR", source_text: "20.10. OPENAI *CHATGPT SUBSCR 18,47 EUR" },
    { vendor: "AMZN Mktp DE", description: "Amazon order", date: "2026-10-23", amount: "45.99", currency: "EUR", source_text: "23.10. AMZN Mktp DE 45,99 EUR" },
  ],
  other_requests: "",
};

/**
 * Stands in for Claude's receipt match: picks the receipt email with the same amount, else the
 * first receipt email, and reads the total from its text. It sees only what the agent sends.
 */
function fakeChoose(params: Anthropic.Beta.MessageCreateParamsNonStreaming) {
  const t = userText(params);
  const exp = t.match(/<expense vendor="([^"]*)" known_vendor="([^"]*)" date="([^"]*)" amount="([^"]*)" currency="([^"]*)"/)!;
  const emails = [...t.matchAll(/<email id="([^"]+)" from="([^"]*)" date="([^"]*)" subject="([^"]*)" attachments="([^"]*)">\n([\s\S]*?)\n<\/email>/g)].map((m) => ({
    id: m[1]!,
    subject: m[4]!,
    files: m[5] === "none" ? [] : m[5]!.split("; ").map((f) => f.replace(/ \([^)]*\)$/, "")),
    text: m[6]!,
  }));
  const receipts = emails.filter((e) => /receipt|invoice|rechnung|račun/i.test(e.subject));
  const byAmount = exp[4] !== "not given" ? receipts.find((e) => e.text.includes(exp[4]!)) : undefined;
  const pick = byAmount ?? receipts[0];
  if (!pick) return { candidate_id: "", attachments: [], receipt_amount: "", receipt_currency: "", receipt_date: "", invoice_number: "", confidence: "low", reason: "No receipt among them." };
  const amount = pick.text.match(/[$€](\d+\.\d\d)/)?.[1] ?? "";
  return { candidate_id: pick.id, attachments: pick.files, receipt_amount: amount, receipt_currency: pick.text.includes("€") ? "EUR" : "USD", receipt_date: "", invoice_number: "", confidence: byAmount ? "high" : "medium", reason: "Vendor and date match." };
}

class FakePortals implements PortalFetcher {
  tasks: PortalTask[] = [];
  closed = 0;
  constructor(private readonly outcomes: Record<string, PortalResult["status"]>) {}
  async fetch(task: PortalTask): Promise<PortalResult> {
    this.tasks.push(task);
    const o = this.outcomes[task.portal] ?? "not_found";
    const none = { files: [], url: "", invoiceNumber: "", invoiceDate: "", amount: null, currency: "", steps: 1 };
    if (o !== "found") return { ...none, status: o, note: o === "login_required" ? "The sign-in page opened." : "No such invoice." };
    fs.mkdirSync(task.stagingDir, { recursive: true });
    const p = path.join(task.stagingDir, `${task.portal}.pdf`);
    fs.writeFileSync(p, PDF(task.portal));
    return { status: "found", files: [{ path: p, filename: "Invoice-2026-10.pdf" }], url: "https://invoice.stripe.com/i/acct_1/live_1", invoiceNumber: "A-1", invoiceDate: "2026-10-12", amount: 20, currency: "USD", note: "Downloaded the invoice.", steps: 5 };
  }
  async close() {
    this.closed++;
  }
}

class FakeRenderer implements Renderer {
  html: string[] = [];
  async htmlToPdf(html: string) {
    this.html.push(html);
    return PDF(`rendered ${this.html.length}`);
  }
  async close() {}
}

function harness(opts: { outcomes?: Record<string, PortalResult["status"]>; extract?: (p: Anthropic.Beta.MessageCreateParamsNonStreaming) => Record<string, unknown> | Error; overrides?: Record<string, unknown> } = {}) {
  const cfg = expensesConfig(opts.overrides);
  const mailbox = new FakeMailbox();
  const claude = fakeClaude({ extract: opts.extract ?? (() => EXTRACTED), choose: fakeChoose });
  const portals = new FakePortals(opts.outcomes ?? { claude: "found", amazon: "login_required" });
  const renderer = new FakeRenderer();
  const notices: Notice[] = [];
  const runs = new RunStore(path.join(cfg.dataDirAbs, "expenses", "runs"));
  let clock = NOW;
  const agent = () =>
    new ExpenseAgent({
      cfg,
      mailbox,
      brain: claudeBrain(claude.client, cfg, cfg.expenses!.company),
      portals,
      renderer,
      runs,
      notify: async (n) => {
        notices.push(n);
        return ["test"];
      },
      stagingRoot: path.join(cfg.dataDirAbs, "expenses", "staging"),
      now: () => new Date((clock += 1000)),
    });
  const folder = path.join(cfg.expenses!.receiptsDir, "2026", "10 October");
  const files = () => (fs.existsSync(folder) ? fs.readdirSync(folder).sort() : []);
  return { cfg, mailbox, claude, portals, renderer, notices, runs, agent, folder, files };
}

function addMonth(h: ReturnType<typeof harness>) {
  const req = h.mailbox.addMail({ from: IVANA, subject: "Računi za listopad 2026", text: REQUEST_TEXT, at: Date.UTC(2026, 10, 2, 7, 30), references: "<root-1@racunovodstvo.example>" });
  // An older request she sent for September, already answered.
  h.mailbox.addMail({ from: IVANA, subject: "Računi za rujan", text: "Bok, fali mi račun za Notion iz rujna.", at: Date.UTC(2026, 9, 1, 8) });
  // Last month's reply to her, with attachments that mention the same vendors: never a receipt.
  h.mailbox.addMail({ from: "Alan <me@example.com>", to: IVANA, subject: "Re: Računi za rujan", text: "Granola receipt attached, Notion receipt $10.00", at: Date.UTC(2026, 9, 4, 9), labels: ["SENT"], attachments: [{ filename: "01 2026-09-03 Granola 14.00 USD.pdf", data: PDF("old") }] });
  h.mailbox.addMail({ from: "Granola <billing@granola.ai>", subject: "Your Granola receipt #GR-1", text: "Thanks! Amount paid $14.00 on October 3, 2026.", at: Date.UTC(2026, 9, 3, 9), attachments: [{ filename: "Invoice-GR-1.pdf", data: PDF("granola invoice") }, { filename: "Receipt-GR-1.pdf", data: PDF("granola receipt") }] });
  h.mailbox.addMail({ from: "Notion <team@mail.notion.so>", subject: "What's new in Notion", text: "New features this month.", at: Date.UTC(2026, 9, 2, 9) });
  const notion = h.mailbox.addMail({ from: "Notion <billing@mail.notion.so>", subject: "Your receipt from Notion Labs, Inc.", text: "Amount paid $10.00", at: Date.UTC(2026, 9, 5, 6), attachments: [{ filename: "Invoice-NO-7.pdf", data: PDF("notion invoice") }] });
  h.mailbox.addMail({ from: "Wispr Flow <receipts@wisprflow.ai>", subject: "Receipt for your Wispr Flow subscription", html: "<h1>Wispr Flow</h1><p>Total $12.00</p><img src='https://track.example/p.gif'>", at: Date.UTC(2026, 9, 7, 10) });
  h.mailbox.addMail({ from: "OpenAI <noreply@tm.openai.com>", subject: "Your ChatGPT Plus receipt", text: "ChatGPT Plus subscription. Total $20.00", at: Date.UTC(2026, 9, 19, 22), attachments: [{ filename: "Receipt-2026-10.pdf", data: PDF("openai receipt") }] });
  return { req, notion };
}

test("a month end to end: receipts from Gmail and Claude's billing page, filed, and a threaded draft reply to Ivana", async () => {
  const h = harness();
  const { req } = addMonth(h);
  const run = await h.agent().run("dashboard");

  assert.equal(run.status, "completed_with_gaps");
  assert.equal(run.period, "2026-10");
  assert.equal(run.folder, h.folder, "October's receipts are in the October folder");
  assert.equal(run.request?.messageId, req.id);
  assert.equal(run.request?.alreadyAnswered, false);
  assert.match(run.request!.link, /^https:\/\/mail\.google\.com\//);
  assert.deepEqual(
    run.lines.map((l) => [l.vendorId, l.status, l.include]),
    [
      ["granola", "found_gmail", true],
      ["notion", "found_gmail", true],
      ["wispr-flow", "found_gmail", true],
      ["claude", "found_portal", true],
      ["openai", "found_gmail", true],
      ["amazon", "login_required", false],
    ],
  );
  assert.match(run.lines[5]!.note, /npm run expenses -- login amazon/);
  assert.equal(run.lines[4]!.receipt?.currency, "USD", "the USD receipt of a EUR charge is kept without review");

  // Receipts are in the month folder, named by line.
  assert.deepEqual(h.files(), [
    "01 2026-10-03 Granola 14.00 USD - Receipt-GR-1.pdf",
    "01 2026-10-03 Granola 14.00 USD.pdf",
    "02 2026-10-05 Notion 10.00 USD.pdf",
    "03 2026-10-07 Wispr Flow 12.00 USD.pdf",
    "04 2026-10-12 Claude (Anthropic) 18.00 EUR.pdf",
    "05 2026-10-20 OpenAI 18.47 EUR.pdf",
  ]);
  assert.ok(fs.readFileSync(path.join(h.folder, "02 2026-10-05 Notion 10.00 USD.pdf")).equals(PDF("notion invoice")));
  // The Wispr Flow email had no attachment: it was printed to PDF, with its headers.
  assert.match(h.renderer.html[0]!, /Total \$12\.00/);
  assert.match(h.renderer.html[0]!, /receipts@wisprflow\.ai/);

  // Claude's billing page was used only where Gmail had nothing; Amazon asked for a sign-in.
  assert.deepEqual(h.portals.tasks.map((t) => t.portal), ["claude", "amazon"]);
  assert.ok(!fs.existsSync(path.join(h.cfg.dataDirAbs, "expenses", "staging", run.id)), "portal downloads are cleaned up");

  // One draft, in Ivana's thread, threaded by headers, with every receipt attached.
  assert.equal(h.mailbox.creates, 1);
  const draft = h.mailbox.drafts.get(run.draft!.id)!;
  assert.equal(draft.threadId, req.threadId);
  const mime = parseMime(draft.raw);
  assert.equal(mime.headers["in-reply-to"], req.rfc822MessageId);
  assert.equal(mime.headers["references"], `<root-1@racunovodstvo.example> ${req.rfc822MessageId}`);
  assert.equal(decodeWords(mime.headers["subject"]!), "Re: Računi za listopad 2026");
  assert.match(mime.headers["to"]!, /ivana@racunovodstvo\.example/);
  assert.equal(mime.files.length, 6);
  assert.deepEqual(new Set(mime.files.map((f) => f.filename)), new Set(h.files()));
  assert.match(mime.text, /^Pozdrav Ivana,\r\n\r\nu prilogu šaljem račune za troškove iz listopada 2026\.:/);
  assert.match(mime.text, /1\. GRANOLA\.AI – 14,00 USD, 03\.10\.2026\./);
  assert.match(mime.text, /Za sljedeće troškove račun još nije pronađen:\r\n\r\n- AMZN Mktp DE – 45,99 EUR, 23\.10\.2026\./);
  assert.match(mime.text, /Lijep pozdrav,\r\nAlan$/);

  // Claude never saw Ivana's mail or last month's reply as a receipt candidate.
  for (const c of h.claude.calls.filter((c) => c.kind === "choose")) {
    assert.doesNotMatch(userText(c.params), /Re: Računi za rujan|racunovodstvo\.example/);
  }
  // The newsletter was offered for Notion but not picked.
  assert.ok(!run.lines[1]!.source || run.lines[1]!.source.kind !== "gmail" || run.lines[1]!.source.subject.startsWith("Your receipt"));
  // The extraction read her email, and the email was marked as data.
  const extract = h.claude.calls.find((c) => c.kind === "extract")!;
  assert.match(userText(extract.params), /<message from="Ivana Nikolić <ivana@racunovodstvo\.example>"[^]*mi nedostaju računi/);
  assert.equal((extract.params as unknown as { fallbacks: string }).fallbacks, "default");

  // You are told, with counts only.
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0]!.title, "Expenses 2026-10");
  assert.match(h.notices[0]!.message, /^5 of 6 receipts in the draft to Ivana Nikolić\. 0 to review, 1 missing\.$/);
  assert.doesNotMatch(h.notices[0]!.message, /USD|EUR|Notion/);
  assert.match(run.summary, /October 2026: 5 of 6 receipts attached; the reply to Ivana Nikolić is saved as a Gmail draft\. 1 still missing\./);
  assert.equal(h.portals.closed, 1, "the browser is closed after the run");
});

test("running again updates the same draft, drops files whose receipt is gone, and you choose what goes in", async () => {
  const h = harness();
  const { notion } = addMonth(h);
  const first = await h.agent().run("dashboard");
  h.mailbox.messages.delete(notion.id);
  const second = await h.agent().run("dashboard");

  assert.equal(h.mailbox.creates, 1, "no second draft");
  assert.equal(h.mailbox.updates, 1);
  assert.equal(second.draft!.id, first.draft!.id);
  assert.equal(second.lines[1]!.status, "not_found");
  assert.ok(!h.files().includes("02 2026-10-05 Notion 10.00 USD.pdf"), "the file of a receipt that is no longer found is removed");
  assert.equal(h.files().length, 5);

  // Leave OpenAI out of the draft, then rewrite it.
  const agent = h.agent();
  const toggled = agent.setInclude(second, 5, false);
  assert.equal(toggled.draftOutdated, true);
  assert.throws(() => agent.setInclude(second, 6, true), /no receipt file/);
  const redone = await agent.redraft(toggled);
  assert.equal(redone.draftOutdated, false);
  assert.equal(h.mailbox.updates, 2);
  const mime = parseMime(h.mailbox.drafts.get(redone.draft!.id)!.raw);
  assert.ok(!mime.files.some((f) => f.filename.startsWith("05 ")));
  assert.match(mime.text, /- OPENAI \*CHATGPT SUBSCR – 18,47 EUR, 20\.10\.2026\./);
  assert.equal(h.runs.get(second.id)!.lines[4]!.include, false, "the choice is saved");
});

test("a receipt with another amount in the same currency waits for your review instead of going into the draft", async () => {
  const h = harness({ outcomes: { claude: "not_found", amazon: "not_found" } });
  h.mailbox.addMail({ from: IVANA, subject: "Računi", text: REQUEST_TEXT, at: Date.UTC(2026, 10, 2, 7, 30) });
  h.mailbox.addMail({ from: "Notion <billing@mail.notion.so>", subject: "Your receipt from Notion Labs, Inc.", text: "Amount paid $12.00", at: Date.UTC(2026, 9, 5, 6), attachments: [{ filename: "Invoice.pdf", data: PDF("n") }] });
  h.mailbox.addMail({ from: "Granola <billing@granola.ai>", subject: "Your Granola receipt", text: "Amount paid $14.00", at: Date.UTC(2026, 9, 3, 9), attachments: [{ filename: "Invoice.pdf", data: PDF("g") }] });
  const run = await h.agent().run("cli");
  const notion = run.lines[1]!;
  assert.equal(notion.status, "needs_review");
  assert.equal(notion.include, false);
  assert.match(notion.note, /receipt says 12\.00 USD, the statement 10\.00 USD/);
  assert.ok(notion.files.length === 1 && fs.existsSync(notion.files[0]!.path), "saved to the folder for you to look at");
  const mime = parseMime(h.mailbox.drafts.get(run.draft!.id)!.raw);
  assert.deepEqual(mime.files.map((f) => f.filename), ["01 2026-10-03 Granola 14.00 USD.pdf"]);
  assert.match(mime.text, /- NOTION LABS – 10,00 USD/);
  assert.match(h.notices[0]!.message, /1 to review/);
});

test("a thank-you from Ivana is skipped for the request before it, and an earlier reply of yours is flagged", async () => {
  const answers = [
    { is_receipt_request: false, period: "", expenses: [], other_requests: "" },
    EXTRACTED,
  ];
  const h = harness({ extract: () => answers.shift() ?? new Error("refuse") });
  const { req } = addMonth(h);
  h.mailbox.addMail({ from: IVANA, threadId: req.threadId, subject: "Re: Računi za listopad 2026", text: "Hvala, dobila sam račune za Granolu.", at: Date.UTC(2026, 10, 2, 8, 30) });
  h.mailbox.sent(req.threadId, Date.UTC(2026, 10, 2, 8), "ivana@racunovodstvo.example");
  const run = await h.agent().run("dashboard");
  assert.equal(run.request?.messageId, req.id);
  assert.equal(run.request?.alreadyAnswered, true);
  assert.ok(run.steps.some((s) => /does not ask for receipts/.test(s.text)));
  assert.ok(run.steps.some((s) => s.level === "warn" && /already replied/.test(s.text)));
});

test("no expenses email in the lookback window: nothing is drafted and you are told", async () => {
  const h = harness();
  h.mailbox.addMail({ from: IVANA, subject: "Računi za kolovoz", text: "fali račun", at: Date.UTC(2026, 7, 1) });
  const run = await h.agent().run("dashboard");
  assert.equal(run.status, "no_request");
  assert.equal(h.mailbox.creates, 0);
  assert.equal(h.claude.calls.length, 0, "an email older than the window is not even read");
  assert.match(h.notices[0]!.message, /No expenses email from Ivana Nikolić/);
});

test("Claude declining to read the email fails the run with the reason, and you are told", async () => {
  const h = harness({ extract: () => new Error("refused") });
  addMonth(h);
  const run = await h.agent().run("dashboard");
  assert.equal(run.status, "failed");
  assert.match(run.error, /declined to read the expenses email/);
  assert.equal(h.mailbox.creates, 0);
  assert.match(h.notices[0]!.message, /failed/);
  assert.equal(h.portals.closed, 1);
});

test("attachments over the size limit stay in the folder and are named in the run", async () => {
  const h = harness({ overrides: { maxAttachmentMB: 0.00012 } });
  addMonth(h);
  const run = await h.agent().run("dashboard");
  assert.ok(run.draft && run.draft.attached.length >= 1);
  assert.ok(run.draft!.leftOut.length >= 1);
  assert.ok(run.draft!.bytes <= 120);
  assert.ok(run.steps.some((s) => /Left out of the draft/.test(s.text)));
  assert.equal(h.files().length, 6, "every receipt is still filed");
});

test("two charges from the same vendor get two different receipts", async () => {
  const h = harness();
  h.mailbox.addMail({ from: IVANA, subject: "Računi", text: "Notion dvaput", at: Date.UTC(2026, 10, 2, 7, 30) });
  h.mailbox.addMail({ from: "Notion <billing@mail.notion.so>", subject: "Your receipt from Notion Labs, Inc.", text: "Amount paid $10.00", at: Date.UTC(2026, 9, 5, 6), attachments: [{ filename: "Invoice-A.pdf", data: PDF("a") }] });
  h.mailbox.addMail({ from: "Notion <billing@mail.notion.so>", subject: "Your receipt from Notion Labs, Inc.", text: "Amount paid $8.00", at: Date.UTC(2026, 9, 6, 6), attachments: [{ filename: "Invoice-B.pdf", data: PDF("b") }] });
  const two = {
    ...EXTRACTED,
    expenses: [
      { vendor: "NOTION LABS", description: "", date: "2026-10-05", amount: "10.00", currency: "USD", source_text: "a" },
      { vendor: "NOTION LABS", description: "", date: "2026-10-06", amount: "8.00", currency: "USD", source_text: "b" },
    ],
  };
  const h2 = { ...h };
  const claude = fakeClaude({ extract: () => two, choose: fakeChoose });
  const agent = new ExpenseAgent({
    cfg: h2.cfg,
    mailbox: h.mailbox,
    brain: claudeBrain(claude.client, h.cfg, "Bea"),
    portals: null,
    renderer: null,
    runs: h.runs,
    notify: async () => [],
    stagingRoot: path.join(h.cfg.dataDirAbs, "staging"),
    now: () => new Date(NOW),
  });
  const run = await agent.run("cli");
  assert.deepEqual(run.lines.map((l) => l.files[0] && fs.readFileSync(l.files[0].path).toString()), [PDF("a").toString(), PDF("b").toString()]);
  assert.equal(run.status, "completed");
});

test("each month gets its own folder: November's receipts never land in October's", async () => {
  const november = {
    is_receipt_request: true,
    period: "2026-11",
    expenses: [{ vendor: "GRANOLA.AI", description: "Granola subscription", date: "2026-11-03", amount: "14.00", currency: "USD", source_text: "03.11. GRANOLA.AI 14,00 USD" }],
    other_requests: "",
  };
  const answers: Record<string, unknown>[] = [EXTRACTED, november];
  const h = harness({ extract: () => answers.shift() ?? new Error("no more") });
  addMonth(h);
  const october = await h.agent().run("dashboard");
  // A month later Ivana asks for November.
  h.mailbox.addMail({ from: IVANA, subject: "Računi za studeni 2026", text: "Bok, fali račun za Granolu iz studenog.", at: NOW + 60_000 });
  h.mailbox.addMail({ from: "Granola <billing@granola.ai>", subject: "Your Granola receipt #GR-2", text: "Thanks! Amount paid $14.00 on November 3, 2026.", at: Date.UTC(2026, 10, 3, 9), attachments: [{ filename: "Invoice-GR-2.pdf", data: PDF("granola november") }] });
  const nov = await h.agent().run("dashboard");

  const root = h.cfg.expenses!.receiptsDir;
  assert.equal(october.folder, path.join(root, "2026", "10 October"));
  assert.equal(nov.folder, path.join(root, "2026", "11 November"));
  assert.deepEqual(fs.readdirSync(nov.folder), ["01 2026-11-03 Granola 14.00 USD.pdf"]);
  assert.ok(fs.readFileSync(path.join(nov.folder, "01 2026-11-03 Granola 14.00 USD.pdf")).equals(PDF("granola november")));
  assert.equal(h.files().length, 6, "October's folder is left as it was");
  assert.deepEqual(fs.readdirSync(root).sort(), ["2026"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "2026")).sort(), ["10 October", "11 November"]);
  assert.equal(h.mailbox.creates, 2, "a separate draft answers each of her emails");
});

test("the month folder follows the pattern in config, for example Croatian month names", async () => {
  const h = harness({ overrides: { monthFolder: "{YYYY}/{MM} {Mjesec}" } });
  addMonth(h);
  const run = await h.agent().run("dashboard");
  assert.equal(run.folder, path.join(h.cfg.expenses!.receiptsDir, "2026", "10 Listopad"));
  assert.equal(fs.readdirSync(run.folder).length, 6);
});
