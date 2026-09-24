import { isMap, isSeq, parseDocument } from "yaml";
import { replaceMetadataText, splitFrontMatter } from "./editor-helpers.mjs";

export function normalizeTags(values) {
  const tags = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") throw new Error("Tags must be strings; quote numeric tags in YAML.");
    const tag = value.trim().replace(/^#/, "");
    if (!tag || tag.length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(tag)) {
      throw new Error("Each tag must contain 1-80 characters without control characters.");
    }
    const key = tag.toLowerCase();
    if (!seen.has(key)) { tags.push(tag); seen.add(key); }
  }
  if (tags.length > 64) throw new Error("A note can have at most 64 tags.");
  return tags;
}

export function tagsFromValues(values) {
  return normalizeTags(["tags", "tag"].flatMap((key) => {
    if (!Object.hasOwn(values, key) || values[key] === null) return [];
    return Array.isArray(values[key]) ? values[key] : [values[key]];
  }));
}

function tagDocument(raw) {
  const parsed = parseDocument(raw, { uniqueKeys: true });
  if (parsed.errors.length) throw new Error(`Fix the YAML before editing tags: ${parsed.errors[0].message}`);
  if (parsed.contents && !isMap(parsed.contents)) throw new Error("Metadata must be a YAML mapping.");
  return parsed;
}

export function readMetadataTags(source) {
  const parts = splitFrontMatter(source);
  if (!parts.hasMetadata) return [];
  const parsed = tagDocument(parts.raw);
  return parsed.contents ? tagsFromValues(parsed.toJS({ maxAliasCount: 50 })) : [];
}

export function replaceYamlTags(raw, values) {
  const tags = normalizeTags(values);
  const parsed = tagDocument(raw);
  const previous = parsed.contents ? tagsFromValues(parsed.toJS({ maxAliasCount: 50 })) : [];
  if (previous.length === tags.length && previous.every((tag, index) => tag === tags[index])) return raw;
  const pairs = parsed.contents?.items.filter((pair) => ["tags", "tag"].includes(pair.key?.value)) ?? [];
  const ending = raw.includes("\r\n") ? "\r\n" : raw.includes("\r") && !raw.includes("\n") ? "\r" : "\n";
  if (!pairs.length) return tags.length ? raw + (raw && !/[\r\n]$/.test(raw) ? ending : "") + `tags: ${JSON.stringify(tags)}${ending}` : raw;
  const primary = pairs.find((pair) => pair.key.value === "tags") ?? pairs[0];
  const edits = pairs.map((pair) => {
    const node = pair.value;
    if (!node?.range) throw new Error("Edit this tag field directly in YAML.");
    if (isSeq(node) && node.items.some((item) => item?.comment || item?.commentBefore)) {
      throw new Error("Edit this commented tag list in YAML so its comments stay intact.");
    }
    const [from, to] = node.range;
    const newline = raw.slice(from, to).match(/(?:\r\n|\r|\n)$/)?.[0] ?? "";
    return { from, to, text: (raw[from - 1] === ":" ? " " : "")
      + JSON.stringify(pair === primary ? tags : []) + newline };
  });
  for (const edit of edits.sort((left, right) => right.from - left.from)) {
    raw = raw.slice(0, edit.from) + edit.text + raw.slice(edit.to);
  }
  return raw;
}

export function updateMetadataTags(source, values) {
  const parts = splitFrontMatter(source);
  const tags = normalizeTags(values);
  if (!parts.hasMetadata) {
    if (!tags.length) return source;
    const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
    const ending = source.includes("\r\n") ? "\r\n" : "\n";
    return `${bom}---${ending}tags: ${JSON.stringify(tags)}${ending}---${ending}${ending}${source.slice(bom.length)}`;
  }
  const next = replaceMetadataText(parts, replaceYamlTags(parts.raw, tags));
  return next.prefix + next.body;
}

export function mountTagEditor(panel, textarea, { onTag, onError }) {
  const root = document.createElement("div");
  root.className = "notes-tags";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Document tags");
  const tokens = document.createElement("div");
  tokens.className = "notes-tag-list";
  const input = document.createElement("input");
  input.className = "notes-tag-input";
  input.placeholder = "Add a tag";
  input.setAttribute("aria-label", "Add a metadata tag");
  input.maxLength = 80;
  root.append(tokens, input);
  panel.append(root);
  let current = [];
  const commit = (tags) => {
    if (textarea.disabled) return;
    try {
      const next = replaceYamlTags(textarea.value, tags);
      if (next !== textarea.value) {
        textarea.value = next;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      input.value = "";
    } catch (error) { onError(error.message); }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (input.value.trim()) commit([...current, input.value]);
  });
  return {
    render(tags) {
      current = tags;
      tokens.replaceChildren(...tags.map((tag) => {
        const chip = document.createElement("span");
        chip.className = "notes-tag";
        const label = document.createElement(onTag ? "button" : "span");
        label.textContent = tag;
        if (onTag) { label.type = "button"; label.title = `Find notes tagged ${tag}`; label.addEventListener("click", () => onTag(tag)); }
        const remove = document.createElement("button");
        remove.className = "notes-tag-remove";
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove tag ${tag}`);
        remove.addEventListener("click", () => commit(current.filter((value) => value !== tag)));
        chip.append(label, remove);
        return chip;
      }));
    },
    setReadOnly(value) {
      input.disabled = value;
      root.setAttribute("aria-readonly", String(value));
    },
  };
}
