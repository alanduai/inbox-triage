#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { dataPath, defaultConfigPath, loadConfig, type LoadedConfig } from "./config.js";
import { doctor, printReport } from "./doctor.js";
import { authorizedClient, runAuthFlow, tokenCanSend } from "./gmail/auth.js";
import { GmailReader } from "./gmail/client.js";
import { GmailSender } from "./gmail/sender.js";
import { VaultWriter } from "./obsidian/writer.js";
import { Outbox } from "./outbox.js";
import { Pipeline } from "./pipeline.js";
import { sendTest } from "./sendtest.js";
import { createServer } from "./server/server.js";
import { Store } from "./store/db.js";
import { anthropicApiKey } from "./util/secrets.js";
import { log } from "./util/time.js";

const HELP = `inbox-triage <command>

  init              create config.json from the example and the private data folder
  auth              sign in to Gmail (read-only) and store the token
  doctor [--online] check the setup on this machine; --online also tests Gmail and Claude
  send-test         send two test messages to yourself and check threading, headers and encoding
  poll              check Gmail once, triage and file new messages, then exit
  run               start the dashboard and check Gmail every few minutes (the service)
  token             print a new dashboard token, for access from your network
`;

function openStore(cfg: LoadedConfig): Store {
  return new Store(dataPath(cfg, "inbox.db"));
}

function vaultWriter(cfg: LoadedConfig): VaultWriter {
  return new VaultWriter(cfg.vault.path, cfg.vault.maxSyncFileMB * 1_000_000, dataPath(cfg, cfg.vault.largeAttachmentDir));
}

function makePipeline(cfg: LoadedConfig, store: Store): { pipeline: Pipeline; outbox: Outbox | null } {
  if (!fs.existsSync(cfg.vault.path)) throw new Error(`Vault not found at ${cfg.vault.path}`);
  const auth = authorizedClient(cfg);
  const gmail = new GmailReader(auth);
  const claude = new Anthropic({ apiKey: anthropicApiKey(cfg) });
  const pipeline = new Pipeline(cfg, store, gmail, claude, vaultWriter(cfg));
  // A read-only (phase 1) sign-in reads as before; the dashboard says sending needs npm run auth.
  const outbox = tokenCanSend(cfg) ? new Outbox({ cfg, store, reader: gmail, sender: new GmailSender(auth), notes: pipeline.notes }) : null;
  return { pipeline, outbox };
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
        const r = await makePipeline(cfg, store).pipeline.pollOnce();
        console.log(`matched ${r.matched}, filed ${r.ingested}, finished earlier ones ${r.refiled}, failed ${r.failed}, closed by your replies ${r.closedByReply}`);
        return r.failed ? 1 : 0;
      } finally {
        store.close();
      }
    }
    case "send-test": {
      const cfg = loadConfig();
      if (!tokenCanSend(cfg)) {
        console.log("The Gmail sign-in is read-only. Run npm run auth to allow sending, then try again.");
        return 1;
      }
      const steps = await sendTest(cfg, new GmailSender(authorizedClient(cfg)));
      for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`);
      const ok = steps.every((s) => s.ok);
      console.log(ok ? "\nAll good. To send from the dashboard, set sending.enabled to true in config.json and restart the service." : "\nSomething did not work: keep sending off and send me the lines above.");
      return ok ? 0 : 1;
    }
    case "run":
      return runService();
    default:
      console.log(HELP);
      return command ? 1 : 0;
  }
}

// A copy of the service that has not renewed its lease for this long is taken to be gone.
const LEASE_STALE_MS = 2 * 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function runService(): Promise<number> {
  const cfg = loadConfig();
  const store = openStore(cfg);
  // One copy per data folder, whatever its port: a second copy stops before touching anything.
  const lease = store.acquireLease(process.pid, LEASE_STALE_MS, processAlive);
  if (!lease.ok) {
    store.close();
    throw new Error(`Another copy of the service is running (process ${lease.holder}). Stop it first, or wait two minutes if it was killed.`);
  }
  let pipeline: Pipeline | null = null;
  let outbox: Outbox | null = null;
  let lastPoll: { at: string; ok: boolean; message: string } | null = null;
  try {
    ({ pipeline, outbox } = makePipeline(cfg, store));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Gmail checks are off: ${message}. The dashboard still runs.`);
    lastPoll = { at: new Date().toISOString(), ok: false, message };
  }

  const server = createServer({ cfg, store, pipeline, vault: vaultWriter(cfg), lastPoll: () => lastPoll, outbox });
  // The port is the guard against a second copy of the service: it is taken before any queued
  // send is touched, and a second copy stops here.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.dashboard.port, cfg.dashboard.host, resolve);
  });
  log(`dashboard on http://${cfg.dashboard.host}:${cfg.dashboard.port}`);
  if (outbox) {
    await outbox.recover().catch((err) => log("could not check sends left from the last run", err));
    log(cfg.sending.enabled ? `sending is on, ${cfg.sending.undoSeconds} seconds to undo` : "sending is off (sending.enabled in config.json)");
  } else if (pipeline) log("sending needs the gmail.modify sign-in: run npm run auth");

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

  // Sends: due ones every second, unknown outcomes and follow-ups every half minute; never two passes at once.
  let sending: Promise<unknown> = Promise.resolve();
  let sendBusy = false;
  let lastMaintain = 0;
  let leaseRenewed = 0;
  const sendTimer = setInterval(() => {
    if (Date.now() - leaseRenewed > 20_000) {
      leaseRenewed = Date.now();
      if (!store.renewLease(process.pid)) {
        // Another copy took over (this one was stalled for minutes): stop sending and exit.
        log("another copy of the service took over; stopping");
        process.kill(process.pid, "SIGTERM");
        return;
      }
    }
    if (!outbox || stopping || sendBusy) return;
    sendBusy = true;
    const maintain = Date.now() - lastMaintain > 30_000;
    if (maintain) lastMaintain = Date.now();
    sending = (maintain ? outbox.maintain().then(() => outbox!.tick()) : outbox.tick())
      .catch((err) => log("send check failed", err))
      .finally(() => (sendBusy = false));
  }, 1000);

  await new Promise<void>((resolve) => {
    const stop = () => {
      stopping = true;
      if (timer) clearTimeout(timer);
      clearInterval(sendTimer);
      // Let a poll or a send in progress finish (at most a minute), so nothing is left half-done.
      const grace = new Promise((r) => setTimeout(r, 60_000).unref());
      void Promise.race([Promise.all([running, sending]), grace]).then(() => server.close(() => resolve()));
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  store.releaseLease(process.pid);
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
