import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MARKDOWN_BYTES,
  RequestGate,
  buildFileTree,
  createDocumentModel,
  createSaveSnapshot,
  filterNotes,
  formatByteCount,
  isDirty,
  makeNoteUrl,
  markdownByteLength,
  normalizeEditorText,
  readLaunchUrl,
  readNoteRoute,
  reconcileSave,
  serializeEditorText,
  validateNewNotePath,
} from "../public/model.mjs";

const response = (content, version = "v1", path = "Notes.md") => ({
  path, content, html: "<p>Rendered by the service</p>", version,
});

test("textarea newline normalization does not make a CRLF/BOM file dirty", () => {
  const raw = "\uFEFF# Heading\r\n\r\nText\r\n";
  const document = createDocumentModel(response(raw));
  assert.equal(document.text, "# Heading\n\nText\n");
  assert.equal(isDirty(document, document.text), false);
  assert.equal(isDirty(document, "# Heading\r\n\r\nText\r\n"), false);
  assert.equal(serializeEditorText(document, document.text), raw);
});

test("editing a CRLF file preserves its BOM and newline convention", () => {
  const document = createDocumentModel(response("\uFEFFOne\r\nTwo\r\n"));
  assert.equal(serializeEditorText(document, "One\nTwo\nThree\n"), "\uFEFFOne\r\nTwo\r\nThree\r\n");
  assert.equal(isDirty(document, "One\nTwo\nThree\n"), true);
});

test("empty BOM-only files and CR-only files keep their format", () => {
  const bom = createDocumentModel(response("\uFEFF"));
  assert.equal(bom.text, "");
  assert.equal(serializeEditorText(bom, "Hello\n"), "\uFEFFHello\n");
  const carriageReturns = createDocumentModel(response("One\rTwo\r"));
  assert.equal(serializeEditorText(carriageReturns, "One\nThree\n"), "One\rThree\r");
});

test("an unchanged mixed-newline file is returned exactly", () => {
  const raw = "One\r\nTwo\nThree\r\nFour\r";
  const document = createDocumentModel(response(raw));
  assert.equal(serializeEditorText(document, normalizeEditorText(raw)), raw);
  assert.equal(document.format.lineEnding, "\r\n");
});

test("editing the body preserves a YAML header including mixed newline bytes", () => {
  const header = "\uFEFF---\r\n# Keep this comment\n"
    + "title: 'Original title'\r\ntags: [one, two]\n"
    + "custom:\r\n  keep: true\r\n...\n\r\n";
  const raw = `${header}# Body\r\n\r\nOld text.\n`;
  const document = createDocumentModel(response(raw));
  const edited = document.text.replace("Old text.", "New text.");
  assert.equal(serializeEditorText(document, edited), raw.replace("Old text.", "New text."));
});

test("editing only YAML leaves the original Markdown body's mixed line endings intact", () => {
  const raw = "---\r\ntitle: 'Old'\r\n---\r\n\r\n# Body\n\nOne\r\nTwo\rThree\n";
  const document = createDocumentModel(response(raw));
  const edited = document.text.replace("title: 'Old'", "title: 'New'");
  assert.equal(serializeEditorText(document, edited), raw.replace("title: 'Old'", "title: 'New'"));
});

test("insertions and deletions at normalized boundaries never split CRLF pairs", () => {
  for (const raw of ["A\r\nB\nC\r", "\uFEFFA\rB\r\n", "A\rB\rC\nD", "\r\n\n\r", "plain text", ""]) {
    const document = createDocumentModel(response(raw));
    for (let index = 0; index <= document.text.length; index += 1) {
      for (const removed of [0, 1, 3]) {
        for (const inserted of ["New\nline", "\n", "\n\n", "", "tail\n"]) {
          const expected = document.text.slice(0, index) + inserted + document.text.slice(index + removed);
          const saved = serializeEditorText(document, expected);
          assert.equal(normalizeEditorText(document.format.bom ? saved.slice(1) : saved), expected);
        }
      }
    }
  }
});

test("save snapshots capture content and version without following later edits", () => {
  const document = createDocumentModel(response("Original\r\n", "original-version"));
  const snapshot = createSaveSnapshot(document, "First edit\n");
  assert.equal(snapshot.version, "original-version");
  assert.equal(snapshot.content, "First edit\r\n");
  assert.equal(snapshot.text, "First edit\n");
  assert.equal(Object.isFrozen(snapshot), true);
});

test("an earlier save completing never marks later text as saved", () => {
  const document = createDocumentModel(response("Original\n"));
  const snapshot = createSaveSnapshot(document, "Saved edit\n");
  const result = reconcileSave(snapshot, response("Saved edit\n", "v2"), "Later typing\n");
  assert.equal(result.text, "Later typing\n");
  assert.equal(result.document.version, "v2");
  assert.equal(result.document.text, "Saved edit\n");
  assert.equal(result.dirty, true);
  const nextSave = createSaveSnapshot(result.document, result.text);
  assert.equal(nextSave.version, "v2");
  assert.equal(nextSave.content, "Later typing\n");
});

test("a completed save updates its normalized baseline when there are no newer edits", () => {
  const document = createDocumentModel(response("\uFEFFOld\r\n"));
  const snapshot = createSaveSnapshot(document, "New\n");
  const result = reconcileSave(snapshot, response("\uFEFFNew\r\n", "v2"), "New\n");
  assert.equal(result.text, "New\n");
  assert.equal(result.dirty, false);
  assert.equal(serializeEditorText(result.document, result.text), "\uFEFFNew\r\n");
});

test("a mismatched save response cannot replace the current note", () => {
  const snapshot = createSaveSnapshot(createDocumentModel(response("Old")), "New");
  assert.throws(() => reconcileSave(snapshot, response("New", "v2", "Other.md"), "New"), /different note/);
});

test("request gates reject both overtaken and canceled work", () => {
  const gate = new RequestGate();
  const first = gate.next();
  const second = gate.next();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
  assert.equal(gate.isCurrent(gate.next()), true);
});

test("the Markdown byte limit counts UTF-8, BOM and serialized line endings", () => {
  assert.equal(MAX_MARKDOWN_BYTES, 4_194_304);
  assert.equal(markdownByteLength("é🙂"), 6);
  assert.equal(markdownByteLength("\uFEFFa\r\n"), 6);
  assert.equal(markdownByteLength("a".repeat(MAX_MARKDOWN_BYTES)), MAX_MARKDOWN_BYTES);
  assert.equal(formatByteCount(1024), "1.0 KiB");
  assert.equal(formatByteCount(MAX_MARKDOWN_BYTES), "4.00 MiB");
});

test("new note paths support nested Windows input and both Markdown extensions", () => {
  assert.equal(validateNewNotePath(" Projects\\Meeting notes.md "), "Projects/Meeting notes.md");
  assert.equal(validateNewNotePath("日记/Today.MARKDOWN"), "日记/Today.MARKDOWN");
});

test("new note paths reject traversal, absolute paths and invalid Windows names", () => {
  for (const path of [
    "", "../Escape.md", "a/../Escape.md", "./Note.md", "C:\\Note.md", "\\\\host\\Note.md",
    "/Note.md", "a//Note.md", "a/Note.txt", "a/Note.md.", "a /Note.md", "a/Bad?.md",
    "CON.md", "a/NUL.markdown", "a/LPT1.md", "a/COM¹.md", "a/Bad\u0000.md",
  ]) {
    assert.throws(() => validateNewNotePath(path), Error, path);
  }
});

test("filtering matches either a file name or its folder, case-insensitively", () => {
  const files = [
    { path: "Work/Planning.md", name: "Planning.md" },
    { path: "Personal/Recipe.md", name: "Recipe.md" },
  ];
  assert.deepEqual(filterNotes(files, "WORK\\"), [files[0]]);
  assert.deepEqual(filterNotes(files, "recipe"), [files[1]]);
  assert.equal(filterNotes(files, " "), files);
  assert.deepEqual(filterNotes(files, "missing"), []);
});

test("flat note paths become ordered nested navigation without HTML interpretation", () => {
  const files = [
    { path: "Work/2026/Review.md", name: "Review.md" },
    { path: "Root.md", name: "Root.md" },
    { path: "Work/<example>.md", name: "<example>.md" },
  ];
  const tree = buildFileTree(files);
  assert.equal(tree.files[0].path, "Root.md");
  assert.equal(tree.directories[0].name, "Work");
  assert.equal(tree.directories[0].directories[0].path, "Work/2026");
  assert.equal(tree.directories[0].files[0].name, "<example>.md");
});

test("launch tokens are removed without losing the requested file", () => {
  const launch = readLaunchUrl("http://127.0.0.1:8765/?file=Work%2FNote.md#token=abc123");
  assert.equal(launch.token, "abc123");
  assert.equal(launch.url.hash, "");
  assert.equal(launch.url.searchParams.get("file"), "Work/Note.md");
});

test("ordinary and encoded heading fragments survive token handling", () => {
  for (const hash of ["#my-heading", "#Heading%20with%20spaces", "#token=not-a-hex-token"]) {
    const launch = readLaunchUrl(`http://localhost:8765/?file=Note.md${hash}`);
    assert.equal(launch.token, null);
    assert.equal(launch.url.hash, hash);
  }
  const combined = readLaunchUrl("http://localhost:8765/?file=Note.md#token=deadbeef&my-heading");
  assert.equal(combined.token, "deadbeef");
  assert.equal(combined.url.hash, "#my-heading");
});

test("note routing encodes file paths, preserves other query values and changes headings", () => {
  const url = makeNoteUrl("http://localhost:8765/?mode=read#old", "Work/A & B.md", "#section");
  assert.deepEqual(readNoteRoute(url), { path: "Work/A & B.md", hash: "#section" });
  assert.equal(url.searchParams.get("mode"), "read");
  const empty = makeNoteUrl(url, null);
  assert.equal(empty.searchParams.has("file"), false);
  assert.equal(empty.hash, "");
});
