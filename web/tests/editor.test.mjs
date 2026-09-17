import test from "node:test";
import assert from "node:assert/strict";
import { resolveMarkdownUrl, splitFrontMatter, replaceMetadataText, headingSlug, assignHeadingIds, validateAppearance, quoteFontFamily, cssFontFamily } from "../public/editor-helpers.mjs";
import { createDocumentModel, isDirty, serializeEditorText, createSaveSnapshot, reconcileSave } from "../public/model.mjs";

test("render-only paths resolve against the note without rewriting source URLs", () => {
  assert.equal(resolveMarkdownUrl("../images/a b.png", "Projects/note.md", true), "/assets?path=images%2Fa%20b.png");
  assert.equal(resolveMarkdownUrl("./Next%20note.md#heading", "Projects/note.md"), "/?file=Projects%2FNext%20note.md#heading");
  assert.equal(resolveMarkdownUrl("/Readme.markdown", "Projects/note.md"), "/?file=Readme.markdown");
  assert.equal(resolveMarkdownUrl("#heading", "note.md"), "#heading");
  assert.equal(resolveMarkdownUrl("paper.pdf", "Folder/note.md"), "/assets?path=Folder%2Fpaper.pdf");
  assert.equal(resolveMarkdownUrl("../../escape.png", "Folder/note.md", true), null);
});

test("unsafe schemes, ambiguous paths, and remote image tracking are blocked", () => {
  for (const value of ["javascript:alert(1)", "data:image/svg+xml,hi", "file:///C:/a", "//evil.example/image", "a\\b", "%2e%2e/escape", "java\nscript:alert(1)", "a%00b", "C%3A/private"]) {
    assert.equal(resolveMarkdownUrl(value, "note.md", true), null, value);
  }
  assert.equal(resolveMarkdownUrl("https://example.com/a.png", "note.md", true), null);
  assert.equal(resolveMarkdownUrl("https://example.com/page", "note.md"), "https://example.com/page");
  assert.equal(resolveMarkdownUrl("mailto:person@example.com", "note.md"), "mailto:person@example.com");
});

test("front matter splitting preserves BOM, fences, comments, CRLF and separator lines exactly", () => {
  for (const closing of ["---", "..."]) {
    const prefix = `\uFEFF---\r\n# comment\r\ntitle: "A: title"\r\nunknown:\r\n  child: [a, b]\r\n${closing}\r\n\r\n \t\r\n`;
    const body = "# Body\r\n\r\nText\n";
    const parts = splitFrontMatter(prefix + body);
    assert.equal(parts.hasMetadata, true);
    assert.equal(parts.prefix, prefix);
    assert.equal(parts.body, body);
    assert.equal(parts.bodyStart, prefix.length);
    assert.equal(parts.prefix + parts.body, prefix + body);
    assert.equal(parts.raw, '# comment\r\ntitle: "A: title"\r\nunknown:\r\n  child: [a, b]\r\n');
  }
});

test("metadata edits cannot rewrite the Markdown body or surrounding delimiters", () => {
  const source = '\uFEFF--- \r\n# keep\r\ntitle: "Before"\r\nunknown: {x: 1}\r\n... \r\n\r\n# Body\n\n*   original\n';
  const parts = splitFrontMatter(source);
  const changed = replaceMetadataText(parts, parts.raw.replace(/\r\n/g, "\n").replace("Before", "After"));
  assert.equal(changed.opening, parts.opening);
  assert.equal(changed.suffix, parts.suffix);
  assert.equal(changed.body, parts.body);
  assert.equal(changed.prefix + changed.body, source.replace("Before", "After"));
});

test("only a complete front matter fence at the beginning is metadata", () => {
  for (const source of ["\n---\ntitle: no\n---\n", "---\ntitle: unfinished\n", "Title\n---\nBody", "---", " ---\ntitle: no\n---\n"]) {
    assert.equal(splitFrontMatter(source).hasMetadata, false, source);
    assert.equal(splitFrontMatter(source).body, source);
  }
  assert.deepEqual(splitFrontMatter("\uFEFF# Body"), { hasMetadata: false, prefix: "\uFEFF", body: "# Body", bodyStart: 1 });
});

test("heading slugs follow backend Unicode, separators, fallback, and length rules", () => {
  assert.equal(headingSlug("  Hello -- WORLD!?  "), "hello-world");
  assert.equal(headingSlug("a.b / c_d"), "ab-c_d");
  assert.equal(headingSlug("!!! ---"), "section");
  assert.equal(headingSlug("ΟΣ"), "οσ");
  assert.equal(headingSlug("x".repeat(159) + "😀ignored"), "x".repeat(159));
});

test("heading duplicate suffixes start at two and avoid literal slug collisions", () => {
  assert.deepEqual(assignHeadingIds(["Hello", "Hello", "Hello-2", "Hello"]), ["hello", "hello-2", "hello-2-2", "hello-3"]);
  assert.deepEqual(assignHeadingIds(["hello-2", "Hello", "Hello"]), ["hello-2", "hello", "hello-3"]);
  assert.deepEqual(assignHeadingIds(["!!!", "section", ""]), ["section", "section-2", "section-3"]);
});

test("untouched rich/source mode transitions preserve BOM and mixed line endings", () => {
  const content = "\uFEFF# Heading\r\n\r\n*   one\n*   two\r";
  const model = createDocumentModel({ path: "a.md", content, version: "1", html: "" });
  const source = model.text;
  assert.equal(isDirty(model, source), false);
  assert.equal(serializeEditorText(model, source), content);
  // A rich transaction may normalize; undo to its initial document returns source.
  assert.equal(isDirty(model, "# Heading\n\n- one\n- two\n"), true);
  assert.equal(serializeEditorText(model, source), content);
});

test("save response does not discard rich edits made after the saved snapshot", () => {
  const model = createDocumentModel({ path: "a.md", content: "Before\r\n", version: "1", html: "" });
  const snapshot = createSaveSnapshot(model, "Saved\n");
  const result = reconcileSave(snapshot, { path: "a.md", content: "Saved\r\n", version: "2", html: "" }, "Newer rich edit\n");
  assert.equal(result.text, "Newer rich edit\n");
  assert.equal(result.dirty, true);
});

test("appearance accepts Unicode family names and rejects invalid server settings", () => {
  assert.deepEqual(validateAppearance({ theme: "dark", latinFont: " Georgia ", cjkFont: "宋体" }), {
    theme: "dark", latinFont: "Georgia", cjkFont: "宋体",
  });
  for (const value of [
    null, { theme: "auto", latinFont: "Arial", cjkFont: "宋体" },
    { theme: "light", latinFont: "", cjkFont: "宋体" },
    { theme: "system", latinFont: "Arial", cjkFont: "bad\nname" },
    { theme: "system", latinFont: 3, cjkFont: "宋体" },
  ]) assert.throws(() => validateAppearance(value), /appearance|font/);
});

test("font families remain one quoted CSS string rather than executable rules", () => {
  assert.equal(quoteFontFamily("宋体"), '"宋体"');
  assert.equal(quoteFontFamily('A"B\\C'), '"A\\"B\\\\C"');
  assert.equal(quoteFontFamily('Font"; color: red; }'), '"Font\\"; color: red; }"');
  assert.equal(quoteFontFamily("line\nbreak"), '"line\\a break"');
});

test("CSS generic fonts stay generic rather than becoming unavailable local font names", () => {
  assert.equal(cssFontFamily("sans-serif"), "sans-serif");
  assert.equal(cssFontFamily("SYSTEM-UI"), "system-ui");
  assert.equal(cssFontFamily("monospace"), "monospace");
  assert.equal(cssFontFamily("Helvetica Neue"), '"Helvetica Neue"');
  assert.equal(cssFontFamily("PingFang SC"), '"PingFang SC"');
});
