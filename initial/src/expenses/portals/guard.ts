import type { PortalId } from "../config.js";

export interface PortalDef {
  id: PortalId | "test";
  name: string;
  // Hosts the browser may open, with their subdomains. Everything else is refused.
  hosts: string[];
  // Sign-in hosts: reaching one means the session expired, so the run stops for that portal.
  signInHosts: string[];
  signInPaths: RegExp[];
  startUrls: string[];
  // A few facts about the portal's pages, given to Claude as hints.
  hints: string;
}

export const PORTALS: Record<PortalId, PortalDef> = {
  amazon: {
    id: "amazon",
    name: "Amazon.de",
    hosts: ["amazon.de", "amazonaws.com", "media-amazon.com", "ssl-images-amazon.com"],
    signInHosts: [],
    signInPaths: [/\/ap\/(signin|mfa|cvf|challenge)/i],
    startUrls: ["https://www.amazon.de/gp/css/order-history"],
    hints:
      "Order history lists orders by date with their total. Each order has a link to its invoice ('Rechnung' or 'Rechnungen', sometimes under 'Rechnung anzeigen'), which is a PDF; marketplace sellers sometimes issue their own invoice there. An order summary ('Bestellübersicht', 'Bestelldetails') is a fallback when no invoice exists. The year or time range can be changed with the filter at the top of the list.",
  },
  claude: {
    id: "claude",
    name: "Claude",
    hosts: ["claude.ai", "anthropic.com", "stripe.com"],
    signInHosts: ["accounts.google.com", "appleid.apple.com"],
    signInPaths: [/^\/login\b/i, /\/auth\b/i, /\/magic-link/i],
    startUrls: ["https://claude.ai/settings/billing"],
    hints:
      "The billing settings list past invoices with links that open the invoice on a Stripe page (invoice.stripe.com), which has 'Download invoice' and 'Download receipt' buttons. API usage is billed in the Claude Console instead (console.anthropic.com, Settings → Billing).",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    hosts: ["openai.com", "chatgpt.com", "stripe.com"],
    signInHosts: ["accounts.google.com", "appleid.apple.com", "login.microsoftonline.com"],
    signInPaths: [/^\/log-?in\b/i, /^\/auth\/login/i, /^\/u\/login/i],
    startUrls: ["https://platform.openai.com/settings/organization/billing/history", "https://chatgpt.com/#settings/Account"],
    hints:
      "API usage invoices are under platform.openai.com billing history, each opening a Stripe invoice page with 'Download invoice' and 'Download receipt'. A ChatGPT subscription is managed from chatgpt.com settings ('Manage' under the plan), which opens a billing page with the invoice history.",
  },
};

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostIn(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

// Pages that change something: buying, paying, cancelling, deleting, signing out, returns.
const BLOCKED_PATHS = [
  /\/checkout/i,
  /\/cart\b/i,
  /\/buy/i,
  /add-?to-?cart/i,
  /\/subscribe\b/i,
  /\/upgrade/i,
  /cancel/i,
  /\/delete/i,
  /\/remove/i,
  /log-?out|sign-?out|logoff/i,
  /\/returns?\b|\/return-|\/orc\//i,
  /payment-?methods?/i,
  /\/redeem|\/gift/i,
  /\/pay\b|\/pay\//i,
];

export type UrlVerdict = { ok: true } | { ok: false; reason: string } | { ok: false; reason: string; signIn: true };

/** Whether the browser may open a URL for this portal. */
export function checkUrl(portal: PortalDef, url: string): UrlVerdict {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "https:" && !(portal.id === "test" && u.protocol === "http:")) return { ok: false, reason: "only https pages are opened" };
  const host = u.hostname.toLowerCase();
  if (isSignInUrl(portal, url)) return { ok: false, reason: "this is a sign-in page", signIn: true };
  if (!hostIn(host, portal.hosts)) return { ok: false, reason: `${host} is not one of this portal's sites` };
  const target = `${u.pathname}${u.search}`;
  if (BLOCKED_PATHS.some((re) => re.test(target))) return { ok: false, reason: "that page can change the account (buy, pay, cancel, delete, sign out or return)" };
  return { ok: true };
}

export function isSignInUrl(portal: PortalDef, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (hostIn(host, portal.signInHosts)) return true;
  if (/^(auth|login|signin|accounts?)\./.test(host) && hostIn(host, portal.hosts)) return true;
  return hostIn(host, portal.hosts) && portal.signInPaths.some((re) => re.test(u.pathname));
}

// Buttons and links that change something, in English, German and Croatian.
const RISKY_LABELS =
  /\b(buy|kaufen|kauf|bestellen|order now|add to (cart|basket)|in den (einkaufs)?wagen|warenkorb|checkout|zur kasse|pay|bezahlen|zahlen|plati|platiti|subscribe|abonnieren|upgrade|downgrade|change plan|plan (ändern|wechseln)|cancel|kündigen|stornieren|abbrechen|otkaži|delete|löschen|obriši|remove|entfernen|archive|archivieren|sign ?out|log ?out|abmelden|odjava|return|zurücksenden|rücksendung|refund|erstattung|redeem|einlösen|confirm|bestätigen|potvrdi|submit|absenden|send|senden|anfordern|request|contact|kontakt|kupi|save card|karte speichern)\b/i;

/** Whether a button or link label looks like an action that changes the account. */
export function riskyLabel(label: string): boolean {
  return RISKY_LABELS.test(label.normalize("NFC"));
}
