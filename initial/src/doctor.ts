import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { dataPath, isLoopback, type LoadedConfig } from "./config.js";
import { authorizedClient, GMAIL_SCOPES, readToken } from "./gmail/auth.js";
import { GmailReader } from "./gmail/client.js";
import { anthropicApiKey } from "./util/secrets.js";
import { writePrivateFile } from "./util/files.js";

export type Level = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  level: Level;
  detail: string;
}
export interface DoctorReport {
  at: string;
  syncEncryption: string;
  checks: Check[];
}

const isMac = process.platform === "darwin";

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

function nodeVersionOk(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

/** Obsidian keeps enabled core plugins in .obsidian/core-plugins.json: a map of id → on/off, or a list of ids in older versions. */
export function syncPluginEnabled(vaultPath: string): boolean | null {
  const file = path.join(vaultPath, ".obsidian", "core-plugins.json");
  if (!fs.existsSync(file)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(json)) return json.includes("sync");
    if (json && typeof json === "object") return (json as Record<string, unknown>).sync === true;
  } catch {
    return null;
  }
  return null;
}

export async function doctor(cfg: LoadedConfig, opts: { online: boolean }): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (name: string, level: Level, detail: string) => checks.push({ name, level, detail });

  add("Node.js", nodeVersionOk() ? "ok" : "fail", `version ${process.versions.node}${nodeVersionOk() ? "" : "; 22.13 or later is needed for the built-in SQLite"}`);

  // Vault
  const vault = cfg.vault.path;
  if (!fs.existsSync(vault)) {
    add("Vault", "fail", `${vault} does not exist`);
  } else {
    const isVault = fs.existsSync(path.join(vault, ".obsidian"));
    add("Vault", isVault ? "ok" : "warn", isVault ? vault : `${vault} has no .obsidian folder; is this the vault's root?`);
    try {
      const probe = path.join(vault, `.inbox-triage-write-test-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      add("Vault is writable", "ok", "test file written and removed");
    } catch (err) {
      add("Vault is writable", "fail", err instanceof Error ? err.message : String(err));
    }
    for (const p of cfg.projects) {
      const exists = fs.existsSync(path.join(vault, p.folder));
      add(`Folder for ${p.name}`, exists ? "ok" : "warn", exists ? p.folder : `${p.folder} does not exist yet; it is created with the first note`);
    }
    const sync = syncPluginEnabled(vault);
    add(
      "Obsidian Sync plugin",
      sync ? "ok" : "warn",
      sync === null
        ? "could not read .obsidian/core-plugins.json; check Settings → Core plugins → Sync in Obsidian"
        : sync
          ? "listed as on in .obsidian/core-plugins.json"
          : "not listed as on in .obsidian/core-plugins.json; check Settings → Core plugins → Sync in Obsidian",
    );
  }

  const enc = cfg.vault.syncEncryption;
  add(
    "Obsidian Sync encryption",
    enc === "end-to-end" ? "ok" : "warn",
    enc === "unknown"
      ? 'not recorded. In Obsidian on the Mac mini, open Settings → Sync and check whether the remote vault uses end-to-end or standard encryption, then set vault.syncEncryption in config.json'
      : enc === "standard"
        ? "standard: Obsidian's servers can read the notes, including the legal matter. You chose to keep syncing everything"
        : "end-to-end: notes are encrypted before they leave your devices",
  );
  add(
    "Attachment size limit",
    "ok",
    `${cfg.vault.maxSyncFileMB} MB per file (${cfg.vault.maxSyncFileMB >= 200 ? "Obsidian Sync Plus" : "Obsidian Sync Standard"}); larger files go to ${dataPath(cfg, cfg.vault.largeAttachmentDir)}`,
  );

  // Mac mini
  if (isMac) {
    const running = run("pgrep", ["-x", "Obsidian"]);
    add("Obsidian app running", running ? "ok" : "warn", running ? "yes, so Sync carries new notes to your other devices" : "not running: new notes reach your other devices only when Obsidian runs");
    const login = run("osascript", ["-e", 'tell application "System Events" to get the name of every login item']);
    add(
      "Obsidian starts at login",
      login === null ? "warn" : login.includes("Obsidian") ? "ok" : "warn",
      login === null ? "could not read login items (allow Terminal to control System Events, or check System Settings → General → Login Items)" : login.includes("Obsidian") ? "yes" : "no: add Obsidian under System Settings → General → Login Items",
    );
    const fv = run("fdesetup", ["status"]);
    const fvOn = fv?.includes("On") ?? false;
    add(
      "FileVault disk encryption",
      fvOn ? "ok" : "warn",
      fvOn
        ? "on. After a power cut the Mac waits at the unlock screen until someone logs in; the service starts after that"
        : "off: the message store, tokens and legal notes are unencrypted on disk",
    );
    const pm = run("pmset", ["-g"]);
    const sleep = pm?.match(/^\s*sleep\s+(\d+)/m)?.[1];
    add("Sleep", sleep === "0" ? "ok" : "warn", sleep === undefined ? "could not read pmset" : sleep === "0" ? "never sleeps" : `sleeps after ${sleep} minutes; set "Prevent automatic sleeping" in System Settings → Energy`);
    const agent = path.join(process.env.HOME ?? "", "Library", "LaunchAgents", "com.inbox-triage.plist");
    add("Background service", fs.existsSync(agent) ? "ok" : "warn", fs.existsSync(agent) ? "installed (launchd)" : "not installed: run deploy/install-launchd.sh");
  } else {
    add("macOS checks", "warn", "skipped: not running on macOS");
  }

  // Secrets and data
  const dataDir = cfg.dataDirAbs;
  if (fs.existsSync(dataDir)) {
    const mode = fs.statSync(dataDir).mode & 0o777;
    add("Data folder permissions", mode & 0o077 ? "warn" : "ok", mode & 0o077 ? `${dataDir} is readable by others (mode ${mode.toString(8)}); run chmod 700` : `${dataDir} is private`);
  } else add("Data folder", "warn", `${dataDir} does not exist yet; run init`);

  const clientFile = dataPath(cfg, cfg.gmail.oauthClientFile);
  add("Google OAuth client", fs.existsSync(clientFile) ? "ok" : "fail", fs.existsSync(clientFile) ? clientFile : `missing ${clientFile}`);
  const token = readToken(cfg);
  const scopes = (token?.scope ?? "").split(" ").filter(Boolean);
  add(
    "Gmail authorization",
    token?.refresh_token ? "ok" : "fail",
    token?.refresh_token ? `scopes: ${scopes.join(", ") || GMAIL_SCOPES.join(", ")}` : "not authorized: run npm run auth",
  );

  let apiKey: string | null = null;
  try {
    apiKey = anthropicApiKey(cfg);
    add("Anthropic API key", "ok", cfg.claude.apiKeySource === "keychain" ? `in the Keychain (${cfg.claude.keychainService})` : "from ANTHROPIC_API_KEY");
  } catch (err) {
    add("Anthropic API key", "fail", err instanceof Error ? err.message : String(err));
  }

  add(
    "Dashboard access",
    "ok",
    isLoopback(cfg.dashboard.host) ? `this Mac only, at http://127.0.0.1:${cfg.dashboard.port}` : `your network at port ${cfg.dashboard.port}, signed in with the token`,
  );

  if (opts.online) {
    if (token?.refresh_token) {
      try {
        const email = await new GmailReader(authorizedClient(cfg)).profileEmail();
        add("Gmail connection", email.toLowerCase() === cfg.gmail.account.toLowerCase() ? "ok" : "fail", `signed in as ${email}`);
      } catch (err) {
        add("Gmail connection", "fail", err instanceof Error ? err.message : String(err));
      }
    }
    if (apiKey) {
      try {
        const m = await new Anthropic({ apiKey }).models.retrieve(cfg.claude.model);
        add("Claude model", "ok", `${m.id} available`);
      } catch (err) {
        add("Claude model", "fail", err instanceof Error ? err.message : String(err));
      }
    }
  }

  const report: DoctorReport = { at: new Date().toISOString(), syncEncryption: enc, checks };
  if (fs.existsSync(dataDir)) writePrivateFile(dataPath(cfg, "doctor.json"), JSON.stringify(report, null, 2));
  return report;
}

export function printReport(report: DoctorReport): void {
  for (const c of report.checks) console.log(`${c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✗"} ${c.name}: ${c.detail}`);
  const fails = report.checks.filter((c) => c.level === "fail").length;
  const warns = report.checks.filter((c) => c.level === "warn").length;
  console.log(`\n${fails} failing, ${warns} to look at. Obsidian Sync encryption: ${report.syncEncryption}.`);
}
