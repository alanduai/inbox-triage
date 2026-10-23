import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Role } from "../config.js";
import type { Triage } from "../triage/claude.js";
import type { Urgency } from "../triage/schema.js";

// Open: pending_triage, needs_reply, needs_action (a task without a reply), triage_failed.
// Closed: replied, no_reply_needed, done (a needs_action task you finished).
export const STATUSES = ["pending_triage", "needs_reply", "needs_action", "triage_failed", "replied", "no_reply_needed", "done"] as const;
export type Status = (typeof STATUSES)[number];
export const OPEN_STATUSES: Status[] = ["pending_triage", "needs_reply", "needs_action", "triage_failed"];

/** The open status a triage leads to: a reply, a task without a reply, or nothing to do. */
export function triagedStatus(triage: Pick<Triage, "needs_reply" | "task">): Status {
  return triage.needs_reply ? "needs_reply" : triage.task ? "needs_action" : "no_reply_needed";
}

export interface FiledAttachment {
  filename: string;
  size: number;
  // Path relative to the vault when inside it, absolute when it was too large to sync.
  path: string;
  inVault: boolean;
}

export interface Item {
  id: string;
  channel: "gmail";
  threadId: string;
  projectId: string;
  role: Role;
  fromName: string;
  fromEmail: string;
  to: string[];
  cc: string[];
  subject: string;
  receivedAt: string;
  body: string;
  onlyCc: boolean;
  // Gmail's sender authentication for the From domain; null when Gmail reported none.
  senderVerified: boolean | null;
  replyToName: string;
  replyToEmail: string;
  replyRedirected: boolean;
  replyLanguage: string;
  link: string;
  attachments: FiledAttachment[];
  notePath: string;
  status: Status;
  triage: Triage | null;
  triageError: string;
  draft: string | null;
  userUrgency: Urgency | null;
  // Set when you put a closed item back in the queue; replies sent before it no longer close it.
  reopenedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, string | number | null>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  received_at TEXT NOT NULL,
  body TEXT NOT NULL,
  only_cc INTEGER NOT NULL,
  reply_to_name TEXT NOT NULL,
  reply_to_email TEXT NOT NULL,
  reply_redirected INTEGER NOT NULL,
  reply_language TEXT NOT NULL,
  link TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  note_path TEXT NOT NULL,
  status TEXT NOT NULL,
  triage_json TEXT,
  triage_error TEXT NOT NULL DEFAULT '',
  draft TEXT,
  user_urgency TEXT,
  sender_verified INTEGER,
  reopened_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_thread ON items(thread_id);
CREATE INDEX IF NOT EXISTS items_status ON items(status);
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  note_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skipped (id TEXT PRIMARY KEY, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;

function toItem(r: Row): Item {
  return {
    id: String(r.id),
    channel: "gmail",
    threadId: String(r.thread_id),
    projectId: String(r.project_id),
    role: String(r.role) as Role,
    fromName: String(r.from_name),
    fromEmail: String(r.from_email),
    to: JSON.parse(String(r.to_json)) as string[],
    cc: JSON.parse(String(r.cc_json)) as string[],
    subject: String(r.subject),
    receivedAt: String(r.received_at),
    body: String(r.body),
    onlyCc: Number(r.only_cc) === 1,
    replyToName: String(r.reply_to_name),
    replyToEmail: String(r.reply_to_email),
    replyRedirected: Number(r.reply_redirected) === 1,
    replyLanguage: String(r.reply_language),
    link: String(r.link),
    attachments: JSON.parse(String(r.attachments_json)) as FiledAttachment[],
    notePath: String(r.note_path),
    status: String(r.status) as Status,
    triage: r.triage_json ? (JSON.parse(String(r.triage_json)) as Triage) : null,
    triageError: String(r.triage_error ?? ""),
    draft: r.draft == null ? null : String(r.draft),
    userUrgency: r.user_urgency == null ? null : (String(r.user_urgency) as Urgency),
    senderVerified: r.sender_verified == null ? null : Number(r.sender_verified) === 1,
    reopenedAt: r.reopened_at == null ? null : String(r.reopened_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // Columns added after the first release.
    const cols = new Set((this.db.prepare("PRAGMA table_info(items)").all() as Row[]).map((r) => String(r.name)));
    if (!cols.has("sender_verified")) this.db.exec("ALTER TABLE items ADD COLUMN sender_verified INTEGER");
    if (!cols.has("reopened_at")) this.db.exec("ALTER TABLE items ADD COLUMN reopened_at TEXT");
    if (file !== ":memory:") fs.chmodSync(file, 0o600);
  }

  close(): void {
    this.db.close();
  }

  has(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM items WHERE id = ?").get(id) !== undefined;
  }

  insert(item: Item): void {
    this.db
      .prepare(
        `INSERT INTO items (id, channel, thread_id, project_id, role, from_name, from_email, to_json, cc_json, subject, received_at, body,
          only_cc, reply_to_name, reply_to_email, reply_redirected, reply_language, link, attachments_json, note_path, status,
          triage_json, triage_error, draft, user_urgency, sender_verified, reopened_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.channel,
        item.threadId,
        item.projectId,
        item.role,
        item.fromName,
        item.fromEmail,
        JSON.stringify(item.to),
        JSON.stringify(item.cc),
        item.subject,
        item.receivedAt,
        item.body,
        item.onlyCc ? 1 : 0,
        item.replyToName,
        item.replyToEmail,
        item.replyRedirected ? 1 : 0,
        item.replyLanguage,
        item.link,
        JSON.stringify(item.attachments),
        item.notePath,
        item.status,
        item.triage ? JSON.stringify(item.triage) : null,
        item.triageError,
        item.draft,
        item.userUrgency,
        item.senderVerified == null ? null : item.senderVerified ? 1 : 0,
        item.reopenedAt,
        item.createdAt,
        item.updatedAt,
      );
    this.log(item.id, "received", item.subject);
  }

  /** Messages the search returned but that matched no contact rule, so they are not fetched again. */
  isSkipped(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM skipped WHERE id = ?").get(id) !== undefined;
  }

  markSkipped(id: string, reason: string): void {
    this.db.prepare("INSERT OR IGNORE INTO skipped (id, reason, at) VALUES (?, ?, ?)").run(id, reason, new Date().toISOString());
  }

  setNotePath(id: string, notePath: string): void {
    this.db.prepare("UPDATE items SET note_path = ? WHERE id = ?").run(notePath, id);
  }

  get(id: string): Item | null {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
    return row ? toItem(row) : null;
  }

  list(view: "open" | "done" | "all"): Item[] {
    const open = OPEN_STATUSES.map((s) => `'${s}'`).join(",");
    const where = view === "open" ? `WHERE status IN (${open})` : view === "done" ? `WHERE status NOT IN (${open})` : "";
    return (this.db.prepare(`SELECT * FROM items ${where} ORDER BY received_at DESC LIMIT 500`).all() as Row[]).map(toItem);
  }

  openInThread(threadId: string): Item[] {
    const open = OPEN_STATUSES.map((s) => `'${s}'`).join(",");
    return (this.db.prepare(`SELECT * FROM items WHERE thread_id = ? AND status IN (${open})`).all(threadId) as Row[]).map(toItem);
  }

  openThreadIds(): string[] {
    const open = OPEN_STATUSES.map((s) => `'${s}'`).join(",");
    return (this.db.prepare(`SELECT DISTINCT thread_id FROM items WHERE status IN (${open})`).all() as Row[]).map((r) => String(r.thread_id));
  }

  /** Stores a triage. The status follows it only while the item is still waiting for one, so a choice you made stays. */
  saveTriage(id: string, triage: Triage): void {
    const status = triagedStatus(triage);
    this.db
      .prepare(
        "UPDATE items SET triage_json = ?, triage_error = '', status = CASE WHEN status IN ('pending_triage', 'triage_failed') THEN ? ELSE status END, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(triage), status, new Date().toISOString(), id);
    this.log(id, "triaged", `${triage.urgency} ${triage.urgency_score}`);
  }

  saveTriageError(id: string, error: string): void {
    this.db
      .prepare(
        "UPDATE items SET triage_error = ?, status = CASE WHEN status = 'pending_triage' THEN 'triage_failed' ELSE status END, updated_at = ? WHERE id = ?",
      )
      .run(error, new Date().toISOString(), id);
    this.log(id, "triage_failed", error);
  }

  setStatus(id: string, status: Status, reason: string): void {
    this.db.prepare("UPDATE items SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
    this.log(id, "status", `${status}: ${reason}`);
  }

  /** Back in the queue by your choice: earlier replies no longer close it. A task without a reply reopens as a task. */
  reopen(id: string): void {
    const item = this.get(id);
    if (!item) return;
    const status: Status = item.triage && !item.triage.needs_reply && item.triage.task ? "needs_action" : "needs_reply";
    const now = new Date().toISOString();
    this.db.prepare("UPDATE items SET status = ?, reopened_at = ?, updated_at = ? WHERE id = ?").run(status, now, now, id);
    this.log(id, "status", `${status}: reopened in dashboard`);
  }

  /** Items whose note was never written (a failed write, or a stop during triage). */
  unfiled(limit = 10): Item[] {
    return (this.db.prepare("SELECT * FROM items WHERE note_path = '' ORDER BY received_at LIMIT ?").all(limit) as Row[]).map(toItem);
  }

  threadItems(threadId: string): Item[] {
    return (this.db.prepare("SELECT * FROM items WHERE thread_id = ? ORDER BY received_at").all(threadId) as Row[]).map(toItem);
  }

  setDraft(id: string, draft: string | null): void {
    this.db.prepare("UPDATE items SET draft = ?, updated_at = ? WHERE id = ?").run(draft, new Date().toISOString(), id);
  }

  setUserUrgency(id: string, urgency: Urgency | null): void {
    this.db.prepare("UPDATE items SET user_urgency = ?, updated_at = ? WHERE id = ?").run(urgency, new Date().toISOString(), id);
    this.log(id, "urgency_feedback", urgency ?? "cleared");
  }

  setAttachments(id: string, attachments: FiledAttachment[]): void {
    this.db.prepare("UPDATE items SET attachments_json = ? WHERE id = ?").run(JSON.stringify(attachments), id);
  }

  threadNote(threadId: string): string | null {
    const row = this.db.prepare("SELECT note_path FROM threads WHERE thread_id = ?").get(threadId) as Row | undefined;
    return row ? String(row.note_path) : null;
  }

  setThreadNote(threadId: string, projectId: string, notePath: string): void {
    this.db
      .prepare("INSERT INTO threads (thread_id, project_id, note_path, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET note_path = excluded.note_path")
      .run(threadId, projectId, notePath, new Date().toISOString());
  }

  getState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setState(key: string, value: string): void {
    this.db.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  log(itemId: string | null, kind: string, detail: string): void {
    this.db.prepare("INSERT INTO events (item_id, at, kind, detail) VALUES (?, ?, ?, ?)").run(itemId, new Date().toISOString(), kind, detail);
  }

  /**
   * How often you agreed with the urgent flag: the phase 1 measure. Only items you rated count,
   * so the rate stays empty until you have rated some, instead of assuming agreement.
   */
  urgencyAgreement(sinceIso: string): { flaggedUrgent: number; rated: number; disagreed: number; missedUrgent: number; agreementRate: number | null } {
    const rows = this.db
      .prepare("SELECT triage_json, user_urgency FROM items WHERE triage_json IS NOT NULL AND received_at >= ?")
      .all(sinceIso) as Row[];
    let flagged = 0;
    let rated = 0;
    let disagreed = 0;
    let missed = 0;
    for (const r of rows) {
      const model = (JSON.parse(String(r.triage_json)) as Triage).urgency;
      const user = r.user_urgency == null ? null : String(r.user_urgency);
      if (model === "urgent") {
        flagged++;
        if (user) {
          rated++;
          if (user !== "urgent") disagreed++;
        }
      } else if (user === "urgent") missed++;
    }
    return { flaggedUrgent: flagged, rated, disagreed, missedUrgent: missed, agreementRate: rated ? (rated - disagreed) / rated : null };
  }
}
