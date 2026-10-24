import test from "node:test";
import assert from "node:assert/strict";
import { decodeEncodedWords, htmlToText, isNoiseAttachment, parseAddressList, parseMessage, stripQuoted } from "../src/gmail/parse.js";
import { b64url } from "./helpers.js";

test("address lists keep quoted names with commas", () => {
  assert.deepEqual(parseAddressList('"Holm, Elin" <Elin@LawFirm.example>, bank@bank.example'), [
    { name: "Holm, Elin", email: "elin@lawfirm.example" },
    { name: "", email: "bank@bank.example" },
  ]);
});

test("encoded-word headers decode, including Croatian ISO-8859-2", () => {
  assert.equal(decodeEncodedWords("=?UTF-8?B?w4XDpMO2?="), "Åäö");
  assert.equal(decodeEncodedWords("=?iso-8859-2?Q?=A9alje_dokumente?="), "Šalje dokumente");
  assert.equal(decodeEncodedWords("plain subject"), "plain subject");
});

test("quoted history is dropped in English, Swedish and Croatian", () => {
  assert.equal(stripQuoted("Thanks, see below.\n\nOn Mon, 19 Oct 2026 at 10:00, Elin wrote:\n> old"), "Thanks, see below.");
  assert.equal(stripQuoted("Hej!\n\nDen 23 okt. 2026 kl. 10:12 skrev Elin Holm <elin@x.se>:\n> gammalt"), "Hej!");
  assert.equal(stripQuoted("Poštovani,\nšaljem.\n\nDana 22. 10. 2026. u 9:00 Marija je napisala:\n> staro"), "Poštovani,\nšaljem.");
  assert.equal(stripQuoted("New text\n\nFrom: Bank <a@b.c>\nSent: Monday\nTo: me\nSubject: RE: Dokumenti\n\nold"), "New text");
  assert.equal(stripQuoted("> only a quote"), "> only a quote");
});

test("html becomes readable text", () => {
  assert.equal(htmlToText("<style>p{}</style><p>Hi&nbsp;Alan,</p><p>Line&amp;two<br>three</p><ul><li>a</li></ul>"), "Hi Alan,\nLine&two\nthree\n\n- a");
});

test("a Gmail payload parses headers, charset, text and attachments", () => {
  const latin2 = Buffer.from([0x50, 0x6f, 0xa9, 0x74, 0x6f, 0x76, 0x61, 0x6e, 0x69]); // "PoŠtovani" in ISO-8859-2
  const parsed = parseMessage({
    id: "1a1697ba983dd026",
    threadId: "19c421a3b46d9a6b",
    internalDate: String(Date.UTC(2026, 9, 23, 8, 14)),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Marija Novak <marija@bank.example>" },
        { name: "To", value: "me@example.com" },
        { name: "Cc", value: "Advisor <a@advisor.example>" },
        { name: "Subject", value: "=?UTF-8?Q?Podsjetnik:_dokumenti?=" },
        { name: "Message-ID", value: "<m1@bank.example>" },
      ],
      parts: [
        { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-2" }], body: { data: b64url(latin2) } },
        { mimeType: "application/pdf", filename: "Izjava.pdf", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { attachmentId: "att1", size: 120000 } },
        { mimeType: "image/png", filename: "logo.png", headers: [{ name: "Content-ID", value: "<logo>" }], body: { attachmentId: "att2", size: 2000 } },
      ],
    },
  });
  assert.equal(parsed.subject, "Podsjetnik: dokumenti");
  assert.equal(parsed.text, "PoŠtovani");
  assert.equal(parsed.from.email, "marija@bank.example");
  assert.deepEqual(parsed.cc.map((a) => a.email), ["a@advisor.example"]);
  assert.equal(parsed.attachments.length, 2);
  assert.equal(isNoiseAttachment(parsed.attachments[0]!), false);
  assert.equal(isNoiseAttachment(parsed.attachments[1]!), true);
});
