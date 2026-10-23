import test from "node:test";
import assert from "node:assert/strict";
import { gmailLink, hexToDecimal } from "../src/gmail/links.js";

test("hex ids convert to the decimals Gmail's web app uses", () => {
  // Pairs read from a real Gmail account's web links.
  assert.equal(hexToDecimal("19c421a3b46d9a6b"), "1856645933373954667");
  assert.equal(hexToDecimal("1a16620ba0e0b41f"), "1879797696557003807");
  assert.equal(hexToDecimal("1a1697ba983dd026"), "1879856722147659814");
  assert.throws(() => hexToDecimal("thread-a:r123"));
});

test("threads started by others link to thread and message", () => {
  const url = gmailLink({ account: "me@example.com", threadId: "19c421a3b46d9a6b", messageId: "1a1697ba983dd026", threadIdIsMessageId: true });
  assert.equal(url, "https://mail.google.com/mail/?authuser=me%40example.com#all/thread-f:1856645933373954667|msg-f:1879856722147659814");
});

test("threads you started fall back to a Message-ID search", () => {
  const url = gmailLink({
    account: "me@example.com",
    threadId: "1a15e7e4f8050000",
    messageId: "1a167cc78ac5f6c2",
    rfc822MessageId: "<abc.123@mail.example>",
    threadIdIsMessageId: false,
  });
  assert.equal(url, "https://mail.google.com/mail/?authuser=me%40example.com#search/rfc822msgid%3Aabc.123%40mail.example");
});
