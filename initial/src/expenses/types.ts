import type { ThreadMeta } from "../gmail/client.js";
import type { AttachmentRef, ParsedMessage } from "../gmail/parse.js";
import type { PortalId } from "./config.js";

/** The Gmail calls the agent needs: the read-only ones of phase 1, plus drafts. */
export interface MailboxApi {
  listIds(query: string, maxPages?: number): Promise<{ ids: string[]; truncated: boolean }>;
  message(id: string): Promise<ParsedMessage>;
  threadMeta(id: string): Promise<ThreadMeta[]>;
  attachment(messageId: string, ref: AttachmentRef): Promise<Buffer>;
  createDraft(raw: Buffer, threadId: string): Promise<{ id: string; messageId: string }>;
  updateDraft(id: string, raw: Buffer, threadId: string): Promise<{ id: string; messageId: string }>;
  draftExists(id: string): Promise<boolean>;
}

/** One expense from Ivana's list, as Claude read it and the fixed rules cleaned it. */
export interface Expense {
  vendor: string;
  description: string;
  // YYYY-MM-DD or "".
  date: string;
  amount: number | null;
  currency: string;
  // The words in her email this line comes from, kept for checking.
  sourceText: string;
}

export interface Extraction {
  isReceiptRequest: boolean;
  // YYYY-MM.
  period: string;
  expenses: Expense[];
  otherRequests: string;
  model: string;
}

export interface Candidate {
  message: ParsedMessage;
  score: number;
}

export interface Choice {
  candidateId: string;
  attachments: string[];
  receiptAmount: number | null;
  receiptCurrency: string;
  receiptDate: string;
  invoiceNumber: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface PortalTask {
  runId: string;
  portal: PortalId;
  expense: Expense;
  vendorName: string;
  company: string;
  period: string;
  stagingDir: string;
}

export interface PortalResult {
  status: "found" | "not_found" | "login_required" | "blocked" | "error";
  files: { path: string; filename: string }[];
  url: string;
  invoiceNumber: string;
  invoiceDate: string;
  amount: number | null;
  currency: string;
  note: string;
  steps: number;
}

export interface PortalFetcher {
  fetch(task: PortalTask): Promise<PortalResult>;
  close(): Promise<void>;
}

export interface Renderer {
  htmlToPdf(html: string): Promise<Buffer>;
  close(): Promise<void>;
}

export const LINE_STATUSES = ["pending", "found_gmail", "found_portal", "needs_review", "not_found", "login_required", "error"] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export interface SavedFile {
  // Absolute path in the receipts folder.
  path: string;
  filename: string;
  size: number;
  sha256: string;
}

export interface ExpenseLine extends Expense {
  n: number;
  vendorId: string;
  vendorName: string;
  status: LineStatus;
  // Whether the files go into the draft. Off for anything that needs your review.
  include: boolean;
  source:
    | { kind: "gmail"; messageId: string; subject: string; from: string; date: string; link: string }
    | { kind: "portal"; portal: PortalId; url: string }
    | null;
  receipt: { amount: number | null; currency: string; date: string; invoiceNumber: string } | null;
  files: SavedFile[];
  note: string;
}

export const RUN_STATUSES = ["running", "completed", "completed_with_gaps", "no_request", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunStep {
  at: string;
  level: "info" | "warn" | "error";
  text: string;
}

export interface ExpenseRun {
  id: string;
  trigger: "dashboard" | "cli";
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  period: string;
  request: {
    messageId: string;
    threadId: string;
    rfc822MessageId: string;
    references: string;
    subject: string;
    fromName: string;
    fromEmail: string;
    receivedAt: string;
    link: string;
    // A reply you sent to Ivana after this email is already in the thread.
    alreadyAnswered: boolean;
    otherRequests: string;
    unreadAttachments: string[];
  } | null;
  lines: ExpenseLine[];
  folder: string;
  draft: {
    id: string;
    messageId: string;
    updatedAt: string;
    attached: string[];
    // Included files left out because the email would be too large.
    leftOut: string[];
    bytes: number;
  } | null;
  // You changed which receipts go in after the draft was saved; "Update draft" rewrites it.
  draftOutdated: boolean;
  steps: RunStep[];
  error: string;
  summary: string;
}
