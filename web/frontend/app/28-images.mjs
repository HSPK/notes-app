let imageUploading = false;

function imageMarkdownPath(path, documentPath) {
  const parent = documentPath.split("/").slice(0, -1);
  const target = path.split("/");
  while (parent.length && target.length && parent[0] === target[0]) { parent.shift(); target.shift(); }
  return [...parent.map(() => ".."), ...target].map((part) => encodeURIComponent(part)
    .replace(/[()]/g, (character) => `%${character.charCodeAt(0).toString(16)}`)).join("/");
}

async function insertImages(images) {
  if (!projectWritable() || collaborationLocked()) { documentNotice("This page is not editable.", "warning"); return; }
  if (imageUploading) { documentNotice("Wait for the current image upload to finish."); return; }
  const operation = { id: documentId, resource: activeDocument.id, revision: editorRevision, project: activeProject?.id, path: activeDocument.path };
  const selection = collaborativeSelection();
  if (!selection) { documentNotice("Place the cursor in the document before pasting an image.", "warning"); return; }
  const current = collaboration;
  const relative = current?.shared.relative(selection);
  imageUploading = true;
  documentNotice("Saving image…");
  const links = [];
  const warnings = new Set();
  try {
    for (const image of images) {
      if (!image || image.size > 16 * 1024 * 1024) throw new Error("Images must not exceed 16 MiB.");
      const result = await api(`/api/images?document=${encodeURIComponent(operation.resource)}`, { method: "POST", body: image });
      if (typeof result?.path !== "string" || result.document !== operation.resource || typeof result.documentPath !== "string") {
        throw new Error("The server returned an invalid image or document identity.");
      }
      links.push(`![Image](${imageMarkdownPath(result.path, result.documentPath)})`);
      if (result.documentPath !== operation.path) {
        throw new Error(`The document moved while uploading. Images were saved; reopen this document before inserting: ${links.join(" ")}`);
      }
      if (result.warning) warnings.add(result.warning);
    }
    if (operation.id !== documentId || operation.project !== activeProject?.id || !projectWritable()) {
      throw new Error(`Images were saved, but the open page or its permissions changed. Insert them manually: ${links.join(" ")}`);
    }
    if (!current && operation.revision !== editorRevision) {
      throw new Error(`Images were saved while you edited. Paste these references at the desired position: ${links.join(" ")}`);
    }
    const range = relative && current === collaboration ? current.shared.resolve(relative) : selection;
    if (!range) throw new Error(`The original insertion position is unavailable. Insert manually: ${links.join(" ")}`);
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    const insertion = links.join("\n");
    ui.editor.value = ui.editor.value.slice(0, from) + insertion + ui.editor.value.slice(to);
    ui.editor.dispatchEvent(new Event("input"));
    if (ui.panes.dataset.view === "rich") {
      if (!await inlineEditor.replaceSource(ui.editor.value)) await inlineEditor.load(ui.editor.value, operation.path);
      inlineEditor.select(from + insertion.length);
    } else {
      ui.editor.setSelectionRange(from + insertion.length, from + insertion.length);
      ui.editor.focus();
    }
    documentNotice(`${images.length === 1 ? "Image inserted." : "Images inserted."}${warnings.size ? ` ${[...warnings].join(" ")}` : ""}`, warnings.size ? "warning" : "success");
  } catch (error) {
    documentNotice(`Could not insert image: ${error.message}${links.length ? ` Already saved; insert these references manually: ${links.join(" ")}` : ""}`, "error");
  }
  finally { imageUploading = false; }
}

document.addEventListener("paste", (event) => {
  if (!activeDocument || !collaborativeTarget(event.target) || event.target.closest(".notes-metadata-source")) return;
  const images = [...(event.clipboardData?.items ?? [])].filter((item) => item.kind === "file" && item.type.startsWith("image/"));
  if (!images.length) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void insertImages(images.map((item) => item.getAsFile()));
}, true);

document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files") || !event.target.closest(".editor-pane, .rich-pane")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = activeDocument && projectWritable() ? "copy" : "none";
});
document.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files.length || !event.target.closest(".editor-pane, .rich-pane")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!activeDocument || !projectWritable() || event.target.closest(".notes-metadata")) {
    documentNotice("Drop images into an editable document body.", "warning");
    return;
  }
  const images = [...event.dataTransfer.files];
  if (images.some((file) => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type))) {
    documentNotice("Drop PNG, JPEG, GIF, or WebP images.", "warning");
    return;
  }
  if (ui.panes.dataset.view === "rich") {
    if (!inlineEditor.selectAtPoint(event.clientX, event.clientY)) inlineEditor.select(ui.editor.value.length);
  } else ui.editor.selectAtPoint(event.clientX, event.clientY);
  void insertImages(images);
}, true);
