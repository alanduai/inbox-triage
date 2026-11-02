import type { PortalId, VendorConfig } from "./config.js";

export interface VendorProfile {
  id: string;
  name: string;
  // Lowercase text that identifies the vendor in Ivana's list or a bank statement line.
  aliases: string[];
  // Domains ("@notion.so") or addresses its receipts are sent from.
  senders: string[];
  // Words its receipts contain; searched together with receipt words.
  keywords: string[];
  // Where to look when Gmail has nothing.
  portal?: PortalId;
}

/**
 * The subscriptions and shops that recur every month. Sender domains are a starting point for the
 * Gmail search, not a filter: receipts are also found by name, so a vendor that changes its
 * sending domain is still found. Extend or override them under `expenses.vendors` in config.json.
 */
export const DEFAULT_VENDORS: VendorProfile[] = [
  { id: "granola", name: "Granola", aliases: ["granola"], senders: ["@granola.ai", "@granola.so"], keywords: ["Granola"] },
  { id: "wispr-flow", name: "Wispr Flow", aliases: ["wispr", "wisprflow", "wispr flow"], senders: ["@wisprflow.ai", "@wispr.ai"], keywords: ["Wispr"] },
  { id: "notion", name: "Notion", aliases: ["notion"], senders: ["@notion.so", "@makenotion.com", "@mail.notion.so"], keywords: ["Notion"] },
  { id: "claude", name: "Claude (Anthropic)", aliases: ["claude", "anthropic"], senders: ["@anthropic.com", "@mail.anthropic.com"], keywords: ["Anthropic", "Claude"], portal: "claude" },
  { id: "openai", name: "OpenAI", aliases: ["openai", "open ai", "chatgpt", "chat gpt"], senders: ["@openai.com", "@tm.openai.com", "@email.openai.com"], keywords: ["OpenAI", "ChatGPT"], portal: "openai" },
  { id: "amazon", name: "Amazon", aliases: ["amazon", "amzn"], senders: ["@amazon.de", "@amazon.com", "@amazon.eu"], keywords: ["Amazon"], portal: "amazon" },
];

/** Built-in vendors with the ones from config added; a config entry with a built-in id replaces it. */
export function vendorList(extra: VendorConfig[]): VendorProfile[] {
  const byId = new Map(DEFAULT_VENDORS.map((v) => [v.id, v] as const));
  for (const v of extra) {
    byId.set(v.id, {
      id: v.id,
      name: v.name,
      aliases: v.aliases.length ? v.aliases : [v.name.toLowerCase()],
      senders: v.senders,
      keywords: v.keywords.length ? v.keywords : [v.name],
      portal: v.portal,
    });
  }
  return [...byId.values()];
}

function words(s: string): string {
  return ` ${s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** The known vendor a line of Ivana's list names, or null. The longest alias that matches wins. */
export function resolveVendor(text: string, vendors: VendorProfile[]): VendorProfile | null {
  const hay = words(text);
  const compact = hay.replace(/ /g, "");
  let best: { v: VendorProfile; len: number } | null = null;
  for (const v of vendors) {
    for (const alias of v.aliases) {
      const a = words(alias);
      // Whole words ("amzn mktp" names Amazon), or glued together as on statements ("WISPRFLOW.AI").
      const hit = hay.includes(a) || (a.trim().length >= 5 && compact.includes(a.replace(/ /g, "")));
      if (hit && (!best || a.length > best.len)) best = { v, len: a.length };
    }
  }
  return best?.v ?? null;
}

/** A profile for a vendor that is not in the list: found by its name only, never on a portal. */
export function adHocVendor(name: string): VendorProfile {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 60) || "Unknown vendor";
  const id = `other-${clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "vendor"}`;
  return { id, name: clean, aliases: [clean.toLowerCase()], senders: [], keywords: [clean] };
}
