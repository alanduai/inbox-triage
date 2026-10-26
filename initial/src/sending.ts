import { createHmac } from "node:crypto";
import type { LoadedConfig } from "./config.js";
import { isPlainAddress } from "./gmail/mime.js";
import { isAdversarial, isOwner, matchContact, needsReview, normalizeEmail } from "./scope.js";
import type { Item } from "./store/db.js";

export type SendKind = "reply" | "ack" | "draft";

export interface SendRequest {
  kind: SendKind;
  to: string[];
  cc: string[];
  text: string;
}

export interface SendCheck {
  // Reasons it cannot go at all.
  blockers: string[];
  // Reasons it needs your second confirmation, with the recipients shown.
  confirm: string[];
}

const MAX_RECIPIENTS = 20;
// The draft leaves facts only you know in [brackets]; a reply with one left in is never sent.
const BRACKETS = /\[[^\]\n]{1,80}\]/;

/** Recipients as given, trimmed and lowercased, without empty entries or repeats. */
export function cleanRecipients(list: string[]): string[] {
  const seen = new Set<string>();
  return list.map(normalizeEmail).filter((e) => e !== "" && !seen.has(e) && (seen.add(e), true));
}

/**
 * The rules every send passes, enforced by the server whatever the page does. A Gmail draft
 * sends nothing, so it is only checked for a body and valid addresses.
 */
export function checkSend(cfg: LoadedConfig, item: Item, req: SendRequest): SendCheck {
  const blockers: string[] = [];
  const confirm: string[] = [];
  const to = cleanRecipients(req.to);
  const cc = cleanRecipients(req.cc);
  const all = [...to, ...cc.filter((e) => !to.includes(e))];
  const contact = matchContact(cfg, item.fromEmail)?.contact;
  const review = Boolean(item.triage?.review_required) || Boolean(contact && needsReview(contact)) || item.senderVerified === false;

  if (!req.text.trim()) blockers.push("The reply is empty.");
  if (!to.length) blockers.push("Add at least one recipient in To.");
  const bad = all.filter((e) => !isPlainAddress(e));
  if (bad.length) blockers.push(`Not a valid address: ${bad.join(", ")}`);
  if (all.length > MAX_RECIPIENTS) blockers.push(`At most ${MAX_RECIPIENTS} recipients.`);
  if (req.kind === "draft") return { blockers, confirm };

  const left = req.text.match(BRACKETS);
  if (left) blockers.push(`Fill in or remove ${left[0]} first: it marks a fact only you know.`);
  if (req.kind === "ack" && (!item.triage?.ack_reply || review || (contact && isAdversarial(contact.role)))) {
    blockers.push("This message gets no quick acknowledgement: write a reply instead.");
  }

  if (item.senderVerified === false) confirm.push(`Gmail could not verify that this came from ${item.fromEmail}.`);
  else if (review) confirm.push("This message is marked review required.");
  const original = new Set(cleanRecipients([item.fromEmail, item.replyToEmail, ...item.to, ...item.cc]));
  const counsel = cfg.projects.find((p) => p.id === item.projectId)?.counsel?.email;
  for (const e of all) {
    if (isOwner(cfg, e)) continue;
    const m = matchContact(cfg, e);
    if (m && isAdversarial(m.contact.role)) {
      confirm.push(`${e} is ${m.contact.role === "court" ? "the court" : "the other side's lawyer"}.`);
      continue;
    }
    if (original.has(e) || (counsel && normalizeEmail(counsel) === e)) continue;
    if (!m) confirm.push(`${e} was not on the original message and is not a contact of this matter.`);
    else if (m.project.id !== item.projectId) confirm.push(`${e} is a contact of the other matter (${m.project.name}).`);
  }
  return { blockers, confirm };
}

/**
 * Binds a second confirmation to exactly what you were shown: change a recipient or a word and
 * it has to be confirmed again.
 */
export function confirmToken(secret: string, itemId: string, req: SendRequest): string {
  const payload = JSON.stringify([itemId, req.kind, cleanRecipients(req.to).sort(), cleanRecipients(req.cc).sort(), req.text]);
  return createHmac("sha256", secret).update(payload).digest("hex");
}
