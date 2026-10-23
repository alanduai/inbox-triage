import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server/server.js";
import { Store, type Item } from "../src/store/db.js";
import { VaultWriter } from "../src/obsidian/writer.js";
import { tempDir, testConfig } from "./helpers.js";

function item(id: string): Item {
  const now = new Date().toISOString();
  return {
    id, channel: "gmail", threadId: id, projectId: "croatia-bank", role: "bank", fromName: "Marija", fromEmail: "marija@bank.example",
    to: ["me@example.com"], cc: [], subject: "Dokumenti", receivedAt: now, body: "Molimo dokumente.", fullText: "Molimo dokumente.", onlyCc: false, senderVerified: true, reopenedAt: null,
    replyToName: "Marija", replyToEmail: "marija@bank.example", replyRedirected: false, replyLanguage: "", link: "javascript:alert(1)",
    attachments: [], notePath: "", status: "needs_reply", triage: null, triageError: "", draft: null, userUrgency: null, createdAt: now, updatedAt: now,
  };
}

async function start(cfgOverrides: Record<string, unknown>) {
  const cfg = testConfig(cfgOverrides);
  const store = new Store(":memory:");
  store.insert(item("abc"));
  const server = createServer({ cfg, store, pipeline: null, vault: new VaultWriter(tempDir("v-"), 1e6, tempDir("l-")), lastPoll: () => null });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, server, store };
}

test("a network-reachable dashboard needs the token, then works with a cookie", async () => {
  const token = "t".repeat(32);
  const { base, server, store } = await start({ dashboard: { host: "0.0.0.0", port: 0, token } });
  try {
    assert.equal((await fetch(`${base}/api/items`)).status, 401);
    const signIn = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
    assert.equal(signIn.status, 302);
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
    assert.match(signIn.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    const list = (await (await fetch(`${base}/api/items`, { headers: { cookie } })).json()) as { id: string }[];
    assert.deepEqual(list.map((i) => i.id), ["abc"]);
    const detail = (await (await fetch(`${base}/api/items/abc`, { headers: { cookie } })).json()) as { link: string };
    assert.equal(detail.link, "", "only Gmail links are passed to the page");

    // Writes need the custom header.
    assert.equal((await fetch(`${base}/api/items/abc/draft`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ text: "x" }) })).status, 403);
    const ok = await fetch(`${base}/api/items/abc/draft`, { method: "PUT", headers: { cookie, "x-inbox-triage": "1" }, body: JSON.stringify({ text: "My draft" }) });
    assert.equal(ok.status, 200);
    assert.equal(store.get("abc")!.draft, "My draft");

    const page = await fetch(`${base}/`, { headers: { cookie } });
    const csp = page.headers.get("content-security-policy")!;
    const nonce = csp.match(/'nonce-([^']+)'/)![1]!;
    assert.match(await page.text(), new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, (c) => "\\" + c)}">`));

    const send = await fetch(`${base}/api/items/abc/send`, { method: "POST", headers: { cookie, "x-inbox-triage": "1" } });
    assert.equal(send.status, 501, "phase 1 never sends");
  } finally {
    server.close();
  }
});

test("a this-Mac-only dashboard refuses other host names", async () => {
  const { base, server, store } = await start({});
  try {
    assert.equal((await fetch(`${base}/api/items`)).status, 200);
    // fetch drops a custom Host header, so this request is sent with node:http.
    const port = new URL(base).port;
    const status403 = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/items", headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    assert.equal(status403, 403);
    const status = await fetch(`${base}/api/items/abc/status`, { method: "POST", headers: { "x-inbox-triage": "1", "content-type": "application/json" }, body: JSON.stringify({ status: "no_reply_needed" }) });
    assert.equal(status.status, 200);
    const summary = (await (await fetch(`${base}/api/summary`)).json()) as { needsReply: number; phase: number };
    assert.equal(summary.needsReply, 0);
    assert.equal(summary.phase, 1);

    // Back to the queue records when, so earlier replies no longer close it.
    const back = await fetch(`${base}/api/items/abc/status`, { method: "POST", headers: { "x-inbox-triage": "1", "content-type": "application/json" }, body: JSON.stringify({ status: "needs_reply" }) });
    assert.equal(back.status, 200);
    assert.ok(store.get("abc")!.reopenedAt);
  } finally {
    server.close();
  }
});
