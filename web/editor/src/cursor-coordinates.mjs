export function currentViewSelection(view) {
  const selection = view.dom.ownerDocument.getSelection();
  if (selection?.anchorNode && selection.focusNode
      && view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode)) {
    return {
      anchor: view.posAtDOM(selection.anchorNode, selection.anchorOffset),
      head: view.posAtDOM(selection.focusNode, selection.focusOffset),
    };
  }
  return view.state.selection;
}

export function textareaCursorRect(textarea, position) {
  const bounds = textarea.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "fixed", top: `${bounds.top}px`, left: `${bounds.left}px`,
    width: `${textarea.clientWidth}px`, boxSizing: "border-box", visibility: "hidden",
    whiteSpace: textarea.wrap === "off" ? "pre" : "pre-wrap", overflowWrap: "break-word",
    font: style.font, letterSpacing: style.letterSpacing, tabSize: style.tabSize,
    padding: style.padding, border: "0", pointerEvents: "none",
  });
  mirror.textContent = textarea.value.slice(0, position);
  const span = document.createElement("span");
  span.textContent = textarea.value.slice(position) || "\u200b";
  mirror.append(span);
  document.body.append(mirror);
  try {
    const rect = span.getClientRects()[0] ?? span.getBoundingClientRect();
    const top = rect.top - textarea.scrollTop + textarea.clientTop;
    const left = rect.left - textarea.scrollLeft + textarea.clientLeft;
    return { top, bottom: top + parseFloat(style.lineHeight), left, right: left };
  } finally {
    mirror.remove();
  }

}
export function lineColumn(source, position) {
  const lines = source.slice(0, position).split(/\r\n|\r|\n/);
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

export function rawOffset(raw, normalizedOffset) {
  let position = 0;
  let normalized = 0;
  while (position < raw.length && normalized < normalizedOffset) {
    position += raw[position] === "\r" && raw[position + 1] === "\n" ? 2 : 1;
    normalized++;
  }
  return position;
}

export function textareaOffsetAtPoint(textarea, x, y) {
  const bounds = textarea.getBoundingClientRect();
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.contentEditable = "true";
  Object.assign(mirror.style, {
    position: "fixed", top: `${bounds.top - textarea.scrollTop}px`, left: `${bounds.left - textarea.scrollLeft}px`,
    width: `${textarea.clientWidth}px`, boxSizing: "border-box", opacity: "0", zIndex: "2147483647",
    whiteSpace: textarea.wrap === "off" ? "pre" : "pre-wrap", overflowWrap: "break-word",
    font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, tabSize: style.tabSize,
    padding: style.padding, border: "0",
  });
  const text = document.createTextNode(textarea.value || "\u200b");
  mirror.append(text);
  document.body.append(mirror);
  try {
    const position = document.caretPositionFromPoint?.(x, y);
    if (position?.offsetNode === text) return Math.min(textarea.value.length, position.offset);
    const range = document.caretRangeFromPoint?.(x, y);
    return range?.startContainer === text ? Math.min(textarea.value.length, range.startOffset) : textarea.value.length;
  } finally { mirror.remove(); }
}
