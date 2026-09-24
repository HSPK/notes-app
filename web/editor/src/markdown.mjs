import { GFM, parser as markdownParser } from "@lezer/markdown";
import { TreeFragment } from "@lezer/common";
import { decodeHTMLStrict } from "entities";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { assignHeadingIds, splitFrontMatter } from "./editor-helpers.mjs";
import { remarkDisplayMath } from "./math-syntax.mjs";
import { lezerWiki, remarkWiki } from "./wiki-syntax.mjs";

const outlineParser = markdownParser.configure([GFM, lezerWiki]);
const bodyParser = unified().use(remarkParse).use(remarkMath).use(remarkDisplayMath).use(remarkGfm)
  .use(remarkWiki);
const markerNames = /^(?:HeaderMark|EmphasisMark|StrikethroughMark|CodeMark|LinkMark|ListMark|QuoteMark)$/;

function children(node) {
  const items = [];
  for (let child = node.firstChild; child; child = child.nextSibling) items.push(child);
  return items;
}

function headingText(node, source) {
  const collect = (part, from = part.from, to = part.to) => {
    let text = "";
    let position = from;
    for (const child of children(part)) {
      if (child.from < from || child.to > to) continue;
      text += source.slice(position, child.from);
      if (!markerNames.test(child.name) && child.name !== "HTMLTag" && child.name !== "HTMLBlock") {
        if (child.name === "WikiLink") text += source.slice(child.from + 2, child.to - 2).split("|").at(-1).trim();
        else if (child.name === "Entity") text += decodeHTMLStrict(source.slice(child.from, child.to));
        else if (child.name === "Escape") text += source.slice(child.from + 1, child.to);
        else if (child.name === "Link" || child.name === "Image") {
          const marks = children(child).filter((mark) => mark.name === "LinkMark");
          const closing = marks.find((mark) => source.slice(mark.from, mark.to) === "]");
          text += closing ? collect(child, marks[0].to, closing.from) : source.slice(child.from, child.to);
        } else text += collect(child);
      }
      position = child.to;
    }
    return text + source.slice(position, to);
  };
  return collect(node).trim();
}

function outlineItems(tree, body, bodyStart) {
  const items = [];
  const labels = [];
  tree.iterate({
    enter(reference) {
      if (!/^(?:ATX|Setext)Heading[1-6]$/.test(reference.name)) return;
      const label = headingText(reference.node, body);
      labels.push(label);
      items.push({ text: label.replace(/\s+/g, " "), level: Number(reference.name.at(-1)), from: bodyStart + reference.from });
    },
  });
  const ids = assignHeadingIds(labels);
  return items.map((item, index) => ({ ...item, id: ids[index] }));
}

export function extractOutline(source) {
  const parts = splitFrontMatter(source);
  return outlineItems(outlineParser.parse(parts.body), parts.body, parts.bodyStart);
}

function changedRange(previous, next) {
  const shared = Math.min(previous.length, next.length);
  let from = 0;
  while (from < shared && previous.charCodeAt(from) === next.charCodeAt(from)) from += 1;
  let toA = previous.length;
  let toB = next.length;
  while (toA > from && toB > from
      && previous.charCodeAt(toA - 1) === next.charCodeAt(toB - 1)) {
    toA -= 1;
    toB -= 1;
  }
  return { fromA: from, toA, fromB: from, toB };
}

function bodyChangedRanges(changes, oldStart, oldLength, nextStart, nextLength) {
  const clamp = (value, length) => Math.max(0, Math.min(length, value));
  return changes.map((change) => ({
    fromA: clamp(change.fromA - oldStart, oldLength),
    toA: clamp(change.toA - oldStart, oldLength),
    fromB: clamp(change.fromB - nextStart, nextLength),
    toB: clamp(change.toB - nextStart, nextLength),
  })).filter((change) => change.fromA !== change.toA || change.fromB !== change.toB);
}

export function createOutlineExtractor() {
  let body = null;
  let bodyStart = -1;
  let tree = null;
  let items = [];
  return {
    extract(source, changes = null) {
      const parts = splitFrontMatter(source);
      if (parts.body === body && parts.bodyStart === bodyStart) return items;
      if (parts.body !== body) {
        const precise = tree && changes
          && Array.isArray(changes.ranges)
          && changes.beforeLength === bodyStart + body.length
          && changes.afterLength === source.length
          ? bodyChangedRanges(
            changes.ranges,
            bodyStart,
            body.length,
            parts.bodyStart,
            parts.body.length,
          )
          : null;
        const fragments = tree
          ? TreeFragment.applyChanges(
            TreeFragment.addTree(tree),
            precise?.length ? precise : [changedRange(body, parts.body)],
          )
          : [];
        tree = outlineParser.parse(parts.body, fragments);
        body = parts.body;
      }
      bodyStart = parts.bodyStart;
      items = outlineItems(tree, body, bodyStart);
      return items;
    },
    clear() {
      body = null;
      bodyStart = -1;
      tree = null;
      items = [];
    },
  };
}

export function parseBody(source) {
  return bodyParser.runSync(bodyParser.parse(source), { value: source });
}

export function unsupportedBody(tree, source) {
  const unsupported = (node) => node.type.startsWith("footnote")
    || node.children?.some(unsupported);
  if (unsupported(tree)) return "This body contains footnotes that formatted editing cannot safely preserve. Use Source mode; the original text is kept.";
  const wikiEmbed = (node) => {
    if (node.type === "wikiLink" && source[node.position?.start.offset - 1] === "!") {
      let slashes = 0;
      for (let index = node.position.start.offset - 2; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
      if (slashes % 2 === 0) return true;
    }
    return node.children?.some(wikiEmbed);
  };
  if (wikiEmbed(tree)) return "Embedded wiki images are not supported by Live editing. Use standard Markdown images or Source mode; the original text is kept.";
  const definitions = [];
  const references = new Set();
  const text = [];
  const visit = (node) => {
    if (node.type === "definition") definitions.push(node.identifier);
    if (node.type === "linkReference" || node.type === "imageReference") references.add(node.identifier);
    if (node.type === "text") text.push(node.value);
    node.children?.forEach(visit);
  };
  visit(tree);
  if (new Set(definitions).size !== definitions.length || definitions.some((identifier) => !references.has(identifier))) {
    return "Unused or duplicate link definitions cannot be safely preserved by formatted editing. Use Source mode; the original text is kept.";
  }
  if (text.some((value) => /^\s*:::/m.test(value))) {
    return "This body contains an unsupported Markdown extension. Use Source mode to preserve its exact syntax.";
  }
  return "";
}

export function bodyFingerprint(tree) {
  const definitions = new Map();
  const find = (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node);
    node.children?.forEach(find);
  };
  find(tree);
  const normalize = (node) => {
    if (node.type === "wikiLink") return { type: "wikiLink", target: node.value, label: node.data?.alias ?? node.value };
    if (node.type === "definition") return null;
    let value = node;
    if (node.type === "linkReference" || node.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      if (definition) value = node.type === "linkReference"
        ? { type: "link", title: definition.title, url: definition.url, children: node.children }
        : { type: "image", title: definition.title, url: definition.url, alt: node.alt };
    }
    if (value.type === "table") {
      const width = Math.max(
        value.align?.length ?? 0,
        ...value.children.map((row) => row.children?.length ?? 0),
      );
      value = {
        ...value,
        align: Array.from({ length: width }, (_, index) => value.align?.[index] ?? null),
        children: value.children.map((row) => ({
          ...row,
          children: [
            ...row.children,
            ...Array.from({ length: width - row.children.length }, () => ({
              type: "tableCell",
              children: [],
            })),
          ],
        })),
      };
    }
    return Object.fromEntries(Object.keys(value).sort().filter((key) =>
      key !== "position" && key !== "spread" && key !== "data"
        && !(value.type === "math" && key === "meta"))
      .map((key) => [key, key === "children" ? value.children.map(normalize).filter(Boolean) : value[key]]));
  };
  return JSON.stringify(normalize(tree));
}

export function sourcePositionMap(tree, source, document) {
  const sourceCharacters = [];
  const append = (value, from, to) => {
    let cursor = from;
    for (let index = 0; index < value.length; index++) {
      const found = source.indexOf(value[index], cursor);
      const position = found >= cursor && found < to ? found : Math.min(cursor, Math.max(from, to - 1));
      sourceCharacters.push({ char: value[index], source: position });
      cursor = position + 1;
    }
  };
  const visit = (node) => {
    const from = node.position?.start.offset ?? 0;
    const to = node.position?.end.offset ?? from;
    if (node.type === "text") append(node.value, from, to);
    else if (node.type === "inlineMath" || node.type === "math") {
      sourceCharacters.push({ char: "\uFFFC", source: from });
      const opening = source.slice(from, to).match(/^\$+/)?.[0].length ?? 1;
      append(node.value, from + opening, to);
      const end = node.value.length ? sourceCharacters.at(-1).source + 1 : from + opening;
      sourceCharacters.push({ char: "\uFFF9", source: end });
    }
    else if (node.type === "inlineCode") append(node.value, from + (source.slice(from).match(/^`+/)?.[0].length ?? 0), to);
    else if (node.type === "code") {
      const fenced = /^ {0,3}(?:`{3,}|~{3,})/.test(source.slice(from, to));
      const start = fenced ? source.indexOf("\n", from) + 1 : from;
      append(node.value, start, to);
    } else if (["image", "imageReference", "thematicBreak", "wikiLink"].includes(node.type)) {
      sourceCharacters.push({ char: "\uFFFC", source: from });
      sourceCharacters.push({ char: "\uFFFB", source: to });
    } else if (node.type === "break") {
      sourceCharacters.push({ char: "\n", source: from });
    } else node.children?.forEach(visit);
  };
  visit(tree);
  const editorCharacters = [];
  document.descendants((node, position) => {
    if (node.isText) for (let index = 0; index < node.text.length; index++) editorCharacters.push({ char: node.text[index], position: position + index });
    else if (["math_inline", "math_block"].includes(node.type.name)) {
      editorCharacters.push({ char: "\uFFFC", position });
      for (let index = 0; index < node.textContent.length; index += 1) {
        editorCharacters.push({ char: node.textContent[index], position: position + 1 + index });
      }
      editorCharacters.push({ char: "\uFFF9", position: position + 1 + node.content.size });
      return false;
    } else if (["image", "hr", "wiki_link"].includes(node.type.name)) {
      editorCharacters.push({ char: "\uFFFC", position });
      editorCharacters.push({ char: "\uFFFB", position: position + node.nodeSize });
    }
    else if (node.type.name === "hardbreak") editorCharacters.push({ char: "\n", position });
  });
  const result = [];
  let sourceIndex = 0;
  for (const editor of editorCharacters) {
    if (!sourceCharacters[sourceIndex]) break;
    if (editor.char === "\r" && sourceCharacters[sourceIndex].char === "\n") {
      result.push({ source: Math.max(0, sourceCharacters[sourceIndex].source - 1), position: editor.position });
      continue;
    }
    if (sourceCharacters[sourceIndex].char !== editor.char) {
      const found = /\s/.test(sourceCharacters[sourceIndex].char) && /\s/.test(editor.char) ? 0
        : sourceCharacters.slice(sourceIndex, sourceIndex + 32).findIndex((item) => item.char === editor.char);
      if (found >= 0) sourceIndex += found;
    }
    result.push({ source: sourceCharacters[sourceIndex].source, position: editor.position });
    sourceIndex++;
  }
  return result;
}

export function sourceOffset(map, position) {
  const index = map.findIndex((entry) => entry.position >= position);
  if (index < 0) return (map.at(-1)?.source ?? -1) + 1;
  const next = map[index];
  return next.position === position || index === 0 ? next.source : map[index - 1].source + 1;
}

export function documentOffset(map, source) {
  const index = map.findIndex((entry) => entry.source >= source);
  if (index < 0) return (map.at(-1)?.position ?? -1) + 1;
  const next = map[index];
  if (index === 0 || source !== map[index - 1].source + 1) return next.position;
  return map[index - 1].position + 1;
}
