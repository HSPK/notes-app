import test from "node:test";
import assert from "node:assert/strict";
import { calendarWeek, notePathFromTitle, templateTitle, templateContent } from "../public/workspace-model.mjs";
import { browserDocumentTitle, validateNewNotePath } from "../public/model.mjs";

test("templates use local dates and ISO week years", () => {
  assert.equal(templateTitle("daily", new Date(2026, 8, 19)), "2026-09-19");
  assert.equal(templateTitle("blank"), "Untitled");
  assert.equal(templateTitle("meeting", new Date(2026, 8, 19)), "Meeting-2026-09-19");
  assert.throws(() => templateTitle("unknown"), /supported/);
  assert.equal(calendarWeek(new Date(2021, 0, 1)), "2020-W53");
  assert.equal(calendarWeek(new Date(2024, 11, 30)), "2025-W01");
});
test("every new note includes a quoted title and an ISO creation timestamp", () => {
  const date = new Date("2026-09-22T07:18:51.216Z");
  const title = '研究: "A & B" / [Review] <b>';
  const header = `---\ntitle: ${JSON.stringify(title)}\ncreated: "${date.toISOString()}"\n`;
  for (const kind of ["blank", "daily", "weekly", "meeting"]) {
    assert.ok(templateContent(kind, title, date).startsWith(header));
  }
  assert.equal(templateContent("blank", title, date), `${header}---\n\n`);
  const content = templateContent("meeting", "[Review] <b>", date);
  assert.match(content, /tags: \[meeting\]/);
  assert.match(content, /# \\\[Review\\\]/);
  assert.match(content, /\\<b\\>/);
  assert.throws(() => templateContent("unknown", "Note"), /supported/);
});

test("title-only filenames remain portable and never treat title text as a directory", () => {
  assert.equal(notePathFromTitle(" New note "), "New note.md");
  assert.equal(notePathFromTitle("Draft", "Guides/Weekly"), "Guides/Weekly/Draft.md");
  assert.equal(notePathFromTitle("Note.md"), "Note.md");
  assert.equal(notePathFromTitle("Note.markdown"), "Note.md");
  assert.equal(notePathFromTitle('研究: "A/B"?'), "研究- -A-B-.md");
  assert.equal(notePathFromTitle("../../outside", "Guides"), "Guides/-..-outside.md");
  assert.equal(notePathFromTitle("100% / %2f"), "100- - -2f.md");
  for (const title of ["CON", "nul", "COM¹", "LPT9", "CLOCK$", "con .draft"]) {
    assert.equal(notePathFromTitle(title), `_${title}.md`);
    assert.equal(validateNewNotePath(notePathFromTitle(title)), notePathFromTitle(title));
  }
  const long = notePathFromTitle("标题😀".repeat(50));
  assert.ok(new TextEncoder().encode(long).length <= 244);
  assert.ok(!long.includes("\uFFFD"));
  assert.ok(long.endsWith(".md"));
  for (const title of ["", " ", "...", "\n", "A\nB", "A\u007fB", "A\u2028B", "A".repeat(201)]) {
    assert.throws(() => notePathFromTitle(title));
  }
  assert.throws(() => notePathFromTitle("Note", "../outside"));
});

test("browser titles prefer metadata and keep the unsaved marker without exposing folder paths", () => {
  assert.equal(browserDocumentTitle(null), "Notes");
  const note = { path: "Guides/physical-name.md", title: "Document title" };
  assert.equal(browserDocumentTitle(note), "Document title — Notes");
  assert.equal(browserDocumentTitle(note, true), "Document title * — Notes");
  assert.equal(browserDocumentTitle({ ...note, title: null }), "physical-name.md — Notes");
  assert.equal(browserDocumentTitle({ ...note, title: "  " }), "physical-name.md — Notes");
});
