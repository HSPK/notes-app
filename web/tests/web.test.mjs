import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MARKDOWN_BYTES,
  RequestGate,
  buildFileTree,
  createHiddenPathMatcher,
  createDocumentModel,
  createSaveSnapshot,
  createWordCounter,
  entryDestination,
  filterNotes,
  formatByteCount,
  isDirty,
  makeNoteUrl,
  markdownByteLength,
  normalizeEditorText,
  normalizeNotePath,
  parseHiddenPatterns,
  readLaunchUrl,
  readNoteRoute,
  reconcileSave,
  sameTreeEntries,
  sameTreeStructure,
  serializeEditorText,
  validateNewDirectoryPath,
  validateNewNotePath,
} from "../public/model.mjs";

const response = (content, version = "v1", path = "Notes.md") => ({
  id: path === "Notes.md" ? "01961e0b-9831-7000-8000-000000000001" : "01961e0b-9831-7000-8000-000000000002",
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
  assert.equal(document.format.mixed, false);
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
  assert.equal(document.format.mixed, true);
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

test("new folder paths and move destinations stay portable and relative", () => {
  assert.equal(validateNewDirectoryPath("Work\\Ideas"), "Work/Ideas");
  assert.equal(entryDestination("Draft.md", "Work"), "Work/Draft.md");
  assert.equal(entryDestination("Work/Draft.md", "", "Final.md"), "Final.md");
  for (const path of ["", "../Escape", ".hidden", "Work/node_modules", "C:\\Absolute"]) {
    assert.throws(() => validateNewDirectoryPath(path), Error, path);
  }
});

test("library hide patterns match files, folders and descendants", () => {
  const patterns = parseHiddenPatterns(
    "drafts/**\n*.private.md\n# comment\nArchive/\nscratch\nwork/draft-*",
  );
  assert.deepEqual(patterns, [
    "drafts/**", "*.private.md", "Archive/", "scratch", "work/draft-*",
  ]);
  const hidden = createHiddenPathMatcher(patterns);
  assert.equal(hidden("drafts/note.md"), true);
  assert.equal(hidden("work/secret.private.md"), true);
  assert.equal(hidden("Archive"), true);
  assert.equal(hidden("Archive/2026/note.md"), true);
  assert.equal(hidden("projects/scratch/nested/note.md"), true);
  assert.equal(hidden("work/draft-old/nested/note.md"), true);
  assert.equal(hidden("work/public.md"), false);
  assert.throws(() => parseHiddenPatterns("../outside"));
});

test("compiled hide descendants match the previous ancestor-walk semantics", () => {
  const patterns = [
    "drafts", "drafts/", "archive/**", "work/*.md", "**/cache",
    "*.private.md", "a/?/c", "literal[1]",
  ];
  const legacy = (value) => {
    const expressions = patterns.map((pattern) => {
      const descendants = pattern.endsWith("/") || pattern.endsWith("/**");
      const base = pattern.endsWith("/**") ? pattern.slice(0, -3)
        : pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
      const source = base.replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("**", "\u0000").replaceAll("*", "[^/]*")
        .replaceAll("?", "[^/]").replaceAll("\u0000", ".*");
      const suffix = descendants ? "(?:/.*)?" : "";
      return new RegExp(base.includes("/") ? `^${source}${suffix}$`
        : `(?:^|/)${source}${suffix}$`, "i");
    });
    const parts = normalizeNotePath(value).split("/");
    return parts.some((_, index) => {
      const candidate = parts.slice(0, parts.length - index).join("/");
      return expressions.some((expression) => expression.test(candidate));
    });
  };
  const matcher = createHiddenPathMatcher(patterns);
  for (const path of [
    "drafts/note.md", "projects/drafts/deep/note.md", "archive/2026/note.md",
    "work/note.md/deep", "x/y/cache/file", "x/private.private.md/child",
    "a/b/c/deep", "literal[1]/note.md", "public/note.md",
  ]) {
    assert.equal(matcher(path), legacy(path), path);
  }
});

test("recursive hide globs match zero or more directories while single stars remain one level", () => {
  const cases = [
    ["index.md", false, true, false],
    ["docs/index.md", true, true, true],
    ["docs/topic/index.md", false, true, true],
    ["docs/topic/deep/index.md", false, true, true],
    ["其他/主题/INDEX.MD", false, true, false],
    ["docs\\topic\\index.md", false, true, true],
    ["other/index.md", true, true, false],
    ["docs/index.markdown", false, false, false],
    ["docs/index.md.bak", false, false, false],
    ["docs/other.md", false, false, false],
  ];
  const rules = ["*/index.md", "**/index.md", "docs/**/index.md"];
  for (const [index, rule] of rules.entries()) {
    const hidden = createHiddenPathMatcher(parseHiddenPatterns(rule));
    for (const [path, ...expected] of cases) assert.equal(hidden(path), expected[index], `${rule}: ${path}`);
  }
  const hidden = createHiddenPathMatcher(["docs/**/cache/"]);
  for (const path of ["docs/cache", "docs/cache/note.md", "docs/topic/cache/note.md"]) assert.equal(hidden(path), true, path);
  assert.equal(hidden("other/cache/note.md"), false);
});

test("filtering matches either a file name or its folder, case-insensitively", () => {
  const files = [
    { path: "Work/Planning.md", name: "Planning.md", title: "Quarterly roadmap" },
    { path: "Personal/Recipe.md", name: "Recipe.md" },
  ];
  assert.deepEqual(filterNotes(files, "WORK\\"), [files[0]]);
  assert.deepEqual(filterNotes(files, "recipe"), [files[1]]);
  assert.deepEqual(filterNotes(files, "roadmap"), [files[0]]);
  assert.equal(filterNotes(files, " "), files);
  assert.deepEqual(filterNotes(files, "missing"), []);
});

test("file search caches remain correct after mutations and on frozen entries", () => {
  const file = { path: "Work/Draft.md", name: "Draft.md", title: "Roadmap" };
  assert.deepEqual(filterNotes([file], "roadmap"), [file]);
  file.title = "Retrospective";
  file.path = "Archive/Draft.md";
  assert.deepEqual(filterNotes([file], "roadmap"), []);
  assert.deepEqual(filterNotes([file], "retrospective"), [file]);
  assert.deepEqual(filterNotes([file], "archive"), [file]);
  assert.equal(JSON.stringify(file), '{"path":"Archive/Draft.md","name":"Draft.md","title":"Retrospective"}');

  const frozen = Object.freeze({ path: "Frozen.md", name: "Frozen.md", title: null });
  assert.deepEqual(filterNotes([frozen], "frozen"), [frozen]);
});

test("incremental word counts match full Intl segmentation across line edits", () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  const expected = (source) => [...segmenter.segment(source)]
    .filter((word) => word.isWordLike).length;
  const counter = createWordCounter(segmenter);
  for (const source of [
    "",
    "Hello world",
    "Hello brave world",
    "Hello brave world\n第二行中文",
    "Hello don't-stop\n第二行中文\nfinal 123",
    "Inserted first\nHello don't-stop\n第二行中文\nfinal 123",
    "Inserted first\n第二行已修改\nfinal 123",
    "final",
  ]) {
    assert.equal(counter.count(source), expected(source), source);
  }
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

test("tree entry snapshots detect path, name, title, order and length changes", () => {
  const entries = [
    { path: "a.md", name: "a.md", title: null },
    { path: "folder/b.md", name: "b.md", title: "B" },
  ];
  assert.equal(sameTreeEntries(entries, entries.map((entry) => ({ ...entry }))), true);
  assert.equal(sameTreeEntries(entries, entries.toReversed()), false);
  for (const property of ["path", "name", "title"]) {
    const changed = entries.map((entry) => ({ ...entry }));
    changed[1][property] = `${changed[1][property] ?? ""} changed`;
    assert.equal(sameTreeEntries(entries, changed), false, property);
    assert.equal(sameTreeStructure(entries, changed), property === "title", property);
  }
  assert.equal(sameTreeEntries(entries, entries.slice(0, 1)), false);
});

test("metadata titles label files and explicit empty directories", () => {
  const tree = buildFileTree(
    [{ path: "Guides/intro.md", name: "intro.md", title: "Getting started" }],
    [
      { path: "Guides", name: "Guides", title: "Handbook" },
      { path: "Empty", name: "Empty", title: null },
    ],
  );
  assert.equal(tree.directories[0].name, "Empty");
  assert.equal(tree.directories[1].title, "Handbook");
  assert.equal(tree.directories[1].files[0].title, "Getting started");
});

test("tree ordering matches numeric locale comparison for names and Unicode titles", () => {
  const files = [
    { path: "note-10.md", name: "note-10.md", title: null },
    { path: "note-2.md", name: "note-2.md", title: null },
    { path: "note-a.md", name: "note-a.md", title: "章节 10" },
    { path: "note-b.md", name: "note-b.md", title: "章节 2" },
  ];
  const expected = [...files].sort((left, right) =>
    (left.title ?? left.name).localeCompare(
      right.title ?? right.name,
      undefined,
      { numeric: true, sensitivity: "base" },
    )).map((file) => file.path);
  assert.deepEqual(buildFileTree(files).files.map((file) => file.path), expected);
});

test("streamed tree paths retain root files and normalize nested Windows separators", () => {
  const tree = buildFileTree(
    [
      { path: "Root.md", name: "Root.md" },
      { path: "Work\\2026\\note.md", name: "note.md" },
    ],
    [{ path: "Work\\2026\\Empty", name: "Empty", title: null }],
  );
  assert.equal(tree.files[0].path, "Root.md");
  const work = tree.directories.find((directory) => directory.name === "Work");
  const year = work.directories.find((directory) => directory.name === "2026");
  assert.equal(year.files[0].name, "note.md");
  assert.equal(year.directories[0].path, "Work/2026/Empty");
});

test("deep files share parent branches with explicit titled directories", () => {
  const tree = buildFileTree(
    [
      { path: "Team/2026/Q4/one.md", name: "one.md" },
      { path: "Team/2026/Q4/two.md", name: "two.md" },
    ],
    [{ path: "Team/2026/Q4/Empty", name: "Empty", title: "No notes yet" }],
  );
  const team = tree.directories[0];
  const year = team.directories[0];
  const quarter = year.directories[0];
  assert.equal(team.path, "Team");
  assert.equal(year.path, "Team/2026");
  assert.equal(quarter.path, "Team/2026/Q4");
  assert.equal(quarter.files.length, 2);
  assert.equal(quarter.directories[0].title, "No notes yet");
});

test("launch tokens are removed without losing the requested document identity", () => {
  const id = "01961e0b-9831-7000-8000-000000000001";
  const launch = readLaunchUrl(`http://127.0.0.1:8765/?document=${id}#token=abc123`);
  assert.equal(launch.token, "abc123");
  assert.equal(launch.url.hash, "");
  assert.equal(launch.url.searchParams.get("document"), id);
});

test("ordinary and encoded heading fragments survive token handling", () => {
  for (const hash of ["#my-heading", "#Heading%20with%20spaces", "#token=not-a-hex-token"]) {
    const launch = readLaunchUrl(`http://localhost:8765/?document=01961e0b-9831-7000-8000-000000000001${hash}`);
    assert.equal(launch.token, null);
    assert.equal(launch.url.hash, hash);
  }
  const combined = readLaunchUrl("http://localhost:8765/?document=01961e0b-9831-7000-8000-000000000001#token=deadbeef&my-heading");
  assert.equal(combined.token, "deadbeef");
  assert.equal(combined.url.hash, "#my-heading");
});

test("note routing accepts UUID identity, rejects path locators and preserves view and heading semantics", () => {
  const id = "01961e0b-9831-7000-8000-000000000001";
  const url = makeNoteUrl("http://localhost:8765/?mode=read#old", id, "#section");
  assert.deepEqual(readNoteRoute(url), { id, hash: "#section" });
  assert.equal(url.searchParams.get("mode"), "read");
  const empty = makeNoteUrl(url, null);
  assert.equal(empty.searchParams.has("document"), false);
  assert.equal(empty.hash, "");
  assert.throws(() => makeNoteUrl(url, "Work/A & B.md"), /UUID/);
  assert.throws(() => readNoteRoute("http://localhost/?file=Notes.md"), /no longer supported/);
  assert.throws(() => readNoteRoute("http://localhost/?document=Notes.md"), /UUID/);
  const shared = makeNoteUrl("http://localhost/share?share=opaque-capability", id, "#section");
  assert.equal(shared.searchParams.has("document"), false);
  assert.equal(shared.searchParams.get("share"), "opaque-capability");
});

test("a rename changes location without changing the identity accepted by save reconciliation", () => {
  const model = createDocumentModel(response("Before"));
  const snapshot = createSaveSnapshot(model, "After");
  const result = reconcileSave(snapshot, { ...response("After"), path: "Renamed.md" }, "After");
  assert.equal(result.document.id, model.id);
  assert.equal(result.document.path, "Renamed.md");
  assert.equal(result.dirty, false);
});

test("a new resource at an old path invalidates the existing tree structure", () => {
  const previous = [{id:"01961e0b-9831-7000-8000-000000000001", path:"Notes.md", name:"Notes.md"}];
  const replaced = [{...previous[0], id:"01961e0b-9831-7000-8000-000000000002"}];
  assert.equal(sameTreeStructure(previous, replaced), false);
  assert.equal(sameTreeEntries(previous, replaced), false);
});
