import { parserCtx, serializerCtx } from "@milkdown/core";
import { splitFrontMatter } from "./editor-helpers.mjs";
import { parseBody, bodyFingerprint, unsupportedBody } from "./markdown.mjs";
import { normalizeSerializedBody } from "./roundtrip.mjs";

export function replaceRemoteSource(state, source) {
  const parts = splitFrontMatter(source);
  if (parts.hasMetadata !== state.parts.hasMetadata) return false;
  const ast = parseBody(parts.body);
  if (unsupportedBody(ast, parts.body)) return false;
  const doc = state.editor.action((ctx) => ctx.get(parserCtx)(parts.body));
  const serialized = state.editor.action((ctx) => ctx.get(serializerCtx)(doc));
  if (bodyFingerprint(ast) !== bodyFingerprint(parseBody(normalizeSerializedBody(serialized)))) return false;
  state.ready = false;
  try {
    state.parts = parts;
    state.bodySource = parts.body;
    state.originalBody = parts.body;
    state.bodyAst = ast;
    state.initialDoc = doc;
    if (!state.view.state.doc.eq(doc)) {
      state.view.dispatch(state.view.state.tr
        .replaceWith(0, state.view.state.doc.content.size, doc.content)
        .setMeta("addToHistory", false));
    }
    if (state.metadata) {
      state.metadata.textarea.value = parts.raw.replace(/\r\n?/g, "\n");
      state.refreshMetadata();
    }
  } finally {
    state.ready = true;
  }
  return true;
}
