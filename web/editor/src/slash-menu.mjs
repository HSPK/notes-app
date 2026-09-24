import {
  turnIntoTextCommand, wrapInHeadingCommand, wrapInBulletListCommand,
  wrapInOrderedListCommand, wrapInBlockquoteCommand, createCodeBlockCommand, insertHrCommand,
} from "@milkdown/preset-commonmark";
import { insertTableCommand } from "@milkdown/preset-gfm";
import { callCommand } from "@milkdown/utils";

const commands = [
  { title: "Text", description: "Plain paragraph", glyph: "T", command: turnIntoTextCommand },
  { title: "Heading 1", description: "Large section title", glyph: "H1", command: wrapInHeadingCommand, payload: 1 },
  { title: "Heading 2", description: "Medium section title", glyph: "H2", command: wrapInHeadingCommand, payload: 2 },
  { title: "Heading 3", description: "Small section title", glyph: "H3", command: wrapInHeadingCommand, payload: 3 },
  { title: "Bullet list", description: "Unordered list", glyph: "•", command: wrapInBulletListCommand },
  { title: "Numbered list", description: "Ordered list", glyph: "1.", command: wrapInOrderedListCommand },
  { title: "Quote", description: "Quoted paragraph", glyph: "❯", command: wrapInBlockquoteCommand },
  { title: "Code block", description: "Fenced code section", glyph: "</>", command: createCodeBlockCommand },
  { title: "Table", description: "Three by three table", glyph: "▦", command: insertTableCommand, payload: { row: 3, col: 3 } },
  { title: "Divider", description: "Horizontal separator", glyph: "—", command: insertHrCommand },
];

export function createSlashMenu(active) {
  const menu = document.createElement("div");
  menu.id = "notes-slash-menu";
  menu.className = "notes-slash-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Insert block");
  let owner = null;
  let selectedIndex = 0;

  const buttons = commands.map((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `notes-slash-option-${index}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    const glyph = document.createElement("span");
    glyph.className = "notes-slash-glyph";
    glyph.textContent = item.glyph;
    glyph.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "notes-slash-copy";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const description = document.createElement("small");
    description.textContent = item.description;
    copy.append(title, description);
    button.append(glyph, copy);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("pointermove", () => { if (index !== selectedIndex) select(index); });
    button.addEventListener("click", () => run(index));
    menu.append(button);
    return button;
  });
  document.body.append(menu);

  function select(index) {
    selectedIndex = (index + buttons.length) % buttons.length;
    for (const [buttonIndex, button] of buttons.entries()) {
      const selected = buttonIndex === selectedIndex;
      button.setAttribute("aria-selected", String(selected));
      button.toggleAttribute("data-active", selected);
    }
    owner?.view?.dom.setAttribute("aria-activedescendant", buttons[selectedIndex].id);
    buttons[selectedIndex].scrollIntoView({ block: "nearest" });
  }

  function close() {
    if (menu.hidden) return;
    owner?.view?.dom.removeAttribute("aria-controls");
    owner?.view?.dom.removeAttribute("aria-activedescendant");
    owner = null;
    menu.hidden = true;
  }

  function open(state, view, position) {
    if (!active(state) || !state.ready) return false;
    let coordinates;
    try {
      coordinates = view.coordsAtPos(position);
    } catch (error) {
      console.error("Could not position the slash command menu.", error);
      return false;
    }
    owner = state;
    menu.hidden = false;
    menu.style.left = `${Math.max(12, coordinates.left)}px`;
    menu.style.top = `${coordinates.bottom + 8}px`;
    view.dom.setAttribute("aria-controls", menu.id);
    select(0);
    window.requestAnimationFrame(() => {
      if (menu.hidden || owner !== state) return;
      const bounds = menu.getBoundingClientRect();
      const left = Math.min(Math.max(12, coordinates.left), window.innerWidth - bounds.width - 12);
      const top = bounds.bottom > window.innerHeight - 12
        ? Math.max(12, coordinates.top - bounds.height - 8) : coordinates.bottom + 8;
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    });
    return true;
  }

  function run(index) {
    const state = owner;
    const item = commands[index];
    close();
    if (!state || !item || !active(state) || !state.ready) return;
    state.editor.action(callCommand(item.command.key, item.payload));
    state.view.focus();
  }

  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target)) close();
  });
  window.addEventListener("resize", close);

  return {
    close,
    props(state) {
      return {
        handleTextInput(view, from, to, text) {
          if (text !== "/" || from !== to || !state.ready || !active(state)) return false;
          const position = view.state.doc.resolve(from);
          if (position.parent.type.name !== "paragraph"
              || position.parentOffset !== 0 || position.parent.content.size !== 0) return false;
          return open(state, view, from);
        },
        handleKeyDown(view, event) {
          if (menu.hidden || owner !== state) return false;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            select(selectedIndex + 1);
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            select(selectedIndex - 1);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            run(selectedIndex);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return true;
          }
          if (event.key.length === 1 || ["Backspace", "Delete"].includes(event.key)) close();
          return false;
        },
      };
    },
  };
}
