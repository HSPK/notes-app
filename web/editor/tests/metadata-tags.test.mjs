import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTags, readMetadataTags, replaceYamlTags, updateMetadataTags } from "../src/metadata-tags.mjs";

test("tags accept scalar/list metadata and legacy tag without duplicate case variants", () => {
  assert.deepEqual(readMetadataTags("---\ntags: [Rust, 中文]\ntag: '#rust'\n---\nBody"), ["Rust", "中文"]);
  assert.deepEqual(readMetadataTags("---\ntag: notes\n---\nBody"), ["notes"]);
  assert.deepEqual(readMetadataTags("# Body"), []);
  assert.throws(() => normalizeTags(["x", 123]), /strings/);
  assert.throws(() => normalizeTags(["bad\ntag"]), /control/);
});

test("tag updates preserve unrelated YAML spelling, comments and body bytes", () => {
  const source = '\uFEFF---\r\n# keep\r\ntitle: "Exact: title"\r\ntags: [old] # keep inline\r\ncustom: {x: 1}\r\n...\r\n\r\n# Body\n\n*   original\r\n';
  const next = updateMetadataTags(source, ["new", "中文"]);
  assert.equal(next, source.replace("[old]", '["new","中文"]'));
  assert.deepEqual(readMetadataTags(next), ["new", "中文"]);
  assert.equal(replaceYamlTags("tags:\nother: yes\n", ["one"]), 'tags: ["one"]\nother: yes\n');
  assert.equal(replaceYamlTags("tags:\n  - old\nother: yes\n", ["one"]), 'tags:\n  ["one"]\nother: yes\n');
  assert.equal(replaceYamlTags("tag: old\ntags: [other]\n", ["new"]), 'tag: []\ntags: ["new"]\n');
});

test("new tags create a header without changing the body and unsafe edits fail explicitly", () => {
  const body = "\uFEFF# Exact\r\n\r\nBody\n";
  const next = updateMetadataTags(body, ["notes"]);
  assert.equal(next, '\uFEFF---\r\ntags: ["notes"]\r\n---\r\n\r\n# Exact\r\n\r\nBody\n');
  assert.equal(updateMetadataTags(body, []), body);
  assert.throws(() => replaceYamlTags("tags:\n  - old # keep this\n", ["new"]), /commented tag list/);
  assert.throws(() => replaceYamlTags("tags: [broken", ["new"]), /Fix the YAML/);
});
