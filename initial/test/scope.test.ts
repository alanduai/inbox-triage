import test from "node:test";
import assert from "node:assert/strict";
import { contactMatches, gmailScopeQuery, isOnlyCc, matchContact, replyRoute } from "../src/scope.js";
import { testConfig } from "./helpers.js";

const cfg = testConfig();

test("domain rules cover subdomains, exact rules only themselves", () => {
  assert.ok(contactMatches("x@mail.court.example", "@court.example"));
  assert.ok(!contactMatches("x@notcourt.example", "@court.example"));
  assert.ok(contactMatches("Elin@LawFirm.example", "elin@lawfirm.example"));
  assert.ok(!contactMatches("other@lawfirm.example", "elin@lawfirm.example"));
});

test("the most specific rule wins", () => {
  assert.equal(matchContact(cfg, "elin@lawfirm.example")?.contact.alwaysUrgent, true);
  assert.equal(matchContact(cfg, "assistant@lawfirm.example")?.contact.alwaysUrgent, false);
  assert.equal(matchContact(cfg, "someone@unknown.example"), null);
});

test("only-cc is detected from your addresses", () => {
  assert.equal(isOnlyCc(cfg, ["elin@lawfirm.example"], ["ME@example.com"]), true);
  assert.equal(isOnlyCc(cfg, ["me@example.com"], []), false);
});

test("mail from the court or the other side is answered through your lawyer", () => {
  const court = matchContact(cfg, "registry@court.example")!;
  const route = replyRoute(court, { name: "Court", email: "registry@court.example" });
  assert.deepEqual(route, { name: "Elin Holm", email: "elin@lawfirm.example", redirected: true, language: "en" });
  const bank = matchContact(cfg, "marija@bank.example")!;
  assert.equal(replyRoute(bank, { name: "Marija", email: "marija@bank.example" }).redirected, false);
});

test("the Gmail query names every sender and excludes your own mail", () => {
  const q = gmailScopeQuery(cfg, 1792700000);
  assert.equal(q, "from:(bank.example OR court.example OR elin@lawfirm.example OR lawfirm.example OR otherside.example) after:1792700000 -from:me");
  assert.match(gmailScopeQuery(cfg, undefined, 3), /newer_than:3d/);
});
