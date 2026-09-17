import { GFM, parser as markdownParser } from "@lezer/markdown";
import { decodeHTMLStrict } from "entities";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { assignHeadingIds, splitFrontMatter } from "./editor-helpers.mjs";

const outlineParser = markdownParser.configure(GFM);
const bodyParser = unified().use(remarkParse).use(remarkGfm);
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
        if (child.name === "Entity") text += decodeHTMLStrict(source.slice(child.from, child.to));
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

export function extractOutline(source) {
  const parts = splitFrontMatter(source);
  const items = [];
  const labels = [];
  outlineParser.parse(parts.body).iterate({
    enter(reference) {
      if (!/^(?:ATX|Setext)Heading[1-6]$/.test(reference.name)) return;
      const label = headingText(reference.node, parts.body);
      labels.push(label);
      items.push({ text: label.replace(/\s+/g, " "), level: Number(reference.name.at(-1)), from: parts.bodyStart + reference.from });
    },
  });
  const ids = assignHeadingIds(labels);
  return items.map((item, index) => ({ ...item, id: ids[index] }));
}

export function parseBody(source) {
  return bodyParser.parse(source);
}

export function unsupportedBody(tree, source) {
  const unsupported = (node) => node.type === "html" || node.type.startsWith("footnote")
    || node.children?.some(unsupported);
  if (unsupported(tree)) return "This body contains raw HTML or footnotes that formatted editing cannot safely preserve. Use Source mode; the original text is kept.";
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
  if (text.some((value) => /^\s*(?:\$\$|:::)/m.test(value) || /\[\[[^\]]+\]\]/.test(value))) {
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
    if (node.type === "definition") return null;
    let value = node;
    if (node.type === "linkReference" || node.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      if (definition) value = node.type === "linkReference"
        ? { type: "link", title: definition.title, url: definition.url, children: node.children }
        : { type: "image", title: definition.title, url: definition.url, alt: node.alt };
    }
    return Object.fromEntries(Object.keys(value).sort().filter((key) => key !== "position" && key !== "spread")
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
    else if (node.type === "inlineCode") append(node.value, from + (source.slice(from).match(/^`+/)?.[0].length ?? 0), to);
    else if (node.type === "code") {
      const fenced = /^ {0,3}(?:`{3,}|~{3,})/.test(source.slice(from, to));
      const start = fenced ? source.indexOf("\n", from) + 1 : from;
      append(node.value, start, to);
    } else if (node.type === "image" || node.type === "imageReference" || node.type === "thematicBreak") {
      sourceCharacters.push({ char: "\uFFFC", source: from });
    } else if (node.type === "break") {
      sourceCharacters.push({ char: "\n", source: from });
    } else node.children?.forEach(visit);
  };
  visit(tree);
  const editorCharacters = [];
  document.descendants((node, position) => {
    if (node.isText) for (let index = 0; index < node.text.length; index++) editorCharacters.push({ char: node.text[index], position: position + index });
    else if (node.type.name === "image" || node.type.name === "hr") editorCharacters.push({ char: "\uFFFC", position });
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
