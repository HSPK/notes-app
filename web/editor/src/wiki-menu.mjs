import { wikiSchema } from "./wiki.mjs";

export function createWikiMenu(active, documents) {
  const menu = document.createElement("div");
  menu.id = "notes-wiki-menu";
  menu.className = "notes-slash-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Link to a note");
  menu.hidden = true;
  document.body.append(menu);
  let owner = null;
  let options = [];
  let selected = 0;
  let start = 0;
  let signature = "";
  const close = () => {
    menu.hidden = true;
    owner?.view?.dom.removeAttribute("aria-activedescendant");
    owner?.view?.dom.removeAttribute("aria-controls");
    owner = null;
    signature = "";
  };
  const select = (index) => {
    if (!options.length) return;
    selected = (index + options.length) % options.length;
    [...menu.children].forEach((button, index) => {
      button.setAttribute("aria-selected", String(index === selected));
      button.toggleAttribute("data-active", index === selected);
    });
    owner?.view?.dom.setAttribute("aria-activedescendant", menu.children[selected].id);
    menu.children[selected].scrollIntoView({ block: "nearest" });
  };
  const insert = (index) => {
    const state = owner;
    const option = options[index];
    if (!state || !option || !active(state)) return;
    const end = state.view.state.selection.from;
    const from = start;
    close();
    state.editor.action((ctx) => {
      const node = wikiSchema.type(ctx).create({ target: `/${option.path}`, label: option.title ?? option.name });
      state.view.dispatch(state.view.state.tr.replaceWith(from, end, node).scrollIntoView());
      state.view.focus();
    });
  };
  document.addEventListener("pointerdown", (event) => { if (!menu.hidden && !menu.contains(event.target)) close(); });
  window.addEventListener("resize", close);
  return {
    close,
    update(state, view) {
      if (!active(state) || !state.ready || !view.editable || !view.state.selection.empty) { close(); return; }
      const { $from } = view.state.selection;
      if ($from.parent.type.spec.code) { close(); return; }
      const text = $from.parent.textBetween(0, $from.parentOffset, "", "\ufffc");
      const query = text.match(/\[\[([^\]\n|]*)$/);
      if (!query) { close(); return; }
      const candidates = documents().filter((file) => `${file.path} ${file.title ?? ""}`.toLowerCase().includes(query[1].toLowerCase())).slice(0, 12);
      if (!candidates.length) { close(); return; }
      start = view.state.selection.from - query[0].length;
      owner = state;
      options = candidates;
      const next = JSON.stringify([start, query[1], candidates.map((file) => [file.path, file.title])]);
      if (signature !== next) {
        menu.replaceChildren(...candidates.map((file, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.id = `notes-wiki-option-${index}`;
          button.setAttribute("role", "option");
          const glyph = document.createElement("span");
          glyph.className = "notes-slash-glyph";
          glyph.textContent = "[[]]";
          const copy = document.createElement("span");
          copy.className = "notes-slash-copy";
          const title = document.createElement("strong");
          title.textContent = file.title ?? file.name;
          const location = document.createElement("small");
          location.textContent = file.path;
          copy.append(title, location);
          button.append(glyph, copy);
          button.addEventListener("mousedown", (event) => event.preventDefault());
          button.addEventListener("click", () => insert(index));
          button.addEventListener("pointermove", () => { if (index !== selected) select(index); });
          return button;
        }));
        signature = next;
        selected = 0;
      }
      menu.hidden = false;
      view.dom.setAttribute("aria-controls", menu.id);
      const coordinates = view.coordsAtPos(view.state.selection.from);
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(12, Math.min(coordinates.left, innerWidth - bounds.width - 12))}px`;
      menu.style.top = `${coordinates.bottom + bounds.height + 8 > innerHeight ? Math.max(12, coordinates.top - bounds.height - 8) : coordinates.bottom + 8}px`;
      select(selected);
    },
    key(state, event) {
      if (menu.hidden || owner !== state) return false;
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); select(selected + (event.key === "ArrowDown" ? 1 : -1)); return true; }
      if (["Enter", "Tab"].includes(event.key)) { event.preventDefault(); insert(selected); return true; }
      if (event.key === "Escape") { event.preventDefault(); close(); return true; }
      return false;
    },
  };
}
