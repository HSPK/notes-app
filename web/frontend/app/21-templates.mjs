import { notePathFromTitle, templateContent, templateTitle } from "./workspace-model.mjs";

let suggestedNoteTitle = "";

function refreshNewNoteHint() {
  try {
    setText(ui.newNoteHint, `File: ${notePathFromTitle(ui.newTitle.value, newItemParent)}`);
  } catch (error) {
    setText(ui.newNoteHint, error.message);
  }
}

ui.newForm.querySelector(".dialog-actions").before(element("note-template-fields").content.cloneNode(true));
element("new-note-template").addEventListener("change", () => {
  const title = templateTitle(element("new-note-template").value);
  if (!ui.newTitle.value.trim() || ui.newTitle.value === suggestedNoteTitle) ui.newTitle.value = title;
  suggestedNoteTitle = title;
  ui.newTitle.setAttribute("aria-invalid", "false");
  refreshNewNoteHint();
});
