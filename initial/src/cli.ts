#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { dataPath, defaultConfigPath, loadConfig, type LoadedConfig } from "./config.js";
import { doctor, printReport } from "./doctor.js";
import { authorizedClient, runAuthFlow } from "./gmail/auth.js";
import { GmailReader } from "./gmail/client.js";
import { VaultWriter } from "./obsidian/writer.js";
import { Pipeline } from "./pipeline.js";
import { createServer } from "./server/server.js";
import { Store } from "./store/db.js";
import { anthropicApiKey } from "./util/secrets.js";
import { EXPENSES_GMAIL_SCOPES } from "./gmail/auth.js";
import { expensesConfig, monthName } from "./expenses/agent.js";
import { PORTAL_IDS, type PortalId } from "./expenses/config.js";
import { PORTALS } from "./expenses/portals/guard.js";
import { ExpenseService, profileDir, setupChecks } from "./expenses/service.js";
import { log } from "./util/time.js";

const HELP = `inbox-triage <command>

  init              create config.json from the example and the private data folder
  auth              sign in to Gmail (read-only) and store the token
  doctor [--online] check the setup on this machine; --online also tests Gmail and Claude
  poll              check Gmail once, triage and file new messages, then exit
  run               start the dashboard and check Gmail every few minutes (the service)
  token             print a new dashboard token, for access from your network

  expenses auth             sign in to Gmail for the expenses agent (read mail, save drafts; never sends)
  expenses login <portal>   sign in to amazon, claude or openai in the agent's own browser profile
  expenses run              run the monthly reconciliation once (also on the dashboard, /expenses)
  expenses status           show the setup checks and the latest run
`;

function openStore(cfg: LoadedConfig): Store {
  return new Store(dataPath(cfg, "inbox.db"));
}

function vaultWriter(cfg: LoadedConfig): VaultWriter {
  return new VaultWriter(cfg.vault.path, cfg.vault.maxSyncFileMB * 1_000_000, dataPath(cfg, cfg.vault.largeAttachmentDir));
}

function makePipeline(cfg: LoadedConfig, store: Store): Pipeline {
  if (!fs.existsSync(cfg.vault.path)) throw new Error(`Vault not found at ${cfg.vault.path}`);
  const gmail = new GmailReader(authorizedClient(cfg));
  const claude = new Anthropic({ apiKey: anthropicApiKey(cfg) });
  return new Pipeline(cfg, store, gmail, claude, vaultWriter(cfg));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init": {
      const target = defaultConfigPath();
      const example = path.resolve(path.dirname(target), "config.example.json");
      if (fs.existsSync(target)) console.log(`${target} already exists; left as it is.`);
      else {
        fs.copyFileSync(example, target);
        fs.chmodSync(target, 0o600);
        console.log(`Created ${target}. Fill it in, then run: npm run doctor`);
      }
      fs.mkdirSync(path.resolve(path.dirname(target), "data"), { recursive: true, mode: 0o700 });
      return 0;
    }
    case "token":
      console.log(randomBytes(24).toString("base64url"));
      return 0;
    case "auth": {
      const cfg = loadConfig();
      const scopes = await runAuthFlow(cfg);
      console.log(`Gmail authorized with: ${scopes.join(", ")}`);
      return 0;
    }
    case "doctor": {
      const report = await doctor(loadConfig(), { online: rest.includes("--online") });
      printReport(report);
      return report.checks.some((c) => c.level === "fail") ? 1 : 0;
    }
    case "poll": {
      const cfg = loadConfig();
      const store = openStore(cfg);
      try {
        const r = await makePipeline(cfg, store).pollOnce();
        console.log(`matched ${r.matched}, filed ${r.ingested}, finished earlier ones ${r.refiled}, failed ${r.failed}, closed by your replies ${r.closedByReply}`);
        return r.failed ? 1 : 0;
      } finally {
        store.close();
      }
    }
    case "run":
      return runService();
    case "expenses":
      return expensesCommand(rest);
    default:
      console.log(HELP);
      return command ? 1 : 0;
  }
}

async function expensesCommand(args: string[]): Promise<number> {
  const [sub, arg] = args;
  const cfg = loadConfig();
  const x = expensesConfig(cfg);
  switch (sub) {
    case "auth": {
      const account = x.gmail.account ?? cfg.gmail.account;
      const scopes = await runAuthFlow(cfg, { scopes: EXPENSES_GMAIL_SCOPES, tokenFile: x.gmail.tokenFile, account });
      console.log(`Gmail authorized for the expenses agent with: ${scopes.join(", ")}`);
      return 0;
    }
    case "login": {
      if (!PORTAL_IDS.includes(arg as PortalId)) {
        console.log(`Which portal? npm run expenses -- login <${PORTAL_IDS.join("|")}>`);
        return 1;
      }
      const portal = PORTALS[arg as PortalId];
      const { chromium } = await import("playwright");
      const dir = profileDir(cfg);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const context = await chromium.launchPersistentContext(dir, { headless: false, channel: x.browser.channel, executablePath: x.browser.executablePath, viewport: null });
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto((x.portals[arg as PortalId] ?? portal.startUrls)[0]!).catch(() => undefined);
      console.log(`Sign in to ${portal.name} in the browser window${arg === "amazon" ? " with the Bea Nekretnine account" : ""}, then close the window.`);
      await new Promise<void>((resolve) => context.on("close", () => resolve()));
      console.log("Saved. The agent uses this sign-in from now on.");
      return 0;
    }
    case "run": {
      const svc = new ExpenseService(cfg);
      const started = svc.start("cli");
      if (!started.ok) {
        console.error(started.error);
        return 1;
      }
      console.log(`Run ${started.runId} started.`);
      const run = await started.done;
      for (const s of run.steps) console.log(`${s.level === "info" ? " " : s.level === "warn" ? "!" : "✗"} ${s.text}`);
      return run.status === "failed" ? 1 : 0;
    }
    case "status": {
      for (const c of setupChecks(cfg)) console.log(`${c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✗"} ${c.name}: ${c.detail}`);
      const last = new ExpenseService(cfg).runs.list(1)[0];
      console.log(last ? `\nLatest run ${last.id} (${last.period ? monthName(last.period) : "no month"}): ${last.status}. ${last.summary}` : "\nNo runs yet.");
      return 0;
    }
    default:
      console.log(HELP);
      return sub ? 1 : 0;
  }
}

async function runService(): Promise<number> {
  const cfg = loadConfig();
  const store = openStore(cfg);
  let pipeline: Pipeline | null = null;
  let lastPoll: { at: string; ok: boolean; message: string } | null = null;
  try {
    pipeline = makePipeline(cfg, store);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Gmail checks are off: ${message}. The dashboard still runs.`);
    lastPoll = { at: new Date().toISOString(), ok: false, message };
  }

  const expenses = cfg.expenses ? new ExpenseService(cfg) : null;
  const server = createServer({ cfg, store, pipeline, vault: vaultWriter(cfg), lastPoll: () => lastPoll, expenses });
  await new Promise<void>((resolve) => server.listen(cfg.dashboard.port, cfg.dashboard.host, resolve));
  log(`dashboard on http://${cfg.dashboard.host}:${cfg.dashboard.port}`);

  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  let running: Promise<unknown> = Promise.resolve();
  const tick = async () => {
    if (!pipeline || stopping) return;
    try {
      const poll = pipeline.pollOnce();
      running = poll.catch(() => undefined);
      const r = await poll;
      lastPoll = {
        at: new Date().toISOString(),
        ok: r.failed === 0,
        message: `${r.ingested} new, ${r.refiled} finished, ${r.failed} failed, ${r.closedByReply} closed by your replies`,
      };
      if (r.ingested || r.failed || r.refiled || r.closedByReply) log(`poll: ${lastPoll.message}`);
    } catch (err) {
      lastPoll = { at: new Date().toISOString(), ok: false, message: err instanceof Error ? err.message : String(err) };
      log("poll failed", err);
    } finally {
      if (!stopping) timer = setTimeout(tick, cfg.gmail.pollSeconds * 1000);
    }
  };
  void tick();

  await new Promise<void>((resolve) => {
    const stop = () => {
      stopping = true;
      if (timer) clearTimeout(timer);
      // Let a poll in progress finish its note (at most a minute), so nothing is left half-filed.
      const grace = new Promise((r) => setTimeout(r, 60_000).unref());
      void Promise.race([Promise.all([running, expenses?.stop()]), grace]).then(() => server.close(() => resolve()));
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  store.close();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
