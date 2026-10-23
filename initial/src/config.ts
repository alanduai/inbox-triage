import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ROLES = ["own_lawyer", "court", "opposing_counsel", "bank", "advisor", "other"] as const;
export type Role = (typeof ROLES)[number];

export const LANGUAGES = ["en", "hr", "sv"] as const;
export type Language = (typeof LANGUAGES)[number];

const Contact = z.object({
  // An exact address ("name@firm.se") or a domain ("@firm.se", which also covers subdomains).
  match: z.string().min(3),
  role: z.enum(ROLES).default("other"),
  // Replies need a second confirmation and get no quick acknowledgement (court, the other side's lawyers).
  reviewRequired: z.boolean().default(false),
  // Messages that need a reply from this sender are always raised to "urgent".
  alwaysUrgent: z.boolean().default(false),
});

const Project = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  // Folder inside the vault, for example "Projects/Sweden legal matter".
  folder: z
    .string()
    .min(1)
    .refine((f) => !f.startsWith("/") && !f.split(/[\\/]/).some((part) => part === ".." || part === "."), {
      message: 'must be a path inside the vault, such as "Projects/Name", without ".." or a leading "/"',
    }),
  // Your own lawyer for this matter. Suggested replies to mail from the court or the other side
  // go to this person instead of the sender, whether you are in To or only in cc.
  counsel: z
    .object({ name: z.string(), email: z.string(), language: z.enum(LANGUAGES).default("en") })
    .optional(),
  contacts: z.array(Contact).min(1),
});

const ConfigSchema = z.object({
  owner: z.object({
    name: z.string(),
    // Every address that is you. Messages from these count as your replies.
    emails: z.array(z.string()).min(1),
  }),
  // IANA time zone; defaults to the machine's own.
  timezone: z.string().optional(),
  vault: z.object({
    path: z.string(),
    // What Obsidian shows under Settings → Sync for this remote vault. Reported by `doctor`.
    syncEncryption: z.enum(["unknown", "end-to-end", "standard"]).default("unknown"),
    // Per-file limit of your Obsidian Sync plan: 200 on Plus, 5 on Standard.
    maxSyncFileMB: z.number().positive().default(200),
    // Where attachments over the limit go instead (outside the vault). Relative to the data dir.
    largeAttachmentDir: z.string().default("large-attachments"),
  }),
  gmail: z.object({
    account: z.string(),
    pollSeconds: z.number().int().min(30).default(60),
    initialLookbackDays: z.number().int().min(1).max(30).default(3),
    oauthClientFile: z.string().default("google-oauth-client.json"),
    tokenFile: z.string().default("gmail-token.json"),
  }),
  claude: z
    .object({
      model: z.string().default("claude-opus-5-5"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
      // "env" reads ANTHROPIC_API_KEY; "keychain" reads the macOS Keychain item below.
      apiKeySource: z.enum(["env", "keychain"]).default("keychain"),
      keychainService: z.string().default("inbox-triage-anthropic"),
    })
    .default({ model: "claude-opus-5-5", effort: "high", apiKeySource: "keychain", keychainService: "inbox-triage-anthropic" }),
  // Email sign-off per reply language. WhatsApp replies get none.
  signOffs: z.record(z.enum(LANGUAGES), z.string()),
  projects: z.array(Project).min(1),
  dashboard: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(8787),
      // Required when host is not a loopback address. Generate one with `inbox-triage token`.
      token: z.string().min(24).optional(),
    })
    .default({ host: "127.0.0.1", port: 8787 }),
  // Message store, tokens and logs. Relative to the config file.
  dataDir: z.string().default("data"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProjectConfig = z.infer<typeof Project>;
export type ContactConfig = z.infer<typeof Contact>;

export interface LoadedConfig extends Config {
  configPath: string;
  dataDirAbs: string;
  tz: string;
}

export function defaultConfigPath(): string {
  return process.env.INBOX_TRIAGE_CONFIG ?? path.resolve(process.cwd(), "config.json");
}

export function parseConfig(raw: unknown, configPath: string): LoadedConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid config in ${configPath}:\n${issues}`);
  }
  const cfg = result.data;
  const base = path.dirname(configPath);
  const ids = new Set<string>();
  for (const p of cfg.projects) {
    if (ids.has(p.id)) throw new Error(`Duplicate project id "${p.id}" in ${configPath}`);
    ids.add(p.id);
  }
  if (!isLoopback(cfg.dashboard.host) && !cfg.dashboard.token) {
    throw new Error(`dashboard.token is required when dashboard.host is ${cfg.dashboard.host} (reachable from your network)`);
  }
  return {
    ...cfg,
    configPath,
    dataDirAbs: path.resolve(base, cfg.dataDir),
    tz: cfg.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function loadConfig(configPath = defaultConfigPath()): LoadedConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`No config at ${configPath}. Copy config.example.json to config.json and fill it in.`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  return parseConfig(raw, configPath);
}

export function dataPath(cfg: LoadedConfig, file: string): string {
  return path.resolve(cfg.dataDirAbs, file);
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
