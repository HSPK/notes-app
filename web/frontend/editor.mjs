import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx } from "@milkdown/core";
import {
  commonmark, toggleStrongCommand, toggleEmphasisCommand, wrapInHeadingCommand,
  wrapInBulletListCommand, wrapInBlockquoteCommand, createCodeBlockCommand,
} from "@milkdown/preset-commonmark";
import { gfm, insertTableCommand } from "@milkdown/preset-gfm";
import { history, undoCommand, redoCommand } from "@milkdown/plugin-history";
import { $prose, callCommand } from "@milkdown/utils";
import { Plugin, TextSelection } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { parseDocument, isMap } from "yaml";
import { parser as cppParser } from "@lezer/cpp";
import { parser as javascriptParser } from "@lezer/javascript";
import { parser as rustParser } from "@lezer/rust";
import { tags, tagHighlighter, highlightTree } from "@lezer/highlight";
import {
  resolveMarkdownUrl, splitFrontMatter, replaceMetadataText, assignHeadingIds, validateAppearance, quoteFontFamily, cssFontFamily, isGenericFontFamily,
} from "./editor-helpers.mjs";
import { extractOutline, parseBody, unsupportedBody, bodyFingerprint, sourcePositionMap } from "./markdown.mjs";
import "./editor.css";
import { attachScrollbars } from "./scrollbars.mjs";

export { extractOutline, attachScrollbars };

const appearanceRoots = new WeakMap();
let fontGeneration = 0;
const cjkGlyphs = "U+2E80-2FFF,U+3000-303F,U+3040-30FF,U+3100-312F,U+31A0-31FF,U+31C0-31EF,U+3400-4DBF,U+4E00-9FFF,U+AC00-D7AF,U+F900-FAFF,U+FE30-FE4F,U+FF00-FFEF,U+20000-323AF";

export function applyAppearance(value, root = document.documentElement) {
  const settings = validateAppearance(value);
  const signature = JSON.stringify(settings);
  const previous = appearanceRoots.get(root);
  if (previous?.signature === signature) {
    return previous.fontResult.then((warning) => ({ changed: false, warning: previous.face?.status === "loaded" ? "" : warning }));
  }
  const state = { ...previous, settings, signature };
  appearanceRoots.set(root, state);
  if (root.dataset.theme !== settings.theme) root.dataset.theme = settings.theme;
  if (!previous || previous.settings.latinFont !== settings.latinFont || previous.settings.cjkFont !== settings.cjkFont) {
    const owner = root.ownerDocument;
    const latin = cssFontFamily(settings.latinFont);
    const cjk = cssFontFamily(settings.cjkFont);
    if (!previous || previous.settings.cjkFont !== settings.cjkFont) {
      state.face = null;
      state.alias = "";
      const genericCjk = isGenericFontFamily(settings.cjkFont);
      state.fontResult = Promise.resolve(genericCjk ? "" : "This browser uses a font-stack fallback for Chinese text.");
      if (!genericCjk && typeof FontFace !== "undefined" && owner.fonts) {
        try {
          // A local, CJK-only face precedes the English family, even when that family
          // also contains Han glyphs. No font URLs, downloads, or CSS rules are used.
          const alias = `Notes Local CJK ${++fontGeneration}`;
          const face = new FontFace(alias, `local(${cjk})`, { unicodeRange: cjkGlyphs });
          owner.fonts.add(face);
          state.face = face;
          state.alias = alias;
          let timeout;
          state.fontResult = Promise.race([
            face.load().then(() => "", () => `The Chinese font “${settings.cjkFont}” is unavailable. Using a local fallback.`),
            new Promise((resolve) => { timeout = window.setTimeout(() => resolve("The selected Chinese font is taking too long to load. Using a local fallback."), 4000); }),
          ]).finally(() => window.clearTimeout(timeout));
        } catch {
          state.fontResult = Promise.resolve("The selected Chinese font could not be configured. Using a local fallback.");
        }
      }
    }
    const family = state.alias ? `${quoteFontFamily(state.alias)}, ` : "";
    const set = (name, text) => { if (root.style.getPropertyValue(name) !== text) root.style.setProperty(name, text); };
    set("--font-latin", latin);
    set("--font-cjk", cjk);
    set("--document-font", `${family}${latin}, ${cjk}, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`);
    set("--code-font", `"Cascadia Code", Consolas, ${family}monospace`);
    if (previous?.face && previous.face !== state.face) owner.fonts.delete(previous.face);
  }
  return state.fontResult.then((warning) => ({ changed: true, warning: state.face?.status === "loaded" ? "" : warning }));
}

const codeHighlighter = tagHighlighter([
  { tag: tags.keyword, class: "notes-code-keyword" },
  { tag: [tags.string, tags.character], class: "notes-code-string" },
  { tag: [tags.number, tags.bool, tags.null], class: "notes-code-number" },
  { tag: tags.comment, class: "notes-code-comment" },
  { tag: tags.typeName, class: "notes-code-type" },
  { tag: tags.function(tags.variableName), class: "notes-code-function" },
]);

function codeParser(language = "") {
  const name = language.trim().split(/\s+/)[0].toLowerCase();
  if (["c", "c++", "cpp", "cc", "cxx", "h", "hpp"].includes(name)) return cppParser;
  if (["javascript", "js", "mjs", "cjs", "jsx"].includes(name)) return javascriptParser.configure(name === "jsx" ? { dialect: "jsx" } : {});
  if (["typescript", "ts", "tsx"].includes(name)) return javascriptParser.configure({ dialect: name === "tsx" ? "ts jsx" : "ts" });
  if (["rust", "rs"].includes(name)) return rustParser;
  return null;
}

function documentHeadings(document) {
  const headings = [];
  document.descendants((node, position) => {
    if (node.type.name !== "heading") return;
    let text = "";
    node.descendants((child) => {
      if (child.isText) text += child.text;
      else if (child.type.name === "image") text += child.attrs.alt ?? "";
      else if (child.type.name === "hardbreak") text += " ";
    });
    headings.push({ node, position, text });
  });
  const ids = assignHeadingIds(headings.map((heading) => heading.text));
  return headings.map((heading, index) => ({ ...heading, id: ids[index] }));
}

function lineColumn(source, position) {
  const lines = source.slice(0, position).split(/\r\n|\r|\n/);
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function rawOffset(raw, normalizedOffset) {
  let position = 0;
  let normalized = 0;
  while (position < raw.length && normalized < normalizedOffset) {
    position += raw[position] === "\r" && raw[position + 1] === "\n" ? 2 : 1;
    normalized++;
  }
  return position;
}

export function createInlineEditor({ root, toolbar, onChange, onFallback, onLink, onReady, onOutline, onSelection, styleNonce }) {
  let generation = 0;
  let session = null;
  const buttons = [];
  const active = (state) => session === state && state.ticket === generation;
  const fullSource = (state) => state.parts.prefix + state.bodySource;

  function publishOutline(state) {
    if (!active(state)) return;
    const items = extractOutline(fullSource(state));
    const signature = JSON.stringify(items);
    state.outline = items;
    if (signature !== state.outlineSignature) {
      state.outlineSignature = signature;
      onOutline?.(items);
    }
  }

  function positionMap(state, view) {
    if (state.mapDocument !== view.state.doc || state.mapSource !== state.bodySource) {
      state.map = sourcePositionMap(state.bodyAst, state.bodySource, view.state.doc);
      state.mapDocument = view.state.doc;
      state.mapSource = state.bodySource;
    }
    return state.map;
  }

  function sourcePosition(state, view, position) {
    const map = positionMap(state, view);
    const entry = map.find((item) => item.position >= position);
    return state.parts.bodyStart + (entry?.source ?? (map.at(-1)?.source ?? 0) + (map.length ? 1 : 0));
  }

  function publishSelection(state, view = state.view) {
    if (!active(state) || !view || !state.ready) return;
    onSelection?.(lineColumn(fullSource(state), sourcePosition(state, view, view.state.selection.head)));
  }

  function metadataRegion(state, page) {
    if (!state.parts.hasMetadata) return;
    const region = document.createElement("section");
    region.className = "notes-metadata frontmatter";
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const disclosure = document.createElement("span");
    disclosure.className = "notes-metadata-disclosure";
    disclosure.setAttribute("aria-hidden", "true");
    const caption = document.createElement("span");
    caption.className = "notes-metadata-caption";
    caption.textContent = "Metadata";
    const summaryText = document.createElement("span");
    summaryText.className = "notes-metadata-summary";
    const tagsList = document.createElement("span");
    tagsList.className = "notes-metadata-tags";
    const status = document.createElement("span");
    status.className = "notes-metadata-status";
    status.textContent = "Check YAML";
    status.hidden = true;
    summary.append(disclosure, caption, summaryText, tagsList, status);
    const panel = document.createElement("div");
    panel.className = "notes-metadata-panel";
    const description = document.createElement("p");
    description.className = "notes-metadata-description";
    description.hidden = true;
    const editorHeading = document.createElement("div");
    editorHeading.className = "notes-metadata-editor-heading";
    const label = document.createElement("label");
    label.textContent = "YAML";
    const syntaxLabel = document.createElement("span");
    syntaxLabel.textContent = "Document properties";
    editorHeading.append(label, syntaxLabel);
    const textarea = document.createElement("textarea");
    textarea.className = "notes-metadata-source";
    textarea.id = `notes-metadata-source-${state.ticket}`;
    label.htmlFor = textarea.id;
    textarea.setAttribute("aria-label", "YAML metadata source");
    textarea.spellcheck = false;
    textarea.value = state.parts.raw;
    textarea.rows = Math.max(4, Math.min(10, textarea.value.split("\n").length));
    const metadataScroll = document.createElement("div");
    metadataScroll.className = "notes-metadata-scroll";
    metadataScroll.setAttribute("data-overlayscrollbars-initialize", "");
    metadataScroll.append(textarea);
    const hint = document.createElement("p");
    hint.className = "notes-metadata-hint";
    hint.textContent = "Comments and custom properties stay as written.";
    hint.id = `notes-metadata-hint-${state.ticket}`;
    const warning = document.createElement("p");
    warning.className = "notes-metadata-warning";
    warning.setAttribute("role", "alert");
    warning.id = `notes-metadata-warning-${state.ticket}`;
    warning.hidden = true;
    textarea.setAttribute("aria-describedby", `${hint.id} ${warning.id}`);
    panel.append(description, editorHeading, metadataScroll, hint);
    details.append(summary, panel);
    region.append(details, warning);
    page.append(region);
    state.scrollbars.push(attachScrollbars(metadataScroll, textarea, { nonce: styleNonce }));
    state.metadata = { details, textarea };
    const updateSummary = () => {
      let message = "";
      let title = "";
      let descriptionText = "";
      let tagValues = [];
      try {
        const parsed = parseDocument(state.parts.raw, { prettyErrors: true, uniqueKeys: true });
        if (parsed.errors.length) message = `Invalid YAML: ${parsed.errors[0].message}`;
        else if (!isMap(parsed.contents)) message = "Metadata should be a YAML mapping (key: value). Its original text is preserved.";
        else {
          const values = parsed.toJS({ maxAliasCount: 50 });
          const text = (value) => typeof value === "string" || typeof value === "number" ? String(value) : "";
          title = text(values.title);
          descriptionText = text(values.description);
          tagValues = Array.isArray(values.tags) ? values.tags.map(text).filter(Boolean) : text(values.tags) ? [text(values.tags)] : [];
          if (parsed.warnings.length) message = parsed.warnings[0].message;
        }
      } catch (error) {
        message = `YAML could not be read safely: ${error.message}. Its raw text is kept.`;
      }
      summaryText.textContent = title || (message ? "Needs attention" : "Document properties");
      summaryText.title = [title, descriptionText].filter(Boolean).join("\n");
      description.textContent = descriptionText;
      description.hidden = !descriptionText;
      const chips = tagValues.slice(0, 3).map((tag) => {
        const chip = document.createElement("span");
        chip.className = "notes-metadata-tag";
        chip.textContent = tag;
        chip.title = tag;
        return chip;
      });
      if (tagValues.length > 3) {
        const count = document.createElement("span");
        count.className = "notes-metadata-tag-count";
        count.textContent = `+${tagValues.length - 3}`;
        count.title = tagValues.slice(3).join(", ");
        chips.push(count);
      }
      tagsList.replaceChildren(...chips);
      tagsList.hidden = !tagValues.length;
      tagsList.setAttribute("aria-label", `Tags: ${tagValues.join(", ")}`);
      status.hidden = !message;
      if (message) summary.setAttribute("aria-describedby", warning.id);
      else summary.removeAttribute("aria-describedby");
      warning.textContent = message;
      warning.hidden = !message;
      textarea.setAttribute("aria-invalid", String(Boolean(message)));
    };
    textarea.addEventListener("input", () => {
      if (!active(state)) return;
      state.parts = replaceMetadataText(state.parts, textarea.value);
      updateSummary();
      onChange(fullSource(state));
      publishOutline(state);
    });
    const selection = () => {
      if (!active(state)) return;
      const offset = state.parts.metadataStart + rawOffset(state.parts.raw, textarea.selectionStart);
      onSelection?.(lineColumn(fullSource(state), offset));
    };
    textarea.addEventListener("select", selection);
    textarea.addEventListener("keyup", selection);
    textarea.addEventListener("click", selection);
    textarea.addEventListener("focus", selection);
    updateSummary();
  }

  const commands = [
    ["Bold", "B", toggleStrongCommand],
    ["Italic", "I", toggleEmphasisCommand],
    ["Heading", "H2", wrapInHeadingCommand, { level: 2 }],
    ["Bullet list", "• List", wrapInBulletListCommand],
    ["Block quote", "❯ Quote", wrapInBlockquoteCommand],
    ["Code block", "</>", createCodeBlockCommand],
    ["Insert table", "Table", insertTableCommand, { row: 3, col: 3 }],
    ["Undo", "↶", undoCommand],
    ["Redo", "↷", redoCommand],
  ];
  for (const [title, text, command, payload] of commands) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.disabled = true;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      if (!session?.ready) return;
      session.editor.action(callCommand(command.key, payload));
      session.view.focus();
    });
    toolbar.append(button);
    buttons.push(button);
  }

  function clear() {
    generation++;
    const old = session;
    session = null;
    if (old) {
      old.ready = false;
      for (const scrollbar of old.scrollbars) scrollbar.destroy();
      if (old.editor) void old.editor.destroy().catch(console.error);
    }
    root.replaceChildren();
    root.setAttribute("aria-busy", "false");
    for (const button of buttons) button.disabled = true;
    onOutline?.([]);
  }

  async function load(source, path) {
    clear();
    const parts = splitFrontMatter(source);
    const state = {
      ticket: generation, parts, originalBody: parts.body, bodySource: parts.body,
      bodyAst: parseBody(parts.body), ready: false, editor: null, view: null,
      outline: [], outlineSignature: "",
      scrollbars: [],
    };
    session = state;
    root.dataset.editorMode = "formatted";
    const scroll = document.createElement("div");
    scroll.className = "notes-live-scroll";
    scroll.setAttribute("data-editor-scroller", "");
    const page = document.createElement("div");
    page.className = "notes-live-page";
    scroll.append(page);
    root.append(scroll);
    state.scrollbars.push(attachScrollbars(root, scroll, { nonce: styleNonce }));
    metadataRegion(state, page);
    publishOutline(state);
    const unsupported = unsupportedBody(state.bodyAst, state.bodySource);
    if (unsupported) {
      onFallback(unsupported);
      return;
    }
    const mount = document.createElement("div");
    mount.className = "notes-prose";
    page.append(mount);
    root.setAttribute("aria-busy", "true");
    let instance;
    const decorationCache = new WeakMap();
    const behavior = $prose((ctx) => new Plugin({
      props: {
        editable: () => state.ready && active(state),
        attributes: {
          role: "textbox", "aria-label": "Formatted Markdown editor", "aria-multiline": "true", spellcheck: "true",
        },
        nodeViews: {
          list_item(node, view, getPos) {
            const dom = document.createElement("li");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "notes-task-checkbox";
            checkbox.contentEditable = "false";
            const contentDOM = document.createElement("div");
            dom.append(checkbox, contentDOM);
            const update = () => {
              checkbox.hidden = node.attrs.checked == null;
              checkbox.checked = node.attrs.checked === true;
              checkbox.setAttribute("aria-label", checkbox.checked ? "Mark task incomplete" : "Mark task complete");
              dom.classList.toggle("notes-task-item", node.attrs.checked != null);
            };
            checkbox.addEventListener("change", () => {
              const position = getPos();
              if (!active(state) || !state.ready || typeof position !== "number") return;
              view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, checked: checkbox.checked }));
            });
            update();
            return {
              dom, contentDOM,
              update(next) {
                if (next.type !== node.type) return false;
                node = next;
                update();
                return true;
              },
              stopEvent: (event) => event.target === checkbox,
              ignoreMutation: (mutation) => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
            };
          },
          code_block(node) {
            const dom = document.createElement("div");
            dom.className = "notes-code-block";
            const gutter = document.createElement("div");
            gutter.className = "notes-code-gutter";
            gutter.contentEditable = "false";
            gutter.setAttribute("aria-hidden", "true");
            const pre = document.createElement("pre");
            const contentDOM = document.createElement("code");
            const scrollHost = document.createElement("div");
            scrollHost.className = "notes-code-scroll";
            scrollHost.setAttribute("data-overlayscrollbars-initialize", "");
            pre.append(contentDOM);
            scrollHost.append(pre);
            dom.append(gutter, scrollHost);
            let scrollbar;
            let destroyed = false;
            queueMicrotask(() => {
              if (!destroyed && active(state)) {
                scrollbar = attachScrollbars(scrollHost, pre, { nonce: styleNonce });
              }
            });
            const update = () => {
              gutter.replaceChildren(...node.textContent.split("\n").map((_, index) => {
                const number = document.createElement("span");
                number.textContent = String(index + 1);
                return number;
              }));
              dom.dataset.language = node.attrs.language ?? "";
            };
            update();
            return {
              dom, contentDOM,
              destroy() {
                destroyed = true;
                scrollbar?.destroy();
              },
              update(next) {
                if (next.type !== node.type) return false;
                node = next;
                update();
                return true;
              },
              ignoreMutation: (mutation) => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
            };
          },
          image(node) {
            const dom = document.createElement("span");
            dom.className = "notes-inline-image";
            const update = (value) => {
              dom.replaceChildren();
              const url = resolveMarkdownUrl(value.attrs.src, path, true);
              if (url) {
                const image = document.createElement("img");
                image.src = url;
                image.alt = value.attrs.alt ?? "";
                image.title = value.attrs.title ?? "";
                image.loading = "lazy";
                dom.append(image);
              } else dom.textContent = `Image: ${value.attrs.alt || value.attrs.src || "unavailable"} (external or unsafe image not loaded)`;
            };
            update(node);
            return { dom, update(next) {
              if (next.type !== node.type) return false;
              update(next);
              return true;
            } };
          },
        },
        markViews: {
          link(mark) {
            const dom = document.createElement("a");
            const href = resolveMarkdownUrl(mark.attrs.href, path);
            if (href) dom.setAttribute("href", href);
            dom.rel = "noopener noreferrer";
            dom.title = href ? "Ctrl+click (⌘+click on Mac) to open link" : "Unsafe link disabled";
            return { dom, contentDOM: dom };
          },
        },
        handleDOMEvents: {
          click(view, event) {
            const link = event.target.closest?.("a");
            if (!link) return false;
            event.preventDefault();
            if ((event.ctrlKey || event.metaKey) && link.hasAttribute("href") && active(state)) onLink(link.getAttribute("href"));
            return false;
          },
          auxclick(view, event) {
            if (!event.target.closest?.("a")) return false;
            event.preventDefault();
            return true;
          },
          focus(view) { publishSelection(state, view); return false; },
        },
        decorations(editorState) {
          if (decorationCache.has(editorState.doc)) return decorationCache.get(editorState.doc);
          const items = documentHeadings(editorState.doc).map(({ node, position, id }) =>
            Decoration.node(position, position + node.nodeSize, { id }));
          editorState.doc.descendants((node, position) => {
            if (node.type.name !== "code_block" || !node.textContent) return;
            const parser = codeParser(node.attrs.language);
            if (parser) highlightTree(parser.parse(node.textContent), codeHighlighter, (from, to, classes) => {
              if (to > from) items.push(Decoration.inline(position + 1 + from, position + 1 + to, { class: classes }));
            });
          });
          const decorations = DecorationSet.create(editorState.doc, items);
          decorationCache.set(editorState.doc, decorations);
          return decorations;
        },
      },
      view() {
        return {
          update(view, previous) {
            if (!state.ready || !active(state)) return;
            if (!view.state.doc.eq(previous.doc)) {
              // History restores only the body baseline. Metadata is independent
              // and must survive a body undo, a save, or subsequent typing.
              state.bodySource = view.state.doc.eq(state.initialDoc) ? state.originalBody : ctx.get(serializerCtx)(view.state.doc);
              state.bodyAst = parseBody(state.bodySource);
              onChange(fullSource(state));
              publishOutline(state);
            }
            if (!view.state.doc.eq(previous.doc) || !view.state.selection.eq(previous.selection)) publishSelection(state, view);
          },
        };
      },
    }));
    try {
      instance = await Editor.make()
        .config((ctx) => { ctx.set(rootCtx, mount); ctx.set(defaultValueCtx, state.originalBody); })
        .use(commonmark).use(gfm).use(history).use(behavior).create();
      if (!active(state)) { await instance.destroy(); return; }
      state.editor = instance;
      state.view = instance.action((ctx) => ctx.get(editorViewCtx));
      state.initialDoc = state.view.state.doc;
      const serialized = instance.action((ctx) => ctx.get(serializerCtx)(state.initialDoc));
      if (bodyFingerprint(state.bodyAst) !== bodyFingerprint(parseBody(serialized))) {
        await instance.destroy();
        state.editor = null;
        onFallback("This body contains Markdown that formatted editing cannot safely round-trip. Use Source mode; the original text is kept.");
        root.setAttribute("aria-busy", "false");
        return;
      }
      state.ready = true;
      state.view.setProps({ editable: () => state.ready && active(state) });
      root.setAttribute("aria-busy", "false");
      for (const button of buttons) button.disabled = false;
      publishSelection(state);
      onReady?.();
    } catch (error) {
      if (instance) await instance.destroy().catch(() => {});
      if (!active(state)) return;
      root.setAttribute("aria-busy", "false");
      onFallback(`The formatted editor could not open this body. Its original source is preserved. ${error.message}`);
    }
  }

  function select(from, to = from, scroll = false) {
    const state = session;
    if (!state) return false;
    const source = fullSource(state);
    from = Math.max(0, Math.min(source.length, from));
    to = Math.max(0, Math.min(source.length, to));
    if (state.metadata && from < state.parts.bodyStart) {
      state.metadata.details.open = true;
      const normalized = (offset) => state.parts.raw.slice(0, Math.max(0, offset - state.parts.metadataStart)).replace(/\r\n?/g, "\n").length;
      state.metadata.textarea.focus();
      state.metadata.textarea.setSelectionRange(normalized(from), normalized(to));
      if (scroll) state.metadata.textarea.scrollIntoView({ block: "nearest" });
      return true;
    }
    if (!state.ready) return false;
    const map = positionMap(state, state.view);
    const position = (offset) => {
      const relative = offset - state.parts.bodyStart;
      const entry = map.find((item) => item.source >= relative);
      return entry?.position ?? (map.at(-1)?.position ?? 0) + 1;
    };
    const document = state.view.state.doc;
    const start = Math.max(0, Math.min(document.content.size, position(from)));
    const end = Math.max(0, Math.min(document.content.size, position(to)));
    let transaction = state.view.state.tr.setSelection(TextSelection.between(document.resolve(start), document.resolve(end)));
    if (scroll) transaction = transaction.scrollIntoView();
    state.view.dispatch(transaction);
    state.view.focus();
    return true;
  }

  return {
    load, clear,
    focus() { if (session?.ready) session.view.focus(); },
    getSource() { return session ? fullSource(session) : ""; },
    select,
    jumpTo(positionOrHeadingId) {
      const state = session;
      if (!state) return false;
      if (typeof positionOrHeadingId === "number" && Number.isFinite(positionOrHeadingId)) return select(Math.trunc(positionOrHeadingId), Math.trunc(positionOrHeadingId), true);
      if (typeof positionOrHeadingId !== "string") return false;
      let id = positionOrHeadingId.replace(/^#/, "");
      try { id = decodeURIComponent(id); } catch { /* Literal percent signs remain valid IDs. */ }
      const heading = state.outline.find((item) => item.id === id);
      if (!heading) return false;
      if (!state.ready) return select(heading.from, heading.from, true);
      const target = documentHeadings(state.view.state.doc).find((item) => item.id === id);
      if (!target) return false;
      state.view.dispatch(state.view.state.tr.setSelection(TextSelection.near(state.view.state.doc.resolve(target.position + 1))).scrollIntoView());
      state.view.focus();
      return true;
    },
  };
}
