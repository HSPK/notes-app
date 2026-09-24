import { diffLines, mergeSharedUpdates, readMetadataTags, updateMetadataTags } from "./editor.bundle.mjs";

document.querySelector("#more-menu .popup-panel").prepend(element("workspace-actions").content.cloneNode(true));
element("sharing-public-fields").append(element("share-options-fields").content.cloneNode(true));
ui.renameForm.querySelector(".dialog-actions").before(element("rename-link-options").content.cloneNode(true));
document.querySelector('[data-settings-panel="library"]').append(element("image-processing-fields").content.cloneNode(true));
function refreshWorkspaceControls() {
  const users = authMode === "users";
  element("workspace-search-open").hidden = !users;
  element("workspace-open").hidden = !users;
  element("shares-open").hidden = !users;
  element("backlinks-open").hidden = publicView;
  element("backlinks-open").disabled = !activeDocument;
  element("attachments-open").hidden = !users || !activeProject?.owned;
  element("workspace-favorite").hidden = !users || !activeDocument;
  element("history-open").hidden = !users || !activeProject?.owned;
  element("history-open").disabled = !activeDocument;
  element("trash-open").hidden = !users || !activeProject?.owned;
  element("document-trash").hidden = !users || !activeProject?.owned;
  element("document-trash").disabled = !activeDocument || dirty() || Boolean(pendingSave || collaboration?.pending.size);
  element("document-tags-open").disabled = !activeDocument || !projectWritable() || collaborationLocked();
  refreshWorkspaceFavorite();
}

let tagsDocument = null;
element("document-tags-open").addEventListener("click", () => {
  closeMenus();
  if (!activeDocument || !projectWritable()) return;
  try {
    element("tags-input").value = readMetadataTags(ui.editor.value).join("\n");
    tagsDocument = documentId;
    notice(element("tags-error"), "");
    element("tags-dialog").showModal();
    element("tags-input").focus();
  } catch (error) { documentNotice(error.message, "error"); }
});
element("tags-cancel").addEventListener("click", () => element("tags-dialog").close());
element("tags-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (tagsDocument !== documentId || !projectWritable()) {
    notice(element("tags-error"), "The open document or its permissions changed.", "error");
    return;
  }
  try {
    const values = element("tags-input").value.split(/\r?\n/).map((tag) => tag.trim()).filter(Boolean);
    ui.editor.value = updateMetadataTags(ui.editor.value, values);
    ui.editor.dispatchEvent(new Event("input"));
    if (ui.panes.dataset.view === "rich") {
      if (!await inlineEditor.replaceSource(ui.editor.value)) await inlineEditor.load(ui.editor.value, activeDocument.path);
    }
    element("tags-dialog").close();
    documentNotice("Tags updated.", "success");
  } catch (error) { notice(element("tags-error"), error.message, "error"); }
});
