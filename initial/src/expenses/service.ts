import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { dataPath, type LoadedConfig } from "../config.js";
import { authorizedClient, EXPENSES_GMAIL_SCOPES, tokenScopes } from "../gmail/auth.js";
import { anthropicApiKey } from "../util/secrets.js";
import { log } from "../util/time.js";
import { claudeBrain, ExpenseAgent, expensesConfig, type AgentDeps } from "./agent.js";
import { ExpenseMailbox } from "./gmail.js";
import { systemNotifier } from "./notify.js";
import { anthropicCreate, BrowserPortalFetcher, PlaywrightBrowser } from "./portals/browser.js";
import { PdfRenderer } from "./render.js";
import { RunStore } from "./runs.js";
import type { ExpenseRun } from "./types.js";

export interface SetupCheck {
  name: string;
  level: "ok" | "warn" | "fail";
  detail: string;
}

export function runsDir(cfg: LoadedConfig): string {
  return dataPath(cfg, path.join("expenses", "runs"));
}

function lockFile(cfg: LoadedConfig): string {
  return dataPath(cfg, path.join("expenses", "run.lock"));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Another process (the service, or `expenses run` in a terminal) holding the run lock, or null. */
export function lockHolder(cfg: LoadedConfig): number | null {
  try {
    const pid = Number(fs.readFileSync(lockFile(cfg), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function takeLock(cfg: LoadedConfig): boolean {
  const file = lockFile(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (lockHolder(cfg) !== null) return false;
  fs.rmSync(file, { force: true });
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(cfg: LoadedConfig): void {
  try {
    if (fs.readFileSync(lockFile(cfg), "utf8").trim() === String(process.pid)) fs.rmSync(lockFile(cfg), { force: true });
  } catch {
    // Already gone.
  }
}

export function profileDir(cfg: LoadedConfig): string {
  return dataPath(cfg, expensesConfig(cfg).browser.profileDir);
}

/** The real agent: Gmail with the draft token, Claude, the browser fallback and the PDF printer. */
export function realAgent(cfg: LoadedConfig): ExpenseAgent {
  const x = expensesConfig(cfg);
  const scopes = tokenScopes(cfg, x.gmail.tokenFile);
  if (scopes.length && !scopes.includes("https://www.googleapis.com/auth/gmail.compose")) {
    throw new Error("The expenses Gmail token cannot save drafts. Run: npm run expenses -- auth");
  }
  const mailbox = new ExpenseMailbox(authorizedClient(cfg, { tokenFile: x.gmail.tokenFile, authCommand: "npm run expenses -- auth" }));
  const client = new Anthropic({ apiKey: anthropicApiKey(cfg) });
  const renderer = new PdfRenderer({ executablePath: x.browser.channel ? undefined : x.browser.executablePath });
  const portals = x.browser.enabled
    ? new BrowserPortalFetcher(
        cfg,
        new PlaywrightBrowser({ profileDir: profileDir(cfg), headless: x.browser.headless, channel: x.browser.channel, executablePath: x.browser.executablePath, renderPdf: (html) => renderer.htmlToPdf(html) }),
        anthropicCreate(client),
        { maxSteps: x.browser.maxSteps, startUrls: x.portals },
      )
    : null;
  const deps: AgentDeps = {
    cfg,
    mailbox,
    brain: claudeBrain(client, cfg, x.company),
    portals,
    renderer,
    runs: new RunStore(runsDir(cfg)),
    notify: systemNotifier(x.notify, (m) => log(m)),
    stagingRoot: dataPath(cfg, path.join("expenses", "staging")),
  };
  return new ExpenseAgent(deps);
}

// The dashboard polls every few seconds during a run; the Keychain is asked at most once a minute.
let claudeChecked: { at: number; check: SetupCheck } | null = null;

function claudeCheck(cfg: LoadedConfig): SetupCheck {
  if (claudeChecked && Date.now() - claudeChecked.at < 60_000) return claudeChecked.check;
  let check: SetupCheck;
  try {
    anthropicApiKey(cfg);
    check = { name: "Claude", level: "ok", detail: `API key found; model ${cfg.claude.model}.` };
  } catch (err) {
    check = { name: "Claude", level: "fail", detail: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
  }
  claudeChecked = { at: Date.now(), check };
  return check;
}

/** What the dashboard can check without calling Google or Claude. */
export function setupChecks(cfg: LoadedConfig): SetupCheck[] {
  const checks: SetupCheck[] = [];
  if (!cfg.expenses) return [{ name: "Expenses agent", level: "fail", detail: 'Not set up: add the "expenses" section to config.json.' }];
  const x = cfg.expenses;
  const scopes = tokenScopes(cfg, x.gmail.tokenFile);
  const hasToken = fs.existsSync(dataPath(cfg, x.gmail.tokenFile));
  checks.push(
    !hasToken
      ? { name: "Gmail drafts", level: "fail", detail: "Not signed in yet. On the Mac mini run: npm run expenses -- auth" }
      : EXPENSES_GMAIL_SCOPES.every((s) => scopes.includes(s))
        ? { name: "Gmail drafts", level: "ok", detail: `Can read mail and save drafts for ${x.gmail.account ?? cfg.gmail.account}. It never sends.` }
        : { name: "Gmail drafts", level: "fail", detail: "The token cannot save drafts. Run: npm run expenses -- auth" },
  );
  checks.push(claudeCheck(cfg));
  const parent = path.dirname(x.receiptsDir);
  checks.push(
    fs.existsSync(x.receiptsDir) || fs.existsSync(parent)
      ? { name: "Receipts folder", level: "ok", detail: `${x.receiptsDir}/<month>` }
      : { name: "Receipts folder", level: "fail", detail: `${parent} does not exist. Create it or change expenses.receiptsDir.` },
  );
  if (!x.browser.enabled) checks.push({ name: "Amazon.de, Claude, OpenAI", level: "warn", detail: "The browser fallback is off; only Gmail is searched." });
  else {
    let playwright = true;
    try {
      import.meta.resolve("playwright");
    } catch {
      playwright = false;
    }
    const profile = profileDir(cfg);
    checks.push(
      !playwright
        ? { name: "Amazon.de, Claude, OpenAI", level: "fail", detail: "Playwright is not installed. Run: npm ci && npx playwright install chromium" }
        : fs.existsSync(profile)
          ? { name: "Amazon.de, Claude, OpenAI", level: "ok", detail: "Browser profile ready. If a portal asks to sign in again: npm run expenses -- login <amazon|claude|openai>" }
          : { name: "Amazon.de, Claude, OpenAI", level: "warn", detail: "Not signed in yet. On the Mac mini run: npm run expenses -- login amazon (then claude, openai)" },
    );
  }
  checks.push({
    name: "Notification",
    level: "ok",
    detail: [x.notify.macos ? "macOS Notification Center" : "", x.notify.ntfyUrl ? "ntfy push" : "", "this dashboard"].filter(Boolean).join(", "),
  });
  return checks;
}

/**
 * One run at a time, started from the dashboard or the command line. The agent is built for each
 * run, so signing in again (`expenses auth`, `expenses login`) needs no restart of the service.
 */
export class ExpenseService {
  readonly runs: RunStore;
  private active: { id: string; done: Promise<ExpenseRun> } | null = null;

  constructor(
    readonly cfg: LoadedConfig,
    private readonly factory: () => ExpenseAgent = () => realAgent(cfg),
    runs?: RunStore,
  ) {
    this.runs = runs ?? new RunStore(runsDir(cfg));
    // A run another live process is doing is not interrupted; one left by a stopped process is.
    if (lockHolder(cfg) === null) this.runs.failInterrupted(new Date());
  }

  get enabled(): boolean {
    return Boolean(this.cfg.expenses);
  }

  runningId(): string | null {
    return this.active?.id ?? null;
  }

  /** Starts a run in the background and returns its id at once. */
  start(trigger: ExpenseRun["trigger"]): { ok: true; runId: string; done: Promise<ExpenseRun> } | { ok: false; status: number; error: string } {
    if (!this.enabled) return { ok: false, status: 503, error: 'The expenses agent is not set up: add the "expenses" section to config.json.' };
    if (this.active) return { ok: false, status: 409, error: "A run is already in progress." };
    if (!takeLock(this.cfg)) return { ok: false, status: 409, error: "A run is already in progress in another process (the service or a terminal)." };
    let agent: ExpenseAgent;
    try {
      agent = this.factory();
    } catch (err) {
      releaseLock(this.cfg);
      return { ok: false, status: 503, error: err instanceof Error ? err.message : String(err) };
    }
    const run = agent.newRun(trigger);
    const done = agent.run(trigger, run).finally(() => {
      this.active = null;
      releaseLock(this.cfg);
    });
    this.active = { id: run.id, done };
    return { ok: true, runId: run.id, done };
  }

  setInclude(runId: string, n: number, include: boolean): ExpenseRun {
    const run = this.idle(runId);
    return this.factoryOrThrow().setInclude(run, n, include);
  }

  async redraft(runId: string): Promise<ExpenseRun> {
    const run = this.idle(runId);
    return this.factoryOrThrow().redraft(run);
  }

  private factoryOrThrow(): ExpenseAgent {
    return this.factory();
  }

  private idle(runId: string): ExpenseRun {
    const run = this.runs.get(runId);
    if (!run) throw new NotFound("No such run");
    if (run.status === "running" || this.active?.id === runId) throw new Busy("This run is still in progress.");
    return run;
  }

  async stop(): Promise<void> {
    await this.active?.done.catch(() => undefined);
  }
}

export class NotFound extends Error {}
export class Busy extends Error {}
