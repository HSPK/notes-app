import katex from "katex";

const KATEX_CACHE_LIMIT = 64;

export function createCachedKatexRenderer() {
  let options;
  const templates = new Map();
  const values = new WeakMap();
  return (value, element, nextOptions, cacheable = true) => {
    if (options !== nextOptions) {
      options = nextOptions;
      templates.clear();
    }
    const previous = values.get(element);
    if (previous === value) return;
    if (previous !== value && templates.get(previous) === element) {
      templates.delete(previous);
    }
    if (!cacheable) {
      katex.render(value, element, nextOptions);
      values.set(element, value);
      return;
    }
    const template = templates.get(value);
    if (template) {
      if (template !== element) {
        templates.delete(value);
        templates.set(value, template);
        element.replaceChildren(...[...template.childNodes].map((child) => child.cloneNode(true)));
      }
      values.set(element, value);
      return;
    }
    katex.render(value, element, nextOptions);
    values.set(element, value);
    templates.set(value, element);
    if (templates.size > KATEX_CACHE_LIMIT) templates.delete(templates.keys().next().value);
  };
}
