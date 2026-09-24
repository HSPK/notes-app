import remarkWikiLink from "remark-wiki-link";
import { headingSlug } from "./editor-helpers.mjs";

const options = { aliasDivider: "|", pageResolver: (name) => [name] };
export function remarkWiki() { return remarkWikiLink.call(this, options); }

export function wikiDestination(value) {
  if (!value || /[:?\\\u0000-\u001f]/u.test(value)) return null;
  const [path, ...fragment] = value.trim().split("#");
  const target = path ? /\.(md|markdown)$/i.test(path) ? path : `${path}.md` : "";
  return target + (fragment.length ? `#${headingSlug(fragment.join("#"))}` : "");
}

export const lezerWiki = {
  defineNodes: ["WikiLink"],
  parseInline: [{
    name: "WikiLink", before: "Link",
    parse(context, next, position) {
      if (next !== 91 || context.char(position + 1) !== 91) return -1;
      const rest = context.slice(position + 2, context.end);
      const end = rest.indexOf("]]");
      if (end < 1 || /[\r\n]/.test(rest.slice(0, end))) return -1;
      return context.addElement(context.elt("WikiLink", position, position + end + 4));
    },
  }],
};
