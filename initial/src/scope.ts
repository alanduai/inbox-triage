import type { ContactConfig, Language, LoadedConfig, ProjectConfig } from "./config.js";

export interface ScopeMatch {
  project: ProjectConfig;
  contact: ContactConfig;
}

export interface ReplyRoute {
  name: string;
  email: string;
  // True when the reply goes to someone other than the sender (your own lawyer).
  redirected: boolean;
  language?: Language;
}

export function normalizeEmail(address: string): string {
  return address.trim().toLowerCase();
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1);
}

/** "@firm.se" matches x@firm.se and x@mail.firm.se; "name@firm.se" matches only itself. */
export function contactMatches(email: string, pattern: string): boolean {
  const e = normalizeEmail(email);
  const p = normalizeEmail(pattern);
  if (!p.startsWith("@")) return e === p;
  const domain = domainOf(e);
  const want = p.slice(1);
  return domain === want || domain.endsWith("." + want);
}

/** The most specific contact rule for an address: an exact address beats a domain, a longer domain beats a shorter one. */
export function matchContact(cfg: Pick<LoadedConfig, "projects">, email: string): ScopeMatch | null {
  let best: ScopeMatch | null = null;
  let bestRank = -1;
  for (const project of cfg.projects) {
    for (const contact of project.contacts) {
      if (!contactMatches(email, contact.match)) continue;
      const rank = contact.match.startsWith("@") ? contact.match.length : 10_000;
      if (rank > bestRank) {
        best = { project, contact };
        bestRank = rank;
      }
    }
  }
  return best;
}

export function isOwner(cfg: Pick<LoadedConfig, "owner">, email: string): boolean {
  const e = normalizeEmail(email);
  return cfg.owner.emails.some((o) => normalizeEmail(o) === e);
}

/** You are "only in cc" when none of your addresses is in To but one is in Cc. */
export function isOnlyCc(cfg: Pick<LoadedConfig, "owner">, to: string[], cc: string[]): boolean {
  const inTo = to.some((a) => isOwner(cfg, a));
  const inCc = cc.some((a) => isOwner(cfg, a));
  return !inTo && inCc;
}

/** Mail from the court or the other side is answered through your own lawyer, never directly. */
export function replyRoute(match: ScopeMatch, sender: { name: string; email: string }): ReplyRoute {
  const { project, contact } = match;
  if ((contact.role === "court" || contact.role === "opposing_counsel") && project.counsel) {
    return { name: project.counsel.name, email: project.counsel.email, redirected: true, language: project.counsel.language };
  }
  return { name: sender.name || sender.email, email: sender.email, redirected: false };
}

/** Gmail search for every in-scope sender. Results are filtered again with matchContact. */
export function gmailScopeQuery(cfg: Pick<LoadedConfig, "projects">, sinceEpochSeconds?: number, lookbackDays = 3): string {
  const terms = new Set<string>();
  for (const project of cfg.projects) {
    for (const contact of project.contacts) {
      const m = normalizeEmail(contact.match);
      terms.add(m.startsWith("@") ? m.slice(1) : m);
    }
  }
  const from = `from:(${[...terms].sort().join(" OR ")})`;
  const when = sinceEpochSeconds ? `after:${Math.floor(sinceEpochSeconds)}` : `newer_than:${lookbackDays}d`;
  // The API searches all mail, so messages another client archived are still found; spam and trash are not.
  return `${from} ${when} -from:me`;
}
