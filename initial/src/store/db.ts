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
  // Path relative to the vault when inside it, absolute when it was too large to sync; "" until saved.
  path: string;
  inVault: boolean;
  // false while a download keeps failing; retried on later polls. Missing means saved (older rows).
  saved?: boolean;
  // Position among the message's filed attachments, to find it again for a retry.
  index?: number;
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
  // The new part of the message, and the whole text including quoted or forwarded content.
  body: string;
  fullText: string;
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
  // When an acknowledgement went out from the dashboard; the item stays open for the real reply.
  ackedAt?: string | null;
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
  full_text TEXT,
  note_stale INTEGER NOT NULL DEFAULT 0,
  file_attempts INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS thread_notes (
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  note_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, project_id)
);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  send_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempt_at TEXT,
  gmail_id TEXT,
  sent_at TEXT,
  error TEXT NOT NULL DEFAULT '',
  effects INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS outbox_state ON outbox(state);
CREATE INDEX IF NOT EXISTS outbox_item ON outbox(item_id);
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
    fullText: r.full_text == null ? String(r.body) : String(r.full_text),
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
    ackedAt: r.acked_at == null ? null : String(r.acked_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

// queued: waiting out the Undo window. sending: handed to Gmail, outcome not yet recorded.
// sent, failed (shown with Retry) and cancelled (undone) are final until you press Retry.
export const OUTBOX_STATES = ["queued", "sending", "sent", "failed", "cancelled"] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

// What has happened after a send: the item's status, the note in Obsidian, the archive in Gmail.
export const EFFECT_STATUS = 1;
export const EFFECT_NOTE = 2;
export const EFFECT_ARCHIVE = 4;
export const EFFECTS_ALL = EFFECT_STATUS | EFFECT_NOTE | EFFECT_ARCHIVE;

export interface OutboxEntry {
  id: string;
  itemId: string;
  kind: "reply" | "ack";
  to: string[];
  cc: string[];
  // Your text, without the quoted original.
  body: string;
  state: OutboxState;
  sendAt: string;
  createdAt: string;
  attemptAt: string | null;
  gmailId: string | null;
  sentAt: string | null;
  error: string;
  effects: number;
}

function toOutbox(r: Row): OutboxEntry {
  return {
    id: String(r.id),
    itemId: String(r.item_id),
    kind: String(r.kind) as "reply" | "ack",
    to: JSON.parse(String(r.to_json)) as string[],
    cc: JSON.parse(String(r.cc_json)) as string[],
    body: String(r.body),
    state: String(r.state) as OutboxState,
    sendAt: String(r.send_at),
    createdAt: String(r.created_at),
    attemptAt: r.attempt_at == null ? null : String(r.attempt_at),
    gmailId: r.gmail_id == null ? null : String(r.gmail_id),
    sentAt: r.sent_at == null ? null : String(r.sent_at),
    error: String(r.error ?? ""),
    effects: Number(r.effects ?? 0),
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
    if (!cols.has("full_text")) this.db.exec("ALTER TABLE items ADD COLUMN full_text TEXT");
    // Whether the note is behind: 0 no, 1 its details (frontmatter, triage and attachment lines),
    // 2 its checkbox too (the status changed). Set with the change, cleared once the note is written.
    if (!cols.has("note_stale")) this.db.exec("ALTER TABLE items ADD COLUMN note_stale INTEGER NOT NULL DEFAULT 0");
    if (!cols.has("acked_at")) this.db.exec("ALTER TABLE items ADD COLUMN acked_at TEXT");
    if (!cols.has("file_attempts")) this.db.exec("ALTER TABLE items ADD COLUMN file_attempts INTEGER NOT NULL DEFAULT 0");
    // Thread notes are now kept per matter; carry over the first release's table.
    this.db.exec("INSERT OR IGNORE INTO thread_notes (thread_id, project_id, note_path, created_at) SELECT thread_id, project_id, note_path, created_at FROM threads");
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
          triage_json, triage_error, draft, user_urgency, sender_verified, reopened_at, full_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        item.fullText,
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

  /** After the contact rules change, mail skipped for having no rule is looked at again. */
  forgetUnmatchedSkips(): number {
    return Number(this.db.prepare("DELETE FROM skipped WHERE reason LIKE 'no contact rule%'").run().changes);
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

  /**
   * Stores a triage, unless the item already has one and is past triage (a second answer for the
   * same message changes nothing). The status follows it only while the item is still waiting for
   * one, so a choice you made stays.
   */
  saveTriage(id: string, triage: Triage): void {
    const status = triagedStatus(triage);
    const r = this.db
      .prepare(
        `UPDATE items SET triage_json = ?, triage_error = '', status = CASE WHEN status IN ('pending_triage', 'triage_failed') THEN ? ELSE status END,
          note_stale = 2, updated_at = ? WHERE id = ? AND (triage_json IS NULL OR status IN ('pending_triage', 'triage_failed'))`,
      )
      .run(JSON.stringify(triage), status, new Date().toISOString(), id);
    if (Number(r.changes)) this.log(id, "triaged", `${triage.urgency} ${triage.urgency_score}`);
  }

  /** Records a failed triage; an item that already has a triage keeps it. */
  saveTriageError(id: string, error: string): void {
    this.db
      .prepare(
        "UPDATE items SET triage_error = ?, status = CASE WHEN status = 'pending_triage' THEN 'triage_failed' ELSE status END, note_stale = 2, updated_at = ? WHERE id = ? AND triage_json IS NULL",
      )
      .run(error, new Date().toISOString(), id);
    this.log(id, "triage_failed", error);
  }

  setStatus(id: string, status: Status, reason: string): void {
    this.db.prepare("UPDATE items SET status = ?, note_stale = 2, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
    this.log(id, "status", `${status}: ${reason}`);
  }

  /** Back in the queue by your choice: earlier replies no longer close it. A task without a reply reopens as a task. */
  reopen(id: string): void {
    const item = this.get(id);
    if (!item) return;
    const status: Status = item.triage && !item.triage.needs_reply && item.triage.task ? "needs_action" : "needs_reply";
    const now = new Date().toISOString();
    this.db.prepare("UPDATE items SET status = ?, reopened_at = ?, note_stale = 2, updated_at = ? WHERE id = ?").run(status, now, now, id);
    this.log(id, "status", `${status}: reopened in dashboard`);
  }

  /**
   * Items whose note was never written (a failed write, or a stop during triage). Those tried least
   * come first, so a message that can no longer be read never keeps the others waiting.
   */
  unfiled(limit = 10): Item[] {
    return (this.db.prepare("SELECT * FROM items WHERE note_path = '' ORDER BY file_attempts, received_at LIMIT ?").all(limit) as Row[]).map(toItem);
  }

  fileFailed(id: string): void {
    this.db.prepare("UPDATE items SET file_attempts = file_attempts + 1 WHERE id = ?").run(id);
  }

  /** Threads whose note is behind the store, because a write failed or the service stopped. */
  staleNotes(): { threadId: string; projectId: string }[] {
    return (this.db.prepare("SELECT DISTINCT thread_id, project_id FROM items WHERE note_stale > 0 AND note_path != ''").all() as Row[]).map((r) => ({
      threadId: String(r.thread_id),
      projectId: String(r.project_id),
    }));
  }

  /** Items of a thread whose status changed since its note was last written: their checkbox follows. */
  statusChangedIds(threadId: string, projectId: string): string[] {
    return (this.db.prepare("SELECT id FROM items WHERE thread_id = ? AND project_id = ? AND note_stale = 2").all(threadId, projectId) as Row[]).map((r) => String(r.id));
  }

  /** Marks a thread's note as written (false) or as behind (true; a checkbox already due stays due). */
  setNoteStale(threadId: string, projectId: string, stale: boolean): void {
    this.db
      .prepare(`UPDATE items SET note_stale = ${stale ? "max(note_stale, 1)" : "0"} WHERE thread_id = ? AND project_id = ?`)
      .run(threadId, projectId);
  }

  threadItems(threadId: string, projectId: string): Item[] {
    return (this.db.prepare("SELECT * FROM items WHERE thread_id = ? AND project_id = ? ORDER BY received_at, id").all(threadId, projectId) as Row[]).map(toItem);
  }

  setDraft(id: string, draft: string | null): void {
    this.db.prepare("UPDATE items SET draft = ?, updated_at = ? WHERE id = ?").run(draft, new Date().toISOString(), id);
  }

  setUserUrgency(id: string, urgency: Urgency | null): void {
    this.db.prepare("UPDATE items SET user_urgency = ?, note_stale = max(note_stale, 1), updated_at = ? WHERE id = ?").run(urgency, new Date().toISOString(), id);
    this.log(id, "urgency_feedback", urgency ?? "cleared");
  }

  setAttachments(id: string, attachments: FiledAttachment[]): void {
    this.db.prepare("UPDATE items SET attachments_json = ?, note_stale = max(note_stale, 1) WHERE id = ?").run(JSON.stringify(attachments), id);
  }

  /** The note for a thread within one matter: a thread involving two matters has a note in each. */
  threadNote(threadId: string, projectId: string): string | null {
    const row = this.db.prepare("SELECT note_path FROM thread_notes WHERE thread_id = ? AND project_id = ?").get(threadId, projectId) as Row | undefined;
    return row ? String(row.note_path) : null;
  }

  /** Whether another thread's note was given this path; it stays reserved after you delete the file. */
  notePathTaken(notePath: string, threadId: string, projectId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM thread_notes WHERE note_path = ? COLLATE NOCASE AND NOT (thread_id = ? AND project_id = ?)")
        .get(notePath, threadId, projectId) !== undefined
    );
  }

  setThreadNote(threadId: string, projectId: string, notePath: string): void {
    this.db
      .prepare(
        "INSERT INTO thread_notes (thread_id, project_id, note_path, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, project_id) DO UPDATE SET note_path = excluded.note_path",
      )
      .run(threadId, projectId, notePath, new Date().toISOString());
    this.db.prepare("UPDATE items SET note_path = ? WHERE thread_id = ? AND project_id = ? AND note_path != ''").run(notePath, threadId, projectId);
  }

  /** Items with an attachment that has not been saved yet, received in the last week. */
  withUnsavedAttachments(limit = 10): Item[] {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return (
      this.db.prepare("SELECT * FROM items WHERE attachments_json LIKE '%\"saved\":false%' AND received_at >= ? ORDER BY received_at LIMIT ?").all(since, limit) as Row[]
    ).map(toItem);
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


  // ---------- outbox ----------

  /** Adds a send in the Undo window, unless one for the same message is already queued or going out. */
  outboxAdd(e: Pick<OutboxEntry, "id" | "itemId" | "kind" | "to" | "cc" | "body" | "sendAt">): boolean {
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO outbox (id, item_id, kind, to_json, cc_json, body, state, send_at, created_at)
         SELECT ?, ?, ?, ?, ?, ?, 'queued', ?, ? WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE item_id = ? AND state IN ('queued', 'sending'))`,
      )
      .run(e.id, e.itemId, e.kind, JSON.stringify(e.to), JSON.stringify(e.cc), e.body, e.sendAt, now, e.itemId);
    if (Number(r.changes)) this.log(e.itemId, "send_queued", `${e.kind} ${e.id} to ${[...e.to, ...e.cc].join(", ")}`);
    return Number(r.changes) === 1;
  }

  outboxGet(id: string): OutboxEntry | null {
    const row = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as Row | undefined;
    return row ? toOutbox(row) : null;
  }

  outboxForItem(itemId: string, limit = 5): OutboxEntry[] {
    return (this.db.prepare("SELECT * FROM outbox WHERE item_id = ? ORDER BY created_at DESC LIMIT ?").all(itemId, limit) as Row[]).map(toOutbox);
  }

  outboxInState(state: OutboxState): OutboxEntry[] {
    return (this.db.prepare("SELECT * FROM outbox WHERE state = ? ORDER BY send_at").all(state) as Row[]).map(toOutbox);
  }

  /** Queued sends whose Undo window has passed. */
  outboxDue(nowIso: string): OutboxEntry[] {
    return (this.db.prepare("SELECT * FROM outbox WHERE state = 'queued' AND send_at <= ? ORDER BY send_at").all(nowIso) as Row[]).map(toOutbox);
  }

  /** Takes a queued send for delivery. False when it was undone or another worker took it. */
  outboxClaim(id: string): boolean {
    const r = this.db.prepare("UPDATE outbox SET state = 'sending', attempt_at = ? WHERE id = ? AND state = 'queued'").run(new Date().toISOString(), id);
    return Number(r.changes) === 1;
  }

  /** Undo: only while it is still in the Undo window. */
  outboxCancel(id: string): boolean {
    const r = this.db.prepare("UPDATE outbox SET state = 'cancelled' WHERE id = ? AND state = 'queued'").run(id);
    const e = this.outboxGet(id);
    if (Number(r.changes) && e) this.log(e.itemId, "send_undone", id);
    return Number(r.changes) === 1;
  }

  outboxSent(id: string, gmailId: string): void {
    const r = this.db.prepare("UPDATE outbox SET state = 'sent', gmail_id = ?, sent_at = ?, error = '' WHERE id = ? AND state IN ('sending', 'failed')").run(gmailId, new Date().toISOString(), id);
    const e = this.outboxGet(id);
    if (Number(r.changes) && e) this.log(e.itemId, "sent", `${e.kind} ${id} as ${gmailId}`);
  }

  outboxFailed(id: string, error: string): void {
    const r = this.db.prepare("UPDATE outbox SET state = 'failed', error = ? WHERE id = ? AND state IN ('sending', 'queued')").run(error, id);
    const e = this.outboxGet(id);
    if (Number(r.changes) && e) this.log(e.itemId, "send_failed", `${id}: ${error}`);
  }

  /** Notes an error on a send whose outcome is still unknown; it stays "sending" until checked. */
  outboxNote(id: string, error: string): void {
    this.db.prepare("UPDATE outbox SET error = ? WHERE id = ?").run(error, id);
  }

  /** Retry: a failed send goes back into the Undo window. */
  outboxRequeue(id: string, sendAt: string): boolean {
    const e = this.outboxGet(id);
    if (!e) return false;
    const r = this.db
      .prepare(
        `UPDATE outbox SET state = 'queued', send_at = ?, error = '' WHERE id = ? AND state = 'failed'
         AND NOT EXISTS (SELECT 1 FROM outbox WHERE item_id = ? AND id != ? AND state IN ('queued', 'sending'))`,
      )
      .run(sendAt, id, e.itemId, id);
    return Number(r.changes) === 1;
  }

  addEffects(id: string, bits: number): void {
    this.db.prepare("UPDATE outbox SET effects = (effects | ?) WHERE id = ?").run(bits, id);
  }

  /** Sent messages whose follow-up (status, note, archive) is not finished. */
  outboxUnfinished(): OutboxEntry[] {
    return (this.db.prepare("SELECT * FROM outbox WHERE state = 'sent' AND effects != ? ORDER BY sent_at").all(EFFECTS_ALL) as Row[]).map(toOutbox);
  }

  /** Gmail ids of acknowledgements sent in a thread: holding replies, so they close nothing. */
  ackGmailIds(threadId: string): string[] {
    return (
      this.db
        .prepare("SELECT o.gmail_id FROM outbox o JOIN items i ON i.id = o.item_id WHERE i.thread_id = ? AND o.kind = 'ack' AND o.gmail_id IS NOT NULL")
        .all(threadId) as Row[]
    ).map((r) => String(r.gmail_id));
  }

  setAcked(id: string, at: string): void {
    this.db.prepare("UPDATE items SET acked_at = ?, note_stale = max(note_stale, 1), updated_at = ? WHERE id = ?").run(at, new Date().toISOString(), id);
    this.log(id, "acknowledged", at);
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
