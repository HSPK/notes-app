import { Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import "./source-editor.css";
import { textareaCursorRect, textareaOffsetAtPoint } from "./cursor-coordinates.mjs";

const VIRTUAL_SOURCE_THRESHOLD = 768 * 1024;
const encoder = new TextEncoder();

export function createSourceEditor({ textarea, nonce, threshold = VIRTUAL_SOURCE_THRESHOLD }) {
  const pane = textarea.parentElement;
  const host = document.createElement("div");
  host.className = "virtual-source-editor";
  host.hidden = true;
  textarea.after(host);
  const editable = new Compartment();
  const wrapping = new Compartment();
  let view = null;
  let lineWrapping = true;
  let disabled = textarea.disabled;
  let readOnly = false;
  const editability = () => [EditorView.editable.of(!disabled && !readOnly), EditorState.readOnly.of(disabled || readOnly)];
  let syncing = false;
  let cachedDocument = null;
  let cachedValue = "";
  let virtualSize = null;

  const invalidateVirtualSize = () => { virtualSize = null; };
  textarea.addEventListener("input", invalidateVirtualSize);

  const value = () => {
    if (!view) return textarea.value;
    if (cachedDocument !== view.state.doc) {
      cachedDocument = view.state.doc;
      cachedValue = view.state.doc.toString();
    }
    return cachedValue;
  };

  const emitInput = (changes) => textarea.dispatchEvent(
    changes ? new CustomEvent("input", { detail: { changes } }) : new Event("input"),
  );
  const createView = (text) => {
    pane.classList.add("is-virtual-source");
    textarea.hidden = true;
    textarea.value = "";
    host.hidden = false;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorState.tabSize.of(4),
          wrapping.of(EditorView.lineWrapping),
          EditorView.cspNonce.of(nonce),
          EditorView.contentAttributes.of({
            "aria-label": "Markdown source",
            "aria-multiline": "true",
            "aria-describedby": textarea.getAttribute("aria-describedby") ?? "",
            "aria-invalid": textarea.getAttribute("aria-invalid") ?? "false",
            autocomplete: "off",
            autocapitalize: "off",
            spellcheck: "false",
          }),
          editable.of(editability()),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncing) {
              cachedDocument = null;
              const ranges = [];
              update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
                ranges.push({ fromA, toA, fromB, toB });
              });
              emitInput({
                ranges,
                beforeLength: update.startState.doc.length,
                afterLength: update.state.doc.length,
              });
            }
          }),
        ],
      }),
    });
    cachedDocument = view.state.doc;
    cachedValue = text;
  };

  const destroyView = (text = value()) => {
    view?.destroy();
    view = null;
    cachedDocument = null;
    cachedValue = "";
    host.replaceChildren();
    host.hidden = true;
    textarea.hidden = false;
    textarea.value = text;
    invalidateVirtualSize();
    pane.classList.remove("is-virtual-source");
  };

  const setValue = (text, reset = false) => {
    text = String(text);
    if (reset && view) destroyView("");
    if (!view) {
      textarea.value = text;
      invalidateVirtualSize();
      return;
    }
    if (value() === text) return;
    syncing = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      annotations: Transaction.addToHistory.of(false),
    });
    syncing = false;
    cachedDocument = view.state.doc;
    cachedValue = text;
  };

  return {
    get value() { return value(); },
    set value(text) { setValue(text); },
    get disabled() { return disabled; },
    set disabled(value) {
      const next = Boolean(value);
      if (next === disabled) return;
      disabled = next;
      textarea.disabled = disabled;
      if (view) {
        view.dispatch({ effects: editable.reconfigure(editability()) });
      }
    },
    setReadOnly(value) {
      if (readOnly === Boolean(value)) return;
      readOnly = Boolean(value);
      textarea.readOnly = readOnly;
      if (view) view.dispatch({ effects: editable.reconfigure(editability()) });
    },
    get scrollTop() { return view ? view.scrollDOM.scrollTop : textarea.scrollTop; },
    set scrollTop(value) {
      if (view) view.scrollDOM.scrollTop = value;
      else textarea.scrollTop = value;
    },
    get selectionStart() {
      return view ? view.state.selection.main.head : textarea.selectionStart;
    },
    getSelection() {
      return view
        ? { from: view.state.selection.main.anchor, to: view.state.selection.main.head }
        : { from: textarea.selectionStart, to: textarea.selectionEnd };
    },
    cursorRect(position) {
      return view ? view.coordsAtPos(Math.max(0, Math.min(view.state.doc.length, position)))
        : textareaCursorRect(textarea, position);
    },
    viewportRect() { return (view?.scrollDOM ?? textarea).getBoundingClientRect(); },
    get lineHeight() {
      return Number.parseFloat(getComputedStyle(view?.contentDOM ?? textarea).lineHeight);
    },
    reset(text) { setValue(text, true); },
    prepare() {
      if (view) return;
      virtualSize ??= encoder.encode(textarea.value).byteLength >= threshold;
      if (virtualSize) createView(textarea.value);
    },
    focus(options) {
      this.prepare();
      if (view) view.contentDOM.focus(options);
      else textarea.focus(options);
    },
    select() {
      if (view) {
        view.dispatch({
          selection: EditorSelection.range(0, view.state.doc.length),
          scrollIntoView: true,
        });
      } else textarea.select();
    },
    setSelectionRange(from, to) {
      this.prepare();
      if (view) {
        const length = view.state.doc.length;
        view.dispatch({
          selection: EditorSelection.range(
            Math.max(0, Math.min(length, from)),
            Math.max(0, Math.min(length, to)),
          ),
        });
      } else textarea.setSelectionRange(from, to);
    },
    selectAtPoint(x, y) {
      this.prepare();
      const position = view ? view.posAtCoords({ x, y }) : textareaOffsetAtPoint(textarea, x, y);
      if (position === null) return false;
      this.setSelectionRange(position, position);
      this.focus();
      return true;
    },
    setAttribute(name, next) {
      textarea.setAttribute(name, next);
      view?.contentDOM.setAttribute(name, next);
    },
    setLineWrapping(value) {
      lineWrapping = Boolean(value);
      textarea.wrap = lineWrapping ? "soft" : "off";
      if (view) {
        view.dispatch({
          effects: wrapping.reconfigure(lineWrapping ? EditorView.lineWrapping : []),
        });
      }
    },
    setThreshold(bytes) {
      threshold = Math.max(256 * 1024, Number(bytes) || VIRTUAL_SOURCE_THRESHOLD);
      invalidateVirtualSize();
    },
    addEventListener(...args) { textarea.addEventListener(...args); },
    dispatchEvent(event) { return textarea.dispatchEvent(event); },
    isVirtual() { return Boolean(view); },
    destroy() {
      textarea.removeEventListener("input", invalidateVirtualSize);
      destroyView("");
      host.remove();
    },
  };
}
