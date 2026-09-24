# @notes-app/editor

Independent browser editor package used by Notes App.

## Public API

```js
import {
  applyAppearance,
  attachScrollbars,
  createInlineEditor,
  createSourceEditor,
  extractOutline,
} from "@notes-app/editor";
```

- `createInlineEditor` provides the Milkdown Live Markdown editor.
- `createSourceEditor` provides the large-document CodeMirror Source adapter.
- `extractOutline` returns Unicode heading labels, levels, offsets, and stable IDs.
- `applyAppearance` applies local theme and font settings without rebuilding an editor.
- `attachScrollbars` provides the shared overlay scrollbar adapter.
- `createSharedText` provides a Yjs Markdown CRDT with local-only undo and relative cursor positions.

Collaborative hosts can call `getSelection`, `cursorRect`, `setReadOnly`, and
`replaceSource` on the Live adapter. The Source adapter exposes `getSelection`,
`cursorRect`, `setReadOnly`, and `viewportRect` for both textarea and virtual editing.
Transport, authenticated presence and disk persistence remain host responsibilities.

Live heading IDs come from the shared `assignHeadingIds` helper through node
decorations. The commonmark `syncHeadingIdPlugin` is intentionally excluded:
rewriting every heading would duplicate this work and emit redundant document
updates. Live anchors, outline navigation, and Rust Read-mode anchors must agree.

Live initialization skips a second semantic parse only when serialization exactly
matches the original Markdown body. Any difference, including whitespace, still
uses the existing round-trip fingerprint comparison; no source is rewritten on load.

`createInlineEditor` accepts an optional `transformUrl(url, documentPath)` callback.
Hosts can use it to scope rendered attachment and note links to a project without
changing the Markdown stored on disk. Local targets are normalized, encoded
project-relative URL paths; Notes resolves them to resource UUID URLs. Hosts may
call `refreshLinks()` after asynchronous identity resolution. Changes to projected
link attributes are ignored by the editor's DOM observer, not serialized as edits
to Markdown link destinations. Image upload, clipboard handling and
project permissions remain host responsibilities; Live selection reads the
current DOM caret so native navigation immediately followed by paste stays exact.

The Live adapter accepts `wikiDocuments()` for `[[...]]` completion, `onTag(tag)`
for tag navigation, and `onNotice(message)` to route metadata warnings to the
host's status area. Both editors expose `selectAtPoint(x, y)` for image drops.
`readMetadataTags`, `updateMetadataTags`, and `normalizeTags` provide the same
tag semantics to hosts; unrelated YAML and body spelling is preserved.

Wiki links use `[[target|alias]]` and remain wiki syntax when serialized.
`mergeSharedUpdates` supports durable host-side storage of unacknowledged
Yjs updates; transport, encryption and authenticated storage remain host concerns.

The additional exports `./helpers`, `./markdown`, `./math`, `./roundtrip`, and
`./source` are available for focused tests and integrations.

## Live formula editing

Inline `$...$` and display `$$...$$` formulas are regular editable ProseMirror
text content. Click the rendered formula or focus it with the keyboard to reveal
its TeX source. Typing, selection, Undo/Redo, history, dirty tracking, and saving
use the same document transactions as surrounding text; KaTeX updates after
every edit with `trust: false`.

## Development

Host UI styling can set `--control-radius`, `--control-hover-background`,
`--control-selected-background`, `--control-focus-background`, and
`--control-focus-ring`. Metadata, tag, formula, and completion controls share
these variables, with standalone defaults when the host does not supply them.
Keyboard buttons use rounded surface feedback; text fields use a full inset
focus ring rather than a bottom highlight bar.

```bash
npm install
npm run build
npm test
npm run benchmark:math-cache
npm run benchmark:math
npm run benchmark:math-edit
npm run benchmark:source-prepare
```

The build writes self-contained assets and third-party notices to `dist/`.
Notes App copies these assets into `web/public/` during its aggregate build.
