export const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;

const encoder = new TextEncoder();
const resourceIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const isResourceId = (value) => typeof value === "string" && resourceIdPattern.test(value);

export function normalizeEditorText(text) {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function normalizeNotePath(path) {
  return path.replace(/\\/g, "/");
}

export function browserDocumentTitle(document, modified = false) {
  if (!document) return "Notes";
  const title = document.title?.trim() || normalizeNotePath(document.path).split("/").at(-1);
  return `${title}${modified ? " *" : ""} — Notes`;
}

export function createDocumentModel(document) {
  const raw = document.bom && !document.content.startsWith("\uFEFF") ? `\uFEFF${document.content}` : document.content;
  const bom = raw.startsWith("\uFEFF");
  const source = bom ? raw.slice(1) : raw;
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
    id: document.id,
    project: document.project,
    path: document.path,
    content: raw,
    html: document.html,
    version: document.version,
    title: typeof document.title === "string" ? document.title : null,
    text: normalizeEditorText(source),
    format: { bom, lineEnding: lineEnding ?? "\n", mixed: counts.size > 1 },
  };
}

export function isDirty(document, editorText) {
  return Boolean(document && normalizeEditorText(editorText) !== document.text);
}

export function serializeEditorText(document, editorText) {
  const text = normalizeEditorText(editorText);
  if (text === document.text) return document.content;
  const bom = document.format.bom ? "\uFEFF" : "";
  if (!document.format.mixed) {
    return bom + (document.format.lineEnding === "\n"
      ? text
      : text.replace(/\n/g, document.format.lineEnding));
  }
  let from = 0;
  while (from < document.text.length && from < text.length && document.text[from] === text[from]) from += 1;
  let oldTo = document.text.length;
  let newTo = text.length;
  while (oldTo > from && newTo > from && document.text[oldTo - 1] === text[newTo - 1]) {
    oldTo -= 1;
    newTo -= 1;
  }
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
    id: document.id,
    path: document.path,
    version: document.version,
    text: normalizeEditorText(editorText),
    content: serializeEditorText(document, editorText),
  });
}

export function reconcileSave(snapshot, response, currentEditorText) {
  if (!isResourceId(snapshot.id) || response.id !== snapshot.id) {
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

export function isReservedFileName(name) {
  const base = name.split(".")[0].trimEnd();
  return /^(con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(base);
}

function validatePortablePath(value, emptyMessage) {
  const path = normalizeNotePath(value.trim());
  if (!path) throw new Error(emptyMessage);
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
  if (parts.some(isReservedFileName)) {
    throw new Error("Names such as CON or NUL are reserved for cross-platform compatibility.");
  }
  return { path, parts };
}

export function validateNewNotePath(value) {
  const { path, parts } = validatePortablePath(value, "Enter a relative path for the new note.");
  if (!/\.(md|markdown)$/i.test(parts.at(-1))) {
    throw new Error("The new note must end in .md or .markdown.");
  }
  return path;
}

export function validateNewDirectoryPath(value) {
  const { path, parts } = validatePortablePath(value, "Enter a relative path for the new folder.");
  const forbidden = new Set(["node_modules", "target", "venv", "__pycache__", "build", "dist"]);
  if (parts.some((part) => part.startsWith(".") || forbidden.has(part.toLowerCase()))) {
    throw new Error("Hidden and dependency folders cannot be created.");
  }
  return path;
}

export function entryDestination(path, directory, replacementName = path.split("/").at(-1)) {
  const target = normalizeNotePath(directory).replace(/^\/+|\/+$/g, "");
  return target ? `${target}/${replacementName}` : replacementName;
}

export function parseHiddenPatterns(value) {
  const patterns = [...new Set(String(value ?? "")
    .split(/\r\n|\r|\n/)
    .map((line) => normalizeNotePath(line.trim()))
    .filter((line) => line && !line.startsWith("#")))];
  if (patterns.length > 100
      || patterns.some((pattern) => pattern.length > 200 || pattern.startsWith("/")
        || pattern.split("/").some((part) => part === "..")
        || /[\u0000-\u001f\u007f]/u.test(pattern))) {
    throw new Error("Use at most 100 relative hide patterns of up to 200 characters.");
  }
  return patterns;
}

export function createHiddenPathMatcher(patterns) {
  const expressions = patterns.map((pattern) => {
    const base = pattern.endsWith("/**") ? pattern.slice(0, -3)
      : pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
    const source = base.split("/").map((part, index, parts) => {
      const last = index === parts.length - 1;
      if (part === "**") return last ? ".*" : "(?:[^/]+/)*";
      const segment = part.replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", "[^/]*").replaceAll("?", "[^/]");
      return segment + (last ? "" : "/");
    }).join("");
    const suffix = "(?:/.*)?";
    return new RegExp(base.includes("/") ? `^${source}${suffix}$` : `(?:^|/)${source}${suffix}$`, "i");
  });
  return (value) => {
    const path = normalizeNotePath(value);
    return expressions.some((expression) => expression.test(path));
  };
}

const noteSearchCache = Symbol("noteSearchCache");

export function filterNotes(files, query) {
  const needle = normalizeNotePath(query.trim()).toLowerCase();
  if (!needle) return files;
  return files.filter((file) => {
    let searchable = file[noteSearchCache];
    if (!searchable || searchable.path !== file.path || searchable.name !== file.name
        || searchable.title !== file.title) {
      searchable = {
        path: file.path,
        name: file.name,
        title: file.title,
        normalizedPath: file.path.toLowerCase(),
        normalizedName: file.name.toLowerCase(),
        normalizedTitle: file.title?.toLowerCase() ?? "",
      };
      if (Object.isExtensible(file)) file[noteSearchCache] = searchable;
    }
    return searchable.normalizedPath.includes(needle)
      || searchable.normalizedName.includes(needle)
      || searchable.normalizedTitle.includes(needle);
  });
}

export function createWordCounter(
  segmenter = new Intl.Segmenter(undefined, { granularity: "word" }),
) {
  let lines = null;
  let counts = [];
  let total = 0;
  const countLine = (line) => {
    let count = 0;
    for (const word of segmenter.segment(line)) if (word.isWordLike) count += 1;
    return count;
  };
  return {
    count(source) {
      source = String(source);
      const nextLines = source.split("\n");
      if (lines === null) {
        counts = new Array(nextLines.length).fill(0);
        let line = 0;
        let lineEnd = nextLines[0]?.length ?? 0;
        for (const word of segmenter.segment(source)) {
          if (!word.isWordLike) continue;
          while (word.index > lineEnd && line + 1 < nextLines.length) {
            line += 1;
            lineEnd += nextLines[line].length + 1;
          }
          counts[line] += 1;
          total += 1;
        }
        lines = nextLines;
        return total;
      }
      const nextCounts = new Array(nextLines.length);
      let prefix = 0;
      while (prefix < lines.length && prefix < nextLines.length
          && lines[prefix] === nextLines[prefix]) {
        nextCounts[prefix] = counts[prefix];
        prefix += 1;
      }
      let oldEnd = lines.length;
      let nextEnd = nextLines.length;
      while (oldEnd > prefix && nextEnd > prefix
          && lines[oldEnd - 1] === nextLines[nextEnd - 1]) {
        oldEnd -= 1;
        nextEnd -= 1;
      }
      for (let index = prefix; index < oldEnd; index += 1) total -= counts[index];
      for (let index = prefix; index < nextEnd; index += 1) {
        nextCounts[index] = countLine(nextLines[index]);
        total += nextCounts[index];
      }
      for (let offset = 0; oldEnd + offset < lines.length; offset += 1) {
        nextCounts[nextEnd + offset] = counts[oldEnd + offset];
      }
      lines = nextLines;
      counts = nextCounts;
      return total;
    },
  };
}

export function sameTreeStructure(left, right) {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other && (entry.id ?? null) === (other.id ?? null)
      && entry.path === other.path && entry.name === other.name;
  });
}

export function sameTreeEntries(left, right) {
  return sameTreeStructure(left, right) && left.every((entry, index) =>
    (entry.title ?? null) === (right[index].title ?? null));
}

const treeCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function buildFileTree(files, directories = []) {
  const root = { name: "", title: null, path: "", directories: new Map(), files: [] };
  const ensureChild = (parent, name) => {
    const existing = parent.directories.get(name);
    if (existing) return existing;
    const path = parent.path ? `${parent.path}/${name}` : name;
    const child = { name, title: null, path, directories: new Map(), files: [] };
    parent.directories.set(name, child);
    return child;
  };
  const ensurePath = (path, includeLeaf) => {
    const normalized = normalizeNotePath(path);
    let parent = root;
    let start = 0;
    while (start < normalized.length) {
      const slash = normalized.indexOf("/", start);
      if (slash < 0) {
        return includeLeaf ? ensureChild(parent, normalized.slice(start)) : parent;
      }
      parent = ensureChild(parent, normalized.slice(start, slash));
      start = slash + 1;
    }
    return parent;
  };
  const ensureDirectory = (path, title = null) => {
    const parent = ensurePath(path, true);
    if (title) parent.title = title;
    return parent;
  };
  for (const directory of directories) {
    ensureDirectory(directory.path, directory.title ?? null);
  }
  for (const file of files) {
    ensurePath(file.path, false).files.push(file);
  }
  const compare = (a, b) => treeCollator.compare(a.title ?? a.name, b.title ?? b.name);
  function finish(branch) {
    return {
      name: branch.name,
      title: branch.title,
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
  if (url.searchParams.has("file") || url.searchParams.has("path")) throw new Error("Path-based document URLs are no longer supported.");
  const id = url.searchParams.get("document");
  if (id !== null && !isResourceId(id)) throw new Error("Use a UUID v7 document URL.");
  return { id, hash: url.hash };
}

export function makeNoteUrl(value, id, hash = "") {
  if (id != null && !isResourceId(id)) throw new Error("A document URL requires a UUID v7.");
  const url = new URL(value);
  url.searchParams.delete("file");
  url.searchParams.delete("path");
  if (id && url.pathname !== "/share") url.searchParams.set("document", id);
  else url.searchParams.delete("document");
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
