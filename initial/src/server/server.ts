import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { dataPath, isLoopback, type LoadedConfig } from "../config.js";
import type { Pipeline } from "../pipeline.js";
import { OPEN_STATUSES, type Item, type Store } from "../store/db.js";
import { URGENCIES, type Urgency } from "../triage/schema.js";
import type { VaultWriter } from "../obsidian/writer.js";
import { log } from "../util/time.js";
import { quotedRest } from "../gmail/parse.js";
import { dashboardHtml } from "./ui.js";

const COOKIE = "it_token";

class BadRequest extends Error {}
const MAX_BODY = 1_000_000;

export interface ServerDeps {
  cfg: LoadedConfig;
  store: Store;
  pipeline: Pipeline | null;
  vault: VaultWriter;
  lastPoll: () => { at: string; ok: boolean; message: string } | null;
}

function summaryOf(item: Item, projectName: string) {
  return {
    id: item.id,
    channel: item.channel,
    projectId: item.projectId,
    projectName,
    fromName: item.fromName,
    fromEmail: item.fromEmail,
    subject: item.subject,
    title: item.triage?.title ?? item.subject,
    receivedAt: item.receivedAt,
    // Your own rating wins; Claude's stays visible as modelUrgency.
    urgency: item.userUrgency ?? item.triage?.urgency ?? null,
    modelUrgency: item.triage?.urgency ?? null,
    urgencyScore: item.triage?.urgency_score ?? null,
    replyBy: item.triage?.reply_by ?? "",
    replyByUtc: item.triage?.reply_by_utc ?? "",
    status: item.status,
    onlyCc: item.onlyCc,
    senderVerified: item.senderVerified,
    stuck: item.status === "pending_triage" && Date.now() - new Date(item.createdAt).getTime() > 5 * 60_000,
    reviewRequired: item.triage?.review_required ?? false,
    userUrgency: item.userUrgency,
    hasNote: Boolean(item.notePath),
  };
}

function tokenOk(cfg: LoadedConfig, given: string | undefined): boolean {
  const want = cfg.dashboard.token;
  if (!want) return isLoopback(cfg.dashboard.host);
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isText = typeof body === "string";
  res.writeHead(status, {
    "content-type": isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error();
    return json as Record<string, unknown>;
  } catch {
    throw new BadRequest("The request body is not a JSON object");
  }
}

export function createServer(deps: ServerDeps): http.Server {
  const { cfg, store } = deps;
  const projectName = (id: string) => cfg.projects.find((p) => p.id === id)?.name ?? id;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://dashboard.local");
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }

      // Bound to this machine only: refuse other Host names (protects against DNS rebinding).
      if (isLoopback(cfg.dashboard.host)) {
        const host = (req.headers.host ?? "").replace(/:\d+$/, "");
        if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return send(res, 403, "Forbidden host");
      }

      // A link with ?token=... signs this browser in with a cookie, then drops the token from the address.
      const queryToken = url.searchParams.get("token") ?? undefined;
      if (queryToken && cfg.dashboard.token && tokenOk(cfg, queryToken)) {
        return send(res, 302, "", {
          location: "/",
          "set-cookie": `${COOKIE}=${encodeURIComponent(queryToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        });
      }
      if (!tokenOk(cfg, cookieValue(req, COOKIE) ?? (req.headers.authorization ?? "").replace(/^Bearer /, ""))) {
        return send(res, 401, "Sign in by opening the dashboard link that includes your token.");
      }

      const mutating = req.method !== "GET" && req.method !== "HEAD";
      // A custom header cannot be sent cross-site without a preflight this server never answers.
      if (mutating && req.headers["x-inbox-triage"] !== "1") return send(res, 403, "Missing request header");

      if (req.method === "GET" && url.pathname === "/") {
        const nonce = randomBytes(16).toString("base64");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
          "content-security-policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        });
        return res.end(dashboardHtml(nonce));
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api") return send(res, 404, "Not found");

      if (req.method === "GET" && parts[1] === "items" && parts.length === 2) {
        const view = (url.searchParams.get("view") ?? "open") as "open" | "done" | "all";
        if (!["open", "done", "all"].includes(view)) return send(res, 400, { error: "bad view" });
        return send(res, 200, store.list(view).map((i) => summaryOf(i, projectName(i.projectId))));
      }

      if (req.method === "GET" && parts[1] === "summary") {
        const open = store.list("open");
        const needsReply = open.filter((i) => i.status === "needs_reply");
        // Waiting on you for an answer: replies due, plus messages Claude could not triage yet.
        const unanswered = open.filter(
          (i) => i.status === "needs_reply" || i.status === "triage_failed" || (i.status === "pending_triage" && Date.now() - new Date(i.createdAt).getTime() > 5 * 60_000),
        );
        const needsYou = open.filter((i) => i.status === "needs_reply" || i.status === "needs_action");
        const now = Date.now();
        const since = new Date(now - 14 * 86_400_000).toISOString();
        let doctor: unknown = null;
        const doctorFile = dataPath(cfg, "doctor.json");
        if (fs.existsSync(doctorFile)) doctor = JSON.parse(fs.readFileSync(doctorFile, "utf8"));
        return send(res, 200, {
          urgentOpen: needsYou.filter((i) => (i.userUrgency ?? i.triage?.urgency) === "urgent").length,
          needsReply: needsReply.length,
          needsAction: needsYou.length - needsReply.length,
          oldestUnansweredHours: unanswered.length
            ? Math.floor((now - Math.min(...unanswered.map((i) => new Date(i.receivedAt).getTime()))) / 3_600_000)
            : 0,
          tz: cfg.tz,
          triageFailed: open.filter((i) => i.status === "triage_failed").length,
          agreement: store.urgencyAgreement(since),
          lastPoll: deps.lastPoll(),
          doctor,
          projects: cfg.projects.map((p) => ({ id: p.id, name: p.name, folder: p.folder })),
          phase: 1,
        });
      }

      if (parts[1] === "items" && parts[2]) {
        const item = store.get(parts[2]);
        if (!item) return send(res, 404, { error: "not found" });

        if (req.method === "GET" && parts.length === 3) {
          return send(res, 200, {
            ...summaryOf(item, projectName(item.projectId)),
            to: item.to,
            cc: item.cc,
            body: item.body,
            quoted: quotedRest(item.fullText, item.body),
            link: item.link.startsWith("https://mail.google.com/") ? item.link : "",
            attachments: item.attachments,
            notePath: item.notePath,
            folder: cfg.projects.find((p) => p.id === item.projectId)?.folder ?? "",
            replyToName: item.replyToName,
            replyToEmail: item.replyToEmail,
            replyRedirected: item.replyRedirected,
            triage: item.triage,
            triageError: item.triageError,
            draft: item.draft,
          });
        }

        if (req.method === "GET" && parts[3] === "note") {
          if (!item.notePath || !deps.vault.exists(item.notePath)) return send(res, 404, { error: "note not found" });
          return send(res, 200, { path: item.notePath, content: deps.vault.read(item.notePath) });
        }

        if (req.method === "PUT" && parts[3] === "draft") {
          const body = await readJson(req);
          const text = body.text;
          if (text !== null && typeof text !== "string") return send(res, 400, { error: "text must be a string or null" });
          store.setDraft(item.id, text);
          return send(res, 200, { ok: true });
        }

        if (req.method === "POST" && parts[3] === "status") {
          const body = await readJson(req);
          const status = body.status;
          if (status !== "no_reply_needed" && status !== "needs_reply" && status !== "done") return send(res, 400, { error: "bad status" });
          if (status === "needs_reply" && OPEN_STATUSES.includes(item.status)) return send(res, 200, { ok: true });
          if (deps.pipeline) deps.pipeline.setStatus(item.id, status, "set in dashboard");
          else if (status === "needs_reply") store.reopen(item.id);
          else store.setStatus(item.id, status, "set in dashboard");
          return send(res, 200, { ok: true });
        }

        if (req.method === "POST" && parts[3] === "urgency") {
          const body = await readJson(req);
          const u = body.urgency;
          if (u !== null && !(URGENCIES as readonly unknown[]).includes(u)) return send(res, 400, { error: "bad urgency" });
          if (deps.pipeline) deps.pipeline.setUserUrgency(item.id, u as Urgency | null);
          else store.setUserUrgency(item.id, u as Urgency | null);
          return send(res, 200, { ok: true });
        }

        if (req.method === "POST" && parts[3] === "retriage") {
          if (!deps.pipeline) return send(res, 503, { error: "Gmail is not connected in this process" });
          if (item.status !== "triage_failed" && item.status !== "pending_triage") return send(res, 409, { error: "This item is already triaged" });
          const updated = await deps.pipeline.retriage(item.id);
          return send(res, 200, { ok: Boolean(updated?.triage), error: updated?.triageError ?? "" });
        }

        if (req.method === "POST" && (parts[3] === "send" || parts[3] === "ack")) {
          return send(res, 501, { error: "Sending arrives in phase 2. Copy the text and send it from Gmail." });
        }
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof BadRequest) {
        if (!res.headersSent) send(res, 400, { error: err.message });
        return;
      }
      log("dashboard request failed", err);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  });
}
