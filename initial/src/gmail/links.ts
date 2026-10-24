/**
 * Links that open a message in Gmail's web app.
 *
 * Gmail's web app addresses a thread as `thread-f:<decimal>` and a message as `msg-f:<decimal>`,
 * where the decimal is the Gmail API's hex id converted to base 10. This only holds for threads
 * whose id is also the id of one of their messages (threads started by someone else). Threads you
 * started use a different web id that the API does not expose, so those links fall back to a
 * Gmail search for the message's own Message-ID header: a results view holding only that message.
 */

export function hexToDecimal(hex: string): string {
  if (!/^[0-9a-f]+$/i.test(hex)) throw new Error(`Not a Gmail hex id: ${hex}`);
  return BigInt("0x" + hex).toString(10);
}

function base(account: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}`;
}

export interface LinkInput {
  account: string;
  threadId: string;
  messageId: string;
  // Message-ID header, with or without angle brackets.
  rfc822MessageId?: string;
  // Whether some message in the thread has the thread's own id.
  threadIdIsMessageId: boolean;
}

export function gmailLink(input: LinkInput): string {
  if (input.threadIdIsMessageId) {
    return `${base(input.account)}#all/thread-f:${hexToDecimal(input.threadId)}|msg-f:${hexToDecimal(input.messageId)}`;
  }
  const rfc = (input.rfc822MessageId ?? "").trim().replace(/^<|>$/g, "");
  if (rfc) return `${base(input.account)}#search/${encodeURIComponent("rfc822msgid:" + rfc)}`;
  return `${base(input.account)}#all/msg-f:${hexToDecimal(input.messageId)}`;
}
