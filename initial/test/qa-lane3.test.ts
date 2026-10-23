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
import { Store } from "../src/store/db.js";
import { b64url, tempDir, testConfig } from "./helpers.js";

function raw(id: string, from: string, subject: string, body: string, at: number) {
  return {
    id, threadId: id, internalDate: String(at), labelIds: ["INBOX"],
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "To", value: "me@example.com" }, { name: "Subject", value: subject }], body: { data: b64url(body) } },
  };
}

function setup(answers: Record<string, unknown>[]) {
  const vaultDir = tempDir("vault-");
  const cfg = testConfig({ vault: { path: vaultDir } });
  const store = new Store(":memory:");
  const msgs = new Map<string, ParsedMessage>();
  const gmail = {
    listIds: async () => ({ ids: [...msgs.keys()], truncated: false }),
    message: async (id: string) => msgs.get(id)!,
    thread: async (id: string) => [...msgs.values()].filter((m) => m.threadId === id),
    threadMeta: async () => [],
    attachment: async () => Buffer.from(""),
  };
  const claude = { beta: { messages: { create: async () => ({ model: "m", stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify(answers.shift()) }] }) } } };
  const pipeline = new Pipeline(cfg, store, gmail as unknown as GmailReader, claude as unknown as Anthropic, new VaultWriter(vaultDir, 1e6, path.join(vaultDir, "..", "large")));
  return { cfg, store, msgs, pipeline, vaultDir };
}

const base = {
  title: "T", summary: "S", needs_reply: true, urgency: "week", urgency_score: 40, urgency_reason: "R", task: "Task", due_date: "", reply_by: "",
  message_language: "en", suggested_reply: "Hi", draft_assumption: "", ack_reply: "Ok",
};

test("a task that needs action but no reply stays open and unticked", async () => {
  const { store, msgs, pipeline, vaultDir } = setup([{ ...base, needs_reply: false, task: "Upload photos and invoice to the claim portal", due_date: "2026-10-30", urgency: "week" }]);
  msgs.set("2a", parseMessage(raw("2a", "Claims <claims@bank.example>", "Claim", "Please upload photos by 30 October.", Date.UTC(2026, 9, 22))));
  await pipeline.pollOnce();
  const item = store.get("2a")!;
  assert.equal(item.status, "needs_action");
  const note = fs.readFileSync(path.join(vaultDir, item.notePath), "utf8");
  assert.match(note, /- \[ \] Upload photos and invoice to the claim portal 📅 2026-10-30 \^it-2a/);
  assert.ok(store.list("open").some((i) => i.id === "2a"));
  // Marking it done closes it and ticks the task.
  pipeline.setStatus("2a", "done", "test");
  assert.equal(store.get("2a")!.status, "done");
  assert.match(fs.readFileSync(path.join(vaultDir, item.notePath), "utf8"), /- \[x\] Upload photos/);
  store.close();
});

test("a pure notice with no task is closed and has no task line", async () => {
  const { store, msgs, pipeline, vaultDir } = setup([{ ...base, needs_reply: false, task: "", urgency: "fyi", suggested_reply: "", ack_reply: "" }]);
  msgs.set("2b", parseMessage(raw("2b", "Bank <info@bank.example>", "Notice", "New document.", Date.UTC(2026, 9, 22))));
  await pipeline.pollOnce();
  const item = store.get("2b")!;
  assert.equal(item.status, "no_reply_needed");
  assert.doesNotMatch(fs.readFileSync(path.join(vaultDir, item.notePath), "utf8"), /\^it-2b/);
  store.close();
});

async function serve(store: Store) {
  const cfg = testConfig();
  const server = createServer({ cfg, store, pipeline: null, vault: new VaultWriter(tempDir("v-"), 1e6, tempDir("l-")), lastPoll: () => null });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("your urgency correction drives the dashboard, and the agreement rate counts only rated items", async () => {
  const { store, msgs, pipeline } = setup([
    { ...base, urgency: "urgent", urgency_score: 90 },
    { ...base, urgency: "urgent", urgency_score: 85 },
  ]);
  msgs.set("3a", parseMessage(raw("3a", "Bank <info@bank.example>", "A", "a", Date.UTC(2026, 9, 22, 8))));
  msgs.set("3b", parseMessage(raw("3b", "Bank <info@bank.example>", "B", "b", Date.UTC(2026, 9, 22, 9))));
  await pipeline.pollOnce();
  const { server, base: url } = await serve(store);
  try {
    const post = (id: string, urgency: string | null) =>
      fetch(`${url}/api/items/${id}/urgency`, { method: "POST", headers: { "x-inbox-triage": "1", "content-type": "application/json" }, body: JSON.stringify({ urgency }) });
    let s = (await (await fetch(`${url}/api/summary`)).json()) as { urgentOpen: number; agreement: { agreementRate: number | null; rated: number } };
    assert.equal(s.urgentOpen, 2);
    assert.equal(s.agreement.agreementRate, null, "nothing rated yet");
    await post("3a", "week");
    await post("3b", "urgent");
    s = (await (await fetch(`${url}/api/summary`)).json()) as typeof s;
    assert.equal(s.urgentOpen, 1, "3a was corrected to week");
    assert.equal(s.agreement.rated, 2);
    assert.equal(s.agreement.agreementRate, 0.5);
    const items = (await (await fetch(`${url}/api/items`)).json()) as { id: string; urgency: string; modelUrgency: string }[];
    assert.deepEqual(items.find((i) => i.id === "3a"), { ...items.find((i) => i.id === "3a"), urgency: "week", modelUrgency: "urgent" });
  } finally {
    server.close();
    store.close();
  }
});

test("a malformed request body is a 400, not a server error", async () => {
  const store = new Store(":memory:");
  const now = new Date().toISOString();
  store.insert({
    id: "4a", channel: "gmail", threadId: "4a", projectId: "croatia-bank", role: "bank", fromName: "", fromEmail: "a@bank.example", to: [], cc: [], subject: "s",
    receivedAt: now, body: "", fullText: "", onlyCc: false, senderVerified: true, replyToName: "", replyToEmail: "", replyRedirected: false, replyLanguage: "", link: "",
    attachments: [], notePath: "", status: "needs_reply", triage: null, triageError: "", draft: null, userUrgency: null, reopenedAt: null, createdAt: now, updatedAt: now,
  });
  const { server, base: url } = await serve(store);
  try {
    const r = await fetch(`${url}/api/items/4a/draft`, { method: "PUT", headers: { "x-inbox-triage": "1" }, body: "{not json" });
    assert.equal(r.status, 400);
  } finally {
    server.close();
    store.close();
  }
});
