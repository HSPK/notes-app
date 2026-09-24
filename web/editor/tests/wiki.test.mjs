import test from "node:test";
import assert from "node:assert/strict";
import { parseBody, bodyFingerprint, extractOutline, unsupportedBody } from "../src/markdown.mjs";
import { wikiDestination } from "../src/wiki-syntax.mjs";

test("wiki links preserve targets and aliases without interpreting code as links", () => {
  const source = "[[Folder/Page|Label]] and `[[Code]]`";
  const tree = parseBody(source);
  assert.equal(tree.children[0].children[0].type, "wikiLink");
  assert.equal(tree.children[0].children[0].value, "Folder/Page");
  assert.equal(unsupportedBody(tree,source),"");
  assert.notEqual(bodyFingerprint(parseBody("[[Page|First]]")),bodyFingerprint(parseBody("[[Page|Second]]")));
  assert.equal(wikiDestination("/Folder/Page#Some Heading"),"/Folder/Page.md#some-heading");
  assert.equal(wikiDestination("javascript:alert(1)"),null);
  assert.deepEqual(extractOutline("# [[Page|Label]]\n")[0],{text:"Label",level:1,from:0,id:"label"});
});
