import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { LoadedConfig } from "../config.js";
import { gmailLink } from "../gmail/links.js";
import type { ParsedMessage } from "../gmail/parse.js";
import { log } from "../util/time.js";
import type { ExpensesConfig } from "./config.js";
import { buildMime, draftBody, mimeTypeFor, replySubject } from "./draft.js";
import { extractRequest, finalizeExtraction, looksLikeRequest, readableAttachment, type ExtractInput, type ModelExtraction } from "./extract.js";
import { chooseReceipt, finalizeChoice, reviewReason, type ModelChoice } from "./match.js";
import type { Notifier } from "./notify.js";
import { PORTALS } from "./portals/guard.js";
import { emailAsHtml, isImage, isPdf, monthFolder, receiptFileName, removeStale, saveReceipt } from "./receipts.js";
import { newRunId, type RunStore } from "./runs.js";
import { receiptQueries, scoreCandidate, searchWindow } from "./search.js";
import type { Candidate, Expense, ExpenseLine, ExpenseRun, MailboxApi, PortalFetcher, Renderer, RunStep } from "./types.js";
import { adHocVendor, resolveVendor, vendorList, type VendorProfile } from "./vendors.js";

/** The two judgment calls the agent asks Claude to make. Everything else is fixed code. */
export interface Brain {
  extract(input: ExtractInput): Promise<{ result: ModelExtraction; model: string; unread: string[] }>;
  choose(expense: Expense, vendorName: string, candidates: Candidate[]): Promise<ModelChoice>;
}

export function claudeBrain(client: Anthropic, cfg: LoadedConfig, company: string): Brain {
  return {
    extract: (input) => extractRequest(client, cfg, input),
    choose: (expense, vendorName, candidates) => chooseReceipt(client, cfg, company, expense, vendorName, candidates),
  };
}

export interface AgentDeps {
  cfg: LoadedConfig;
  mailbox: MailboxApi;
  brain: Brain;
  portals: PortalFetcher | null;
  renderer: Renderer | null;
  runs: RunStore;
  notify: Notifier;
  // Portal downloads wait here until they are filed. Under the private data folder.
  stagingRoot: string;
  now?: () => Date;
}

const MAX_REQUEST_CANDIDATES = 10;
const MAX_EXTRACT_CALLS = 4;
const MAX_IDS_PER_QUERY = 15;
const MAX_CANDIDATES = 5;
const MIN_SCORE = 2;

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function expensesConfig(cfg: LoadedConfig): ExpensesConfig {
  if (!cfg.expenses) throw new Error('The expenses agent is not set up: add an "expenses" section to config.json (see config.example.json).');
  return cfg.expenses;
}

/**
 * The monthly run: find Ivana's latest expenses email, read which receipts she is missing, find
 * each one in Gmail (or on Amazon.de, Claude or OpenAI when Gmail has nothing), file them in the
 * month folder, and save a reply to her with the receipts attached as a Gmail draft. It never sends.
 */
export class ExpenseAgent {
  private readonly x: ExpensesConfig;
  private readonly vendors: VendorProfile[];
  private readonly now: () => Date;
  onUpdate: ((run: ExpenseRun) => void) | null = null;

  constructor(private readonly d: AgentDeps) {
    this.x = expensesConfig(d.cfg);
    this.vendors = vendorList(this.x.vendors);
    this.now = d.now ?? (() => new Date());
  }

  private get account(): string {
    return this.x.gmail.account ?? this.d.cfg.gmail.account;
  }

  private save(run: ExpenseRun): void {
    this.d.runs.save(run);
    this.onUpdate?.(run);
  }

  newRun(trigger: ExpenseRun["trigger"]): ExpenseRun {
    const now = this.now();
    const run: ExpenseRun = {
      id: newRunId(now),
      trigger,
      startedAt: now.toISOString(),
      finishedAt: null,
      status: "running",
      period: "",
      request: null,
      lines: [],
      folder: "",
      draft: null,
      draftOutdated: false,
      steps: [],
      error: "",
      summary: "",
    };
    this.save(run);
    return run;
  }

  async run(trigger: ExpenseRun["trigger"], existing?: ExpenseRun): Promise<ExpenseRun> {
    const run = existing ?? this.newRun(trigger);
    const step = (text: string, level: RunStep["level"] = "info") => {
      run.steps.push({ at: this.now().toISOString(), level, text });
      this.save(run);
    };
    try {
      await this.execute(run, step);
    } catch (err) {
      run.status = "failed";
      run.error = msg(err);
      run.summary = `The run failed: ${run.error}`;
      step(run.error, "error");
      log("expenses run failed", err);
    } finally {
      run.finishedAt = this.now().toISOString();
      this.save(run);
      await this.d.portals?.close().catch(() => undefined);
      await this.d.renderer?.close().catch(() => undefined);
      fs.rmSync(path.join(this.d.stagingRoot, run.id), { recursive: true, force: true });
    }
    await this.tell(run);
    return run;
  }

  private async tell(run: ExpenseRun): Promise<void> {
    const month = run.period || "this month";
    const n = run.lines.length;
    const attached = attachedLines(run).length;
    const title = `Expenses ${month}`;
    const message =
      run.status === "failed"
        ? `The expenses run failed. Open the dashboard for details.`
        : run.status === "no_request"
          ? `No expenses email from ${this.x.accountant.name} found.`
          : `${attached} of ${n} receipts in the draft to ${this.x.accountant.name}${run.draft ? "" : " (no draft saved)"}. ${run.lines.filter((l) => l.status === "needs_review").length} to review, ${run.lines.filter((l) => l.status === "not_found" || l.status === "login_required" || l.status === "error").length} missing.`;
    const channels = await this.d.notify({ title, message }).catch(() => []);
    if (channels.length) {
      run.steps.push({ at: this.now().toISOString(), level: "info", text: `Notified you (${channels.join(", ")}).` });
      this.save(run);
    }
  }

  private async execute(run: ExpenseRun, step: (text: string, level?: RunStep["level"]) => void): Promise<void> {
    step(`Looking for ${this.x.accountant.name}'s latest expenses email (last ${this.x.requestLookbackDays} days).`);
    const found = await this.findRequest(step);
    if (!found) {
      run.status = "no_request";
      run.summary = `No expenses email from ${this.x.accountant.name} in the last ${this.x.requestLookbackDays} days.`;
      step(run.summary, "warn");
      return;
    }
    const { message, extraction, unread } = found;
    run.period = extraction.period;
    run.folder = monthFolder(this.x.receiptsDir, run.period);
    run.request = {
      messageId: message.id,
      threadId: message.threadId,
      rfc822MessageId: message.rfc822MessageId,
      references: message.references ?? "",
      subject: message.subject,
      fromName: message.from.name,
      fromEmail: message.from.email,
      receivedAt: message.internalDate.toISOString(),
      link: this.link(message),
      alreadyAnswered: await this.alreadyAnswered(message),
      otherRequests: extraction.otherRequests,
      unreadAttachments: unread,
    };
    run.lines = extraction.expenses.map((e, i) => {
      const v = this.vendorFor(e);
      return { ...e, n: i + 1, vendorId: v.id, vendorName: v.name, status: "pending", include: false, source: null, receipt: null, files: [], note: "" };
    });
    step(`Found "${message.subject}" from ${message.from.email}: ${run.lines.length} receipt${run.lines.length === 1 ? "" : "s"} missing for ${run.period}.`);
    if (run.request.alreadyAnswered) step("You already replied to this email. The draft is made anyway; check that it is still needed.", "warn");
    if (unread.length) step(`Not read (check them yourself): ${unread.join(", ")}.`, "warn");
    if (extraction.otherRequests) step(`She also asks: ${extraction.otherRequests}`, "warn");

    const used = new Set<string>();
    const cache = new Map<string, ParsedMessage>();
    for (const line of run.lines) {
      try {
        await this.findInGmail(run, line, used, cache);
      } catch (err) {
        line.status = "error";
        line.note = `Gmail search failed: ${msg(err)}`;
      }
      const vendor = this.vendors.find((v) => v.id === line.vendorId);
      if ((line.status === "not_found" || line.status === "error") && vendor?.portal) {
        if (!this.d.portals) line.note = `${line.note} The ${PORTALS[vendor.portal].name} fallback is off.`.trim();
        else {
          step(`${line.vendor}: not in Gmail, looking on ${PORTALS[vendor.portal].name}.`);
          await this.findOnPortal(run, line, vendor.portal).catch((err) => {
            line.status = "error";
            line.note = `${PORTALS[vendor.portal!].name}: ${msg(err)}`;
          });
        }
      }
      step(`${line.n}. ${line.vendor}: ${describe(line)}`, line.status === "found_gmail" || line.status === "found_portal" ? "info" : "warn");
    }

    const previous = this.d.runs.previousFor(message.id, run.id);
    if (previous) {
      const removed = removeStale(previous.lines.flatMap((l) => l.files), run.lines.flatMap((l) => l.files));
      if (removed.length) step(`Removed ${removed.length} file${removed.length === 1 ? "" : "s"} an earlier run saved that no longer match.`);
    }
    await this.writeDraft(run, previous, step);

    const good = attachedLines(run);
    const review = run.lines.filter((l) => l.status === "needs_review").length;
    const missing = run.lines.length - good.length - review;
    run.status = good.length === run.lines.length ? "completed" : "completed_with_gaps";
    run.summary =
      `${monthName(run.period)}: ${good.length} of ${run.lines.length} receipts attached` +
      (run.draft ? `; the reply to ${this.x.accountant.name} is saved as a Gmail draft.` : "; no draft saved.") +
      (review ? ` ${review} to review.` : "") +
      (missing > 0 ? ` ${missing} still missing.` : "");
    step(run.summary, run.status === "completed" ? "info" : "warn");
  }

  private link(m: ParsedMessage): string {
    try {
      return gmailLink({ account: this.account, threadId: m.threadId, messageId: m.id, rfc822MessageId: m.rfc822MessageId, threadIdIsMessageId: m.threadId === m.id });
    } catch {
      return "";
    }
  }

  private vendorFor(e: Expense): VendorProfile {
    return resolveVendor(`${e.vendor} ${e.description}`, this.vendors) ?? adHocVendor(e.vendor);
  }

  private async findRequest(step: (text: string, level?: RunStep["level"]) => void) {
    const since = Math.floor((this.now().getTime() - this.x.requestLookbackDays * 86_400_000) / 1000);
    const from = this.x.accountant.emails.map((e) => `from:${e}`).join(" ");
    const { ids } = await this.d.mailbox.listIds(`{${from}} after:${since} -in:drafts -in:chats`, 1);
    const messages: ParsedMessage[] = [];
    for (const id of ids.slice(0, MAX_REQUEST_CANDIDATES)) messages.push(await this.d.mailbox.message(id));
    messages.sort((a, b) => b.internalDate.getTime() - a.internalDate.getTime());
    const ordered = [...messages.filter(looksLikeRequest), ...messages.filter((m) => !looksLikeRequest(m)).slice(0, 2)].slice(0, MAX_EXTRACT_CALLS);
    for (const m of ordered) {
      const files: ExtractInput["files"] = [];
      for (const ref of m.attachments) {
        if (!readableAttachment(ref)) continue;
        try {
          files.push({ ref, data: await this.d.mailbox.attachment(m.id, ref) });
        } catch (err) {
          step(`Could not download ${ref.filename}: ${msg(err)}`, "warn");
        }
      }
      const { result, model, unread } = await this.d.brain.extract({
        ownerName: this.d.cfg.owner.name,
        company: this.x.company,
        accountantName: this.x.accountant.name,
        now: this.now(),
        tz: this.d.cfg.tz,
        message: m,
        files,
      });
      const extraction = finalizeExtraction(result, { messageDate: m.internalDate, tz: this.d.cfg.tz, model });
      if (extraction.isReceiptRequest) return { message: m, extraction, unread };
      step(`"${m.subject}" (${m.internalDate.toISOString().slice(0, 10)}) does not ask for receipts; looking at the one before.`);
    }
    return null;
  }

  private async alreadyAnswered(m: ParsedMessage): Promise<boolean> {
    const owner = new Set(this.d.cfg.owner.emails.map((e) => e.toLowerCase()));
    const accountant = new Set(this.x.accountant.emails);
    try {
      const meta = await this.d.mailbox.threadMeta(m.threadId);
      return meta.some(
        (x) =>
          x.internalDate.getTime() > m.internalDate.getTime() &&
          !x.labelIds.includes("DRAFT") &&
          (x.labelIds.includes("SENT") || owner.has(x.fromEmail.toLowerCase())) &&
          x.recipients.some((r) => accountant.has(r.toLowerCase())),
      );
    } catch {
      return false;
    }
  }

  private async findInGmail(run: ExpenseRun, line: ExpenseLine, used: Set<string>, cache: Map<string, ParsedMessage>): Promise<void> {
    const vendor = this.vendors.find((v) => v.id === line.vendorId) ?? adHocVendor(line.vendor);
    const window = searchWindow(line, run.period, this.x.searchWindowDays, this.d.cfg.tz);
    const ids: string[] = [];
    for (const q of receiptQueries(vendor, window, this.x.accountant.emails)) {
      const r = await this.d.mailbox.listIds(q, 1);
      for (const id of r.ids.slice(0, MAX_IDS_PER_QUERY)) if (!ids.includes(id)) ids.push(id);
    }
    const candidates: Candidate[] = [];
    for (const id of ids) {
      if (used.has(id)) continue;
      let m = cache.get(id);
      if (!m) {
        m = await this.d.mailbox.message(id);
        cache.set(id, m);
      }
      candidates.push({ message: m, score: scoreCandidate(line, vendor, m, this.d.cfg.tz, run.period) });
    }
    const best = candidates.filter((c) => c.score >= MIN_SCORE).sort((a, b) => b.score - a.score || b.message.internalDate.getTime() - a.message.internalDate.getTime()).slice(0, MAX_CANDIDATES);
    if (!best.length) {
      line.status = "not_found";
      line.note = ids.length ? "Gmail has mail from this vendor, but none looks like this receipt." : "No receipt email in Gmail.";
      return;
    }
    const raw = await this.d.brain.choose(line, vendor.name, best);
    const choice = finalizeChoice(raw, best);
    if (!choice) {
      line.status = "not_found";
      line.note = raw.reason || "None of the emails found is this receipt.";
      return;
    }
    const m = best.find((c) => c.message.id === choice.candidateId)!.message;
    const files = [];
    const notes: string[] = [];
    const folder = monthFolder(this.x.receiptsDir, run.period);
    for (const name of choice.attachments) {
      const ref = m.attachments.find((a) => a.filename === name);
      if (!ref) continue;
      const data = await this.d.mailbox.attachment(m.id, ref);
      const kind = isPdf(data) ? "pdf" : isImage(data);
      if (!kind) {
        notes.push(`${name} is not a PDF or a picture, so it was left out.`);
        continue;
      }
      files.push(saveReceipt(folder, receiptFileName(line, run.period, `.${kind}`, name, files.length), data));
    }
    if (!files.length) {
      // The email itself is the receipt (or its attachment was unusable): file it as a PDF.
      const html = emailAsHtml(m, this.d.cfg.tz);
      if (this.d.renderer) files.push(saveReceipt(folder, receiptFileName(line, run.period, ".pdf", "email", 0), await this.d.renderer.htmlToPdf(html)));
      else files.push(saveReceipt(folder, receiptFileName(line, run.period, ".html", "email", 0), Buffer.from(html, "utf8")));
    }
    used.add(m.id);
    line.files = files;
    line.receipt = { amount: choice.receiptAmount, currency: choice.receiptCurrency, date: choice.receiptDate, invoiceNumber: choice.invoiceNumber };
    line.source = { kind: "gmail", messageId: m.id, subject: m.subject, from: m.from.email, date: m.internalDate.toISOString(), link: this.link(m) };
    const review = reviewReason(line, line.receipt, choice.confidence);
    line.status = review ? "needs_review" : "found_gmail";
    line.include = !review;
    line.note = [review || choice.reason, ...notes].filter(Boolean).join(" ");
  }

  private async findOnPortal(run: ExpenseRun, line: ExpenseLine, portal: keyof typeof PORTALS): Promise<void> {
    const r = await this.d.portals!.fetch({
      runId: run.id,
      portal,
      expense: line,
      vendorName: line.vendorName,
      company: this.x.company,
      period: run.period,
      stagingDir: path.join(this.d.stagingRoot, run.id),
    });
    const name = PORTALS[portal].name;
    if (r.status === "login_required") {
      line.status = "login_required";
      line.note = `${name} needs you to sign in again. On the Mac mini run: npm run expenses -- login ${portal}`;
      return;
    }
    if (r.status !== "found" || !r.files.length) {
      line.status = r.status === "error" ? "error" : "not_found";
      line.note = `${line.note} ${name}: ${r.note || "not found"}`.trim();
      return;
    }
    const folder = monthFolder(this.x.receiptsDir, run.period);
    line.files = r.files.map((f, i) => {
      const data = fs.readFileSync(f.path);
      const ext = isPdf(data) ? ".pdf" : `.${isImage(data) ?? "bin"}`;
      return saveReceipt(folder, receiptFileName(line, run.period, ext, f.filename, i), data);
    });
    line.receipt = { amount: r.amount, currency: r.currency, date: r.invoiceDate, invoiceNumber: r.invoiceNumber };
    line.source = { kind: "portal", portal, url: r.url };
    const review = reviewReason(line, line.receipt, "medium");
    line.status = review ? "needs_review" : "found_portal";
    line.include = !review;
    line.note = review || r.note;
  }

  /**
   * Saves the reply to Ivana as a draft in her thread, with the included receipts attached. A run
   * for the same email of hers rewrites the draft it saved before instead of adding a second one.
   */
  private async writeDraft(run: ExpenseRun, previous: ExpenseRun | null, step: (text: string, level?: RunStep["level"]) => void): Promise<void> {
    const req = run.request;
    if (!req) return;
    const maxBytes = this.x.maxAttachmentMB * 1_000_000;
    let bytes = 0;
    const attachments: { filename: string; mimeType: string; content: Buffer }[] = [];
    const leftOut: string[] = [];
    const attachedLines: ExpenseLine[] = [];
    for (const line of run.lines) {
      if (!line.include || !line.files.length) continue;
      let any = false;
      for (const f of line.files) {
        if (!fs.existsSync(f.path)) {
          leftOut.push(f.filename);
          continue;
        }
        const content = fs.readFileSync(f.path);
        if (bytes + content.length > maxBytes) {
          leftOut.push(f.filename);
          continue;
        }
        bytes += content.length;
        attachments.push({ filename: f.filename, mimeType: mimeTypeFor(f.filename), content });
        any = true;
      }
      if (any) attachedLines.push(line);
    }
    const existing = run.draft?.id || previous?.draft?.id || "";
    const draftThere = existing ? await this.d.mailbox.draftExists(existing) : false;
    if (!attachments.length && !draftThere) {
      run.draft = null;
      run.draftOutdated = false;
      step("No receipt to attach, so no draft was saved.", "warn");
      return;
    }
    if (leftOut.length) step(`Left out of the draft (over ${this.x.maxAttachmentMB} MB or missing): ${leftOut.join(", ")}. They are in the folder.`, "warn");
    const text = draftBody({
      greeting: this.x.accountant.greeting,
      period: run.period,
      attached: attachedLines,
      missing: run.lines.filter((l) => !attachedLines.includes(l)),
      signOff: this.d.cfg.signOffs.hr,
    });
    const raw = buildMime({
      from: { name: this.d.cfg.owner.name, email: this.account },
      to: [{ name: req.fromName, email: req.fromEmail }],
      subject: replySubject(req.subject),
      inReplyTo: req.rfc822MessageId,
      references: req.references,
      text,
      attachments,
      date: this.now(),
    });
    let saved: { id: string; messageId: string };
    if (draftThere) {
      // A draft saved earlier always follows your latest choice, even when nothing is left to attach.
      saved = await this.d.mailbox.updateDraft(existing, raw, req.threadId);
      step(`Updated the draft reply to ${this.x.accountant.name} (${attachments.length} attachment${attachments.length === 1 ? "" : "s"}).`);
    } else {
      saved = await this.d.mailbox.createDraft(raw, req.threadId);
      step(`Saved a draft reply to ${this.x.accountant.name} in Gmail (${attachments.length} attachment${attachments.length === 1 ? "" : "s"}). Review it and send it from Gmail.`);
    }
    run.draft = { id: saved.id, messageId: saved.messageId, updatedAt: this.now().toISOString(), attached: attachments.map((a) => a.filename), leftOut, bytes };
    run.draftOutdated = false;
  }

  /** Puts a found receipt in or out of the draft. "Update draft" then rewrites it. */
  setInclude(run: ExpenseRun, n: number, include: boolean): ExpenseRun {
    const line = run.lines.find((l) => l.n === n);
    if (!line) throw new Error(`No line ${n} in this run`);
    if (include && !line.files.length) throw new Error("This line has no receipt file to include");
    if (line.include !== include) {
      line.include = include;
      run.draftOutdated = true;
      run.steps.push({ at: this.now().toISOString(), level: "info", text: `${line.n}. ${line.vendor}: ${include ? "included in" : "left out of"} the draft by you.` });
      this.save(run);
    }
    return run;
  }

  async redraft(run: ExpenseRun): Promise<ExpenseRun> {
    if (!run.request) throw new Error("This run found no email to answer");
    const step = (text: string, level: RunStep["level"] = "info") => {
      run.steps.push({ at: this.now().toISOString(), level, text });
      this.save(run);
    };
    await this.writeDraft(run, null, step);
    const attached = attachedLines(run).length;
    run.summary = `${monthName(run.period)}: ${attached} of ${run.lines.length} receipts attached${run.draft ? `; the reply to ${this.x.accountant.name} is saved as a Gmail draft.` : "; no draft saved."}`;
    run.status = attached === run.lines.length ? "completed" : "completed_with_gaps";
    this.save(run);
    return run;
  }
}

/** Expenses with at least one receipt file in the saved draft (one expense can have two files). */
export function attachedLines(run: ExpenseRun): ExpenseLine[] {
  const names = new Set(run.draft?.attached ?? []);
  return run.lines.filter((l) => l.files.some((f) => names.has(f.filename)));
}

function describe(line: ExpenseLine): string {
  switch (line.status) {
    case "found_gmail":
      return `receipt found in Gmail (${line.files.length} file${line.files.length === 1 ? "" : "s"}).`;
    case "found_portal":
      return `receipt downloaded from ${line.source?.kind === "portal" ? PORTALS[line.source.portal].name : "the portal"}.`;
    case "needs_review":
      return `possible receipt, needs your review: ${line.note}`;
    case "login_required":
      return line.note;
    default:
      return `not found. ${line.note}`.trim();
  }
}

const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthName(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return MONTHS_EN[m - 1] ? `${MONTHS_EN[m - 1]} ${y}` : period;
}
