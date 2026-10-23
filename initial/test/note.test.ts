import test from "node:test";
import assert from "node:assert/strict";
import { messageSection, newNote, replaceAttachmentLine, replaceByHandTask, setTaskDone, taskLine, updateFrontmatter, yamlValue } from "../src/obsidian/note.js";
import { cleanSubject, noteRelPath } from "../src/obsidian/writer.js";

test("yaml values are quoted only when needed", () => {
  assert.equal(yamlValue("needs_reply"), "needs_reply");
  assert.equal(yamlValue("Sweden — legal matter"), "Sweden — legal matter");
  assert.equal(yamlValue("Re: draft: v3"), '"Re: draft: v3"');
  assert.equal(yamlValue("https://mail.google.com/mail/#all/x|y"), '"https://mail.google.com/mail/#all/x|y"');
  assert.equal(yamlValue("yes"), '"yes"');
  assert.equal(yamlValue(true), "true");
});

test("frontmatter updates touch only the app's keys", () => {
  const note = "---\nstatus: needs_reply\nmy_key: keep me\ntags: [inbox, gmail]\n---\n# Title\n\nMy own notes.\n";
  const out = updateFrontmatter(note, { status: "replied", urgency: "urgent" });
  assert.equal(out, "---\nstatus: replied\nmy_key: keep me\ntags: [inbox, gmail]\nurgency: urgent\n---\n# Title\n\nMy own notes.\n");
  assert.equal(updateFrontmatter("# No frontmatter\n", { status: "replied" }), "# No frontmatter\n");
});

test("task lines are found by block id", () => {
  const line = taskLine("abc123", null);
  assert.equal(line, "- [ ] Triage this message by hand ^it-abc123");
  const content = `# T\n\n${line}\n- [ ] my own task\n`;
  const done = setTaskDone(content, "abc123", true);
  assert.match(done, /- \[x\] Triage this message by hand \^it-abc123/);
  assert.match(done, /- \[ \] my own task/);
  const replaced = replaceByHandTask(done, "abc123", "- [ ] Send comments 📅 2026-10-26 ^it-abc123");
  assert.match(replaced, /- \[ \] Send comments 📅 2026-10-26 \^it-abc123\n- \[ \] my own task/);
  assert.doesNotMatch(replaced, /Triage this message by hand/);
  // Only the placeholder is swapped: a real task line, or one you edited, stays.
  assert.equal(replaceByHandTask(replaced, "abc123", "- [ ] Something else ^it-abc123"), replaced);
  // No task after triage: the placeholder goes.
  assert.equal(replaceByHandTask(content, "abc123", ""), "# T\n\n- [ ] my own task\n");
});

test("ticking a task or swapping an attachment line keeps the blank line and your text below it", () => {
  const note = "# T\n\n- [ ] Reply ^it-a1\n\nMy own paragraph.\n\n## 2026-10-24 10:00 · next\n";
  const ticked = setTaskDone(note, "a1", true);
  assert.equal(ticked, note.replace("- [ ]", "- [x]"));
  assert.equal(setTaskDone(ticked, "a1", false), note);
  const att = "**Attachments:**\n- x.pdf (0.1 MB): not saved yet ^at-a1-0\n\n- [ ] Reply ^it-a1\n";
  assert.equal(replaceAttachmentLine(att, "a1", 0, "- [[p|x.pdf]]"), "**Attachments:**\n- [[p|x.pdf]]\n\n- [ ] Reply ^it-a1\n");
});

test("a section quotes the message and lists attachments", () => {
  const s = messageSection({
    itemId: "m1",
    receivedLocal: "2026-10-23 10:12",
    fromName: "Elin Holm",
    fromEmail: "elin@lawfirm.example",
    senderVerified: true,
    link: "https://mail.google.com/x",
    onlyCc: true,
    body: "Line one\n\nLine two",
    quoted: "",
    attachments: [
      { filename: "Draft.pdf", size: 1000, path: "Projects/X/attachments/2026-10-23 Draft.pdf", inVault: true },
      { filename: "Big.pdf", size: 18_000_000, path: "/data/large/Big.pdf", inVault: false },
    ],
    triage: null,
    triageError: "Claude API 500",
  });
  assert.match(s, /^## 2026-10-23 10:12 · Elin Holm \(elin@lawfirm.example\)/);
  assert.match(s, /you were in cc/);
  assert.match(s, /> Line one\n>\n> Line two/);
  assert.match(s, /\[\[Projects\/X\/attachments\/2026-10-23 Draft.pdf\|Draft.pdf\]\]/);
  assert.match(s, /Big.pdf \(18.0 MB, over the Obsidian Sync file limit/);
  assert.match(s, /\*\*Triage failed:\*\* Claude API 500/);
  assert.ok(newNote({ status: "needs_reply" }, "T", s).startsWith("---\nstatus: needs_reply\ntags: [inbox, gmail]\n---\n# T\n\n## "));
});

test("note paths drop reply prefixes and unsafe characters", () => {
  assert.equal(cleanSubject("RE: SV: Odg: Draft statement"), "Draft statement");
  assert.equal(noteRelPath("Projects/X", "2026-10-23T10:12", "Re: Kallelse: 12/11 [viktigt]"), "Projects/X/2026-10-23 Kallelse 12 11 viktigt.md");
});
