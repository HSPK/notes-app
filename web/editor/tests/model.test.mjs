import test from "node:test";
import assert from "node:assert/strict";
import {
  assignHeadingIds,
  cssFontFamily,
  headingSlug,
  quoteFontFamily,
  replaceMetadataText,
  resolveMarkdownUrl,
  splitFrontMatter,
  validateAppearance,
} from "../src/editor-helpers.mjs";
import { createOutlineExtractor, documentOffset, extractOutline, sourceOffset } from "../src/markdown.mjs";
import { normalizeSerializedBody } from "../src/roundtrip.mjs";

test("render-only paths resolve against the note without rewriting source URLs", () => {
  assert.equal(resolveMarkdownUrl("../images/a b.png", "Projects/note.md", true), "/images/a%20b.png");
  assert.equal(resolveMarkdownUrl("./Next%20note.md#heading", "Projects/note.md"), "/Projects/Next%20note.md#heading");
  assert.equal(resolveMarkdownUrl("/Readme.markdown", "Projects/note.md"), "/Readme.markdown");
  assert.equal(resolveMarkdownUrl("#heading", "note.md"), "#heading");
  assert.equal(resolveMarkdownUrl("paper.pdf", "Folder/note.md"), "/Folder/paper.pdf");
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

test("incremental outline extraction matches full Markdown parsing across edits", () => {
  const extractor = createOutlineExtractor();
  const sources = [
    "---\ntitle: Outline\n---\n\n# One\n\nText\n\n## Two\n",
    "---\ntitle: Outline\n---\n\n# One changed\n\nText\n\n## Two\n",
    "---\ntitle: Longer outline metadata\n---\n\n# One changed\n\nText\n\n## Two\n",
    "---\ntitle: Longer outline metadata\n---\n\n# One changed\n\n```\n# Hidden\n```\n\nAdded\n=====\n",
    "# Reset\n\n### Three\n",
  ];
  for (const source of sources) {
    assert.deepEqual(extractor.extract(source), extractOutline(source));
  }
  const previous = sources.at(-1);
  const precise = "# Precise\n\n### Three\n";
  const from = previous.indexOf("Reset");
  assert.deepEqual(extractor.extract(precise, {
    beforeLength: previous.length,
    afterLength: precise.length,
    ranges: [{
      fromA: from,
      toA: from + "Reset".length,
      fromB: precise.indexOf("Precise"),
      toB: precise.indexOf("Precise") + "Precise".length,
    }],
  }), extractOutline(precise));
  extractor.clear();
  assert.deepEqual(extractor.extract("# Fresh\n"), extractOutline("# Fresh\n"));
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

test("source cursors retain block ends while heading markers jump to the next block", () => {
  const map = [
    { source: 0, position: 1 },
    { source: 1, position: 2 },
    { source: 7, position: 5 },
    { source: 8, position: 6 },
  ];
  assert.equal(documentOffset(map, 2), 3);
  for (const marker of [4, 5, 6, 7]) assert.equal(documentOffset(map, marker), 5);
  assert.equal(documentOffset(map, 8), 6);
  assert.equal(documentOffset(map, 9), 7);
  assert.equal(sourceOffset(map, 3), 2);
  assert.equal(sourceOffset(map, 5), 7);
  assert.equal(sourceOffset(map, 7), 9);
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

test("Milkdown placeholders normalize back to semantic Markdown", () => {
  const serializedList = "* Previous\n  Evaluation\n* <br />\n  ## Down stream tasks\n\nTrain Metrics\n";
  const normalizedList = normalizeSerializedBody(serializedList);
  assert.equal(normalizedList, "* Previous\n  Evaluation\n* ## Down stream tasks\n\nTrain Metrics\n");
  assert.equal(normalizeSerializedBody("5. <br />\n"), "5. \n");

  const serializedTable = "| A      | B |\n| ------ | - |\n| <br /> | x |\n";
  const normalizedTable = normalizeSerializedBody(serializedTable);
  assert.equal(normalizedTable, "| A      | B |\n| ------ | - |\n| | x |\n");
});
