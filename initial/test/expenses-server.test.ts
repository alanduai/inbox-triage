import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server/server.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/obsidian/writer.js";
import { claudeBrain, ExpenseAgent } from "../src/expenses/agent.js";
import { ExpenseService } from "../src/expenses/service.js";
import { RunStore } from "../src/expenses/runs.js";
import type { ExpenseRun } from "../src/expenses/types.js";
import { expensesConfig, fakeClaude, FakeMailbox, PDF } from "./expenses-helpers.js";
import { tempDir, testConfig } from "./helpers.js";

const IVANA = "Ivana Nikolić <ivana@racunovodstvo.example>";
const EXTRACTED = {
  is_receipt_request: true,
  period: "2026-10",
  expenses: [
    { vendor: "NOTION LABS", description: "", date: "2026-10-05", amount: "10.00", currency: "USD", source_text: "Notion" },
    { vendor: "Hetzner", description: "", date: "2026-10-09", amount: "5.00", currency: "EUR", source_text: "Hetzner" },
  ],
  other_requests: "",
};

async function start() {
  const cfg = expensesConfig({ browser: { enabled: false } });
  const mailbox = new FakeMailbox();
  mailbox.addMail({ from: IVANA, subject: "Računi za listopad", text: "Fali Notion i Hetzner.", at: Date.UTC(2026, 10, 2, 7) });
  mailbox.addMail({ from: "Notion <billing@mail.notion.so>", subject: "Your receipt from Notion Labs, Inc.", text: "Amount paid $10.00", at: Date.UTC(2026, 9, 5, 6), attachments: [{ filename: "Invoice.pdf", data: PDF("n") }] });
  // The first Gmail search waits until the test lets it go, so "already running" can be checked.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const list = mailbox.listIds.bind(mailbox);
  mailbox.listIds = async (q: string) => {
    await gate;
    return list(q);
  };
  const claude = fakeClaude({
    extract: () => EXTRACTED,
    choose: () => ({ candidate_id: [...mailbox.messages.values()].find((m) => m.subject.startsWith("Your receipt"))!.id, attachments: ["Invoice.pdf"], receipt_amount: "10.00", receipt_currency: "USD", receipt_date: "2026-10-05", invoice_number: "", confidence: "high", reason: "match" }),
  });
  const runs = new RunStore(path.join(cfg.dataDirAbs, "expenses", "runs"));
  const factory = () =>
    new ExpenseAgent({ cfg, mailbox, brain: claudeBrain(claude.client, cfg, "Bea"), portals: null, renderer: null, runs, notify: async () => [], stagingRoot: path.join(cfg.dataDirAbs, "st"), now: () => new Date(Date.UTC(2026, 10, 2, 9)) });
  const expenses = new ExpenseService(cfg, factory, runs);
  const server = createServer({ cfg, store: new Store(":memory:"), pipeline: null, vault: new VaultWriter(tempDir("v-"), 1e6, tempDir("l-")), lastPoll: () => null, expenses });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, mailbox, release, expenses };
}

const H = { "x-inbox-triage": "1", "content-type": "application/json" };

test("the dashboard starts a run, shows it live, and lets you choose what goes into the draft", async () => {
  const { base, server, mailbox, release } = await start();
  try {
    const page = await fetch(`${base}/expenses`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /script-src 'nonce-/);
    assert.match(await page.text(), /Run reconciliation/);
    assert.match(await (await fetch(`${base}/`)).text(), /href="\/expenses"/, "linked from the inbox page");

    const state = (await (await fetch(`${base}/api/expenses/state`)).json()) as { enabled: boolean; accountant: string; checks: { name: string }[]; runs: unknown[]; draftsLink: string };
    assert.equal(state.enabled, true);
    assert.equal(state.accountant, "Ivana Nikolić");
    assert.ok(state.checks.some((c) => c.name === "Gmail drafts"));
    assert.deepEqual(state.runs, []);
    assert.equal(state.draftsLink, "https://mail.google.com/mail/?authuser=me%40example.com#drafts");

    assert.equal((await fetch(`${base}/api/expenses/run`, { method: "POST" })).status, 403, "a write needs the custom header");
    const started = await fetch(`${base}/api/expenses/run`, { method: "POST", headers: H });
    assert.equal(started.status, 202);
    const { runId } = (await started.json()) as { runId: string };
    const again = await fetch(`${base}/api/expenses/run`, { method: "POST", headers: H });
    assert.equal(again.status, 409, "one run at a time");
    const live = (await (await fetch(`${base}/api/expenses/state`)).json()) as { runningId: string };
    assert.equal(live.runningId, runId);
    assert.equal((await fetch(`${base}/api/expenses/runs/${runId}/redraft`, { method: "POST", headers: H })).status, 409, "no changes while it runs");

    release();
    let run: ExpenseRun;
    for (;;) {
      run = (await (await fetch(`${base}/api/expenses/runs/${runId}`)).json()) as ExpenseRun;
      if (run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(run.status, "completed_with_gaps");
    assert.deepEqual(run.lines.map((l) => l.status), ["found_gmail", "not_found"]);
    assert.equal(mailbox.creates, 1);

    const off = await fetch(`${base}/api/expenses/runs/${runId}/lines/1`, { method: "POST", headers: H, body: JSON.stringify({ include: false }) });
    assert.equal(((await off.json()) as ExpenseRun).draftOutdated, true);
    assert.equal((await fetch(`${base}/api/expenses/runs/${runId}/lines/1`, { method: "POST", headers: H, body: JSON.stringify({ include: "no" }) })).status, 400);
    assert.equal((await fetch(`${base}/api/expenses/runs/${runId}/lines/2`, { method: "POST", headers: H, body: JSON.stringify({ include: true }) })).status, 500, "a line without a receipt cannot be included");
    const redone = (await (await fetch(`${base}/api/expenses/runs/${runId}/redraft`, { method: "POST", headers: H })).json()) as ExpenseRun;
    assert.equal(redone.draftOutdated, false);
    assert.deepEqual(redone.draft?.attached, [], "the saved draft follows your choice, even with nothing left to attach");
    assert.equal(mailbox.updates, 1);

    const after = (await (await fetch(`${base}/api/expenses/state`)).json()) as { runningId: string | null; runs: { id: string; attached: number; missing: number; review: number }[] };
    assert.equal(after.runningId, null);
    assert.equal(after.runs[0]!.id, runId);
    assert.equal(after.runs[0]!.review, 1, "the receipt you left out counts as to review");
    assert.equal((await fetch(`${base}/api/expenses/runs/20990101-000000-ffff`)).status, 404);
    assert.equal((await fetch(`${base}/api/expenses/runs/..%2F..%2Fetc`)).status, 404);
  } finally {
    server.close();
  }
});

test("without an expenses section the page explains it and runs are refused", async () => {
  const cfg = testConfig({ dataDir: tempDir("d-") });
  const server = createServer({ cfg, store: new Store(":memory:"), pipeline: null, vault: new VaultWriter(tempDir("v-"), 1e6, tempDir("l-")), lastPoll: () => null, expenses: null });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const state = (await (await fetch(`${base}/api/expenses/state`)).json()) as { enabled: boolean; checks: { level: string; detail: string }[] };
    assert.equal(state.enabled, false);
    assert.match(state.checks[0]!.detail, /add the "expenses" section/);
    assert.equal((await fetch(`${base}/api/expenses/run`, { method: "POST", headers: H })).status, 503);
  } finally {
    server.close();
  }
});
