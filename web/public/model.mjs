export const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;

const encoder = new TextEncoder();

export function normalizeEditorText(text) {
  return text.replace(/\r\n?/g, "\n");
}

export function normalizeNotePath(path) {
  return path.replace(/\\/g, "/");
}

export function createDocumentModel(document) {
  const bom = document.content.startsWith("\uFEFF");
  const source = bom ? document.content.slice(1) : document.content;
  const counts = new Map();
  let lineEnding = null;
  for (let index = 0; index < source.length; index += 1) {
    let ending;
    if (source[index] === "\r") {
      ending = source[index + 1] === "\n" ? "\r\n" : "\r";
      if (ending === "\r\n") index += 1;
    } else if (source[index] === "\n") {
      ending = "\n";
    } else {
      continue;
    }
    lineEnding ??= ending;
    counts.set(ending, (counts.get(ending) ?? 0) + 1);
  }
  for (const [ending, count] of counts) {
    if (count > (counts.get(lineEnding) ?? 0)) lineEnding = ending;
  }
  return {
    path: document.path,
    content: document.content,
    html: document.html,
    version: document.version,
    text: normalizeEditorText(source),
    format: { bom, lineEnding: lineEnding ?? "\n" },
  };
}

export function isDirty(document, editorText) {
  return Boolean(document && normalizeEditorText(editorText) !== document.text);
}

export function serializeEditorText(document, editorText) {
  const text = normalizeEditorText(editorText);
  if (text === document.text) return document.content;
  let from = 0;
  while (from < document.text.length && from < text.length && document.text[from] === text[from]) from += 1;
  let oldTo = document.text.length;
  let newTo = text.length;
  while (oldTo > from && newTo > from && document.text[oldTo - 1] === text[newTo - 1]) {
    oldTo -= 1;
    newTo -= 1;
  }
  const bom = document.format.bom ? "\uFEFF" : "";
  const source = bom ? document.content.slice(1) : document.content;
  let raw = 0;
  let normalized = 0;
  // Keep unchanged YAML headers and body suffixes in their original byte spelling,
  // including mixed line endings that a textarea cannot represent.
  const [rawFrom, rawTo] = [from, oldTo].map((target) => {
    while (normalized < target) {
      raw += source[raw] === "\r" && source[raw + 1] === "\n" ? 2 : 1;
      normalized += 1;
    }
    return raw;
  });
  const prefix = source.slice(0, rawFrom);
  const suffix = source.slice(rawTo);
  let changed = text.slice(from, newTo).replace(/\n/g, document.format.lineEnding);
  // Two separate newlines must not become a single CRLF pair at a splice.
  if (!changed && prefix.endsWith("\r") && suffix.startsWith("\n")) changed = "\r";
  else if (changed) {
    if (prefix.endsWith("\r") && changed.startsWith("\n")) changed = "\r" + changed;
    if (changed.endsWith("\r") && suffix.startsWith("\n")) changed += "\n";
  }
  return bom + prefix + changed + suffix;
}

export function createSaveSnapshot(document, editorText) {
  return Object.freeze({
    path: document.path,
    version: document.version,
    text: normalizeEditorText(editorText),
    content: serializeEditorText(document, editorText),
  });
}

export function reconcileSave(snapshot, response, currentEditorText) {
  if (response.path !== snapshot.path) {
    throw new Error("The service returned a different note after saving.");
  }
  const document = createDocumentModel(response);
  const currentText = normalizeEditorText(currentEditorText);
  const text = currentText === snapshot.text ? document.text : currentText;
  return { document, text, dirty: isDirty(document, text) };
}

export function markdownByteLength(content) {
  return encoder.encode(content).byteLength;
}

export function formatByteCount(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function validateNewNotePath(value) {
  const path = normalizeNotePath(value.trim());
  if (!path) throw new Error("Enter a relative path for the new note.");
  if (path.startsWith("/") || /^[a-z]:/i.test(path)) {
    throw new Error("Use a path relative to the notes folder, not an absolute path.");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Use a file name and existing folders, without empty, . or .. segments.");
  }
  if (parts.some((part) => /[<>:"|?*\u0000-\u001F]/u.test(part) || /[. ]$/.test(part))) {
    throw new Error("Use portable file and folder names without reserved characters or a trailing space or period.");
  }
  if (parts.some((part) => /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error("Names such as CON or NUL are reserved for cross-platform compatibility.");
  }
  if (!/\.(md|markdown)$/i.test(parts.at(-1))) {
    throw new Error("The new note must end in .md or .markdown.");
  }
  return path;
}

export function filterNotes(files, query) {
  const needle = normalizeNotePath(query.trim()).toLowerCase();
  if (!needle) return files;
  return files.filter((file) =>
    file.path.toLowerCase().includes(needle) || file.name.toLowerCase().includes(needle),
  );
}

export function buildFileTree(files) {
  const root = { name: "", path: "", directories: new Map(), files: [] };
  for (const file of files) {
    const parts = normalizeNotePath(file.path).split("/");
    let parent = root;
    for (const name of parts.slice(0, -1)) {
      if (!parent.directories.has(name)) {
        const path = parent.path ? `${parent.path}/${name}` : name;
        parent.directories.set(name, { name, path, directories: new Map(), files: [] });
      }
      parent = parent.directories.get(name);
    }
    parent.files.push(file);
  }
  const compare = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  function finish(branch) {
    return {
      name: branch.name,
      path: branch.path,
      directories: [...branch.directories.values()].sort(compare).map(finish),
      files: [...branch.files].sort(compare),
    };
  }
  return finish(root);
}

export function readLaunchUrl(value) {
  const url = new URL(value);
  const parts = url.hash.slice(1).split("&");
  const ordinaryFragments = [];
  let token = null;
  for (const part of parts) {
    const match = /^token=([a-f0-9]+)$/i.exec(part);
    if (match) {
      token ??= match[1];
    } else {
      ordinaryFragments.push(part);
    }
  }
  if (token !== null) url.hash = ordinaryFragments.join("&");
  return { url, token };
}

export function readNoteRoute(value) {
  const url = new URL(value);
  const path = url.searchParams.get("file");
  return { path: path ? normalizeNotePath(path) : null, hash: url.hash };
}

export function makeNoteUrl(value, path, hash = "") {
  const url = new URL(value);
  if (path) url.searchParams.set("file", normalizeNotePath(path));
  else url.searchParams.delete("file");
  url.hash = hash;
  return url;
}

export class RequestGate {
  #sequence = 0;

  next() {
    return ++this.#sequence;
  }

  isCurrent(ticket) {
    return ticket === this.#sequence;
  }

  invalidate() {
    this.#sequence += 1;
  }
}
