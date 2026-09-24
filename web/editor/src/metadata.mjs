import { isMap, parseDocument } from "yaml";
import { replaceMetadataText } from "./editor-helpers.mjs";
import { attachScrollbars } from "./scrollbars.mjs";
import { lineColumn, rawOffset } from "./cursor-coordinates.mjs";
import { mountTagEditor, tagsFromValues } from "./metadata-tags.mjs";

export function mountMetadata(state, page, { readOnly, styleNonce, active, fullSource, onTitle, onChange, publishOutline, onSelection, onTag, onNotice }) {
  if (!state.parts.hasMetadata) { onTitle?.(null); onNotice?.(""); return; }
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
  summary.append(disclosure, caption);
  const panel = document.createElement("div");
  panel.className = "notes-metadata-panel";
  const textarea = document.createElement("textarea");
  textarea.className = "notes-metadata-source";
  textarea.setAttribute("aria-label", "YAML metadata source");
  textarea.spellcheck = false;
  textarea.disabled = readOnly;
  textarea.value = state.parts.raw;
  textarea.rows = Math.max(4, Math.min(10, textarea.value.split("\n").length));
  const metadataScroll = document.createElement("div");
  metadataScroll.className = "notes-metadata-scroll";
  metadataScroll.setAttribute("data-overlayscrollbars-initialize", "");
  metadataScroll.append(textarea);
  const warning = document.createElement("p");
  warning.className = "notes-metadata-warning";
  warning.setAttribute("role", "alert");
  warning.id = `notes-metadata-warning-${state.ticket}`;
  warning.hidden = true;
  textarea.setAttribute("aria-describedby", warning.id);
  const showWarning = (message) => {
    warning.textContent = message;
    warning.hidden = Boolean(onNotice) || !message;
    onNotice?.(message);
  };
  panel.append(metadataScroll);
  const tags = mountTagEditor(panel, textarea, { onTag, onError: showWarning });
  tags.setReadOnly(readOnly);
  details.append(summary, panel);
  region.append(details, warning);
  page.append(region);
  state.scrollbars.push(attachScrollbars(metadataScroll, textarea, { nonce: styleNonce }));
  state.metadata = { details, textarea, tags };
  const updateSummary = () => {
    let message = "";
    let title = "";
    let values = [];
    try {
      const parsed = parseDocument(state.parts.raw, { prettyErrors: true, uniqueKeys: true });
      if (parsed.errors.length) message = `Invalid YAML: ${parsed.errors[0].message}`;
      else if (!isMap(parsed.contents)) message = "Metadata should be a YAML mapping (key: value). Its original text is preserved.";
      else {
        const data = parsed.toJS({ maxAliasCount: 50 });
        title = typeof data.title === "string" || typeof data.title === "number" ? String(data.title) : "";
        values = tagsFromValues(data);
        if (parsed.warnings.length) message = parsed.warnings[0].message;
      }
    } catch (error) { message = `YAML could not be read safely: ${error.message}. Its raw text is kept.`; }
    if (message) summary.setAttribute("aria-describedby", warning.id);
    else summary.removeAttribute("aria-describedby");
    showWarning(message);
    textarea.setAttribute("aria-invalid", String(Boolean(message)));
    tags.render(values);
    onTitle?.(title || null);
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
  state.refreshMetadata = updateSummary;
  for (const event of ["select", "keyup", "click", "focus"]) textarea.addEventListener(event, selection);
  updateSummary();
}
