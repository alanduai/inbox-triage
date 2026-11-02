import path from "node:path";
import { z } from "zod";

export const PORTAL_IDS = ["amazon", "claude", "openai"] as const;
export type PortalId = (typeof PORTAL_IDS)[number];

const Email = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s@<>"(),;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/, { message: "must be an email address" });

// A vendor added or changed in config.json. Same shape as the built-in ones in vendors.ts.
const VendorConfig = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  // Lowercase text that identifies the vendor in Ivana's list or on a bank statement ("amzn", "chatgpt").
  aliases: z.array(z.string().trim().toLowerCase().min(2)).default([]),
  // Sender domains or addresses its receipts come from, such as "@notion.so".
  senders: z.array(z.string().trim().toLowerCase()).default([]),
  // Words its receipts always contain, such as the company name.
  keywords: z.array(z.string().trim().min(2)).default([]),
  portal: z.enum(PORTAL_IDS).optional(),
});
export type VendorConfig = z.infer<typeof VendorConfig>;

const Url = z.string().url();

export const ExpensesConfigSchema = z.object({
  company: z.string().default("Bea Nekretnine d.o.o."),
  accountant: z.object({
    name: z.string().default("Ivana Nikolić"),
    // Every address Ivana writes from. Her latest expenses email from any of them is the request.
    emails: z.array(Email).min(1),
    // First line of the reply draft.
    greeting: z.string().default("Pozdrav Ivana,"),
  }),
  gmail: z
    .object({
      // The mailbox that gets Ivana's email and the vendors' receipts. Defaults to gmail.account.
      account: z.string().optional(),
      // A separate token with draft access, so the triage service keeps its read-only one.
      tokenFile: z.string().default("gmail-expenses-token.json"),
    })
    .prefault({}),
  // The folder that holds a folder per month. An absolute path on the Mac mini.
  receiptsDir: z.string().refine((p) => path.isAbsolute(p), { message: "must be an absolute path" }),
  // Each month's folder inside receiptsDir. Tokens: {YYYY} year, {MM} month number, {Month} English
  // name ("October"), {Mjesec} Croatian name ("Listopad"). "/" makes a subfolder. The default gives
  // "2026/10 October": one folder per year, months in calendar order.
  monthFolder: z
    .string()
    .trim()
    .default("{YYYY}/{MM} {Month}")
    .refine((p) => p.includes("{YYYY}") && /\{(MM|Month|Mjesec)\}/.test(p), { message: "must contain {YYYY} and one of {MM}, {Month} or {Mjesec}, so each month of each year has its own folder" })
    .refine((p) => !/\{(?!YYYY\}|MM\}|Month\}|Mjesec\})/.test(p), { message: "only {YYYY}, {MM}, {Month} and {Mjesec} can be used" })
    .refine((p) => !p.startsWith("/") && !p.split(/[\\/]/).some((part) => part === ".." || part === "." || part === ""), { message: 'must stay inside receiptsDir: no leading "/", no "." or ".." and no empty parts' }),
  // How far back to look for Ivana's latest expenses email.
  requestLookbackDays: z.number().int().min(7).max(120).default(45),
  // A receipt is looked for from this many days before the charge date to 3 days after it.
  searchWindowDays: z.number().int().min(1).max(31).default(7),
  // Attachments in one draft, before base64. Gmail's limit is 25 MB including encoding.
  maxAttachmentMB: z.number().positive().max(18).default(18),
  vendors: z.array(VendorConfig).default([]),
  browser: z
    .object({
      // The Amazon.de, Claude and OpenAI fallback. Off means receipts are looked for in Gmail only.
      enabled: z.boolean().default(true),
      // A browser profile used only by this agent, signed in with `expenses login`. Relative to the data dir.
      profileDir: z.string().default("browser-profile"),
      headless: z.boolean().default(true),
      // Browser actions Claude may take per receipt before it gives up.
      maxSteps: z.number().int().min(5).max(60).default(30),
      // "chrome" uses the installed Google Chrome instead of Playwright's Chromium.
      channel: z.string().optional(),
      executablePath: z.string().optional(),
    })
    .prefault({}),
  // Pages the browser starts from, per portal. The defaults are in portals/guard.ts.
  portals: z
    .object({
      amazon: z.array(Url).optional(),
      claude: z.array(Url).optional(),
      openai: z.array(Url).optional(),
    })
    .prefault({}),
  notify: z
    .object({
      // A Notification Center message on the Mac mini when a run ends.
      macos: z.boolean().default(true),
      // Optional push to your phone: an ntfy.sh topic URL that only you know. The message holds counts only.
      ntfyUrl: Url.optional(),
    })
    .prefault({}),
});

export type ExpensesConfig = z.infer<typeof ExpensesConfigSchema>;
