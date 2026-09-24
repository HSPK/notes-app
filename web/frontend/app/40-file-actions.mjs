function openNewNote(parentPath = null) {
  if (!projectCanCreate()) return;
  if (connectionState !== "ready" || pendingSave || creating) return;
  cancelDocumentLoad();
  if (!confirmDiscard("create a new note")) return;
  newNoteOrigin = { id: documentId, revision: editorRevision, root: currentRoot };
  const parent = typeof parentPath === "string" ? parentPath
    : activeDocument && !rootChanged() && activeDocument.path.includes("/")
      ? activeDocument.path.slice(0, activeDocument.path.lastIndexOf("/")) : "";
  newItemParent = parent;
  element("new-note-template").value = "blank";
  suggestedNoteTitle = templateTitle("blank");
  ui.newTitle.value = suggestedNoteTitle;
  ui.newTitle.setAttribute("aria-invalid", "false");
  refreshNewNoteHint();
  notice(ui.newError, "");
  ui.newDialog.showModal();
  ui.newTitle.focus();
  ui.newTitle.select();
}

async function createNote(event) {
  event.preventDefault();
  if (creating) return;
  let path;
  let content;
  try {
    path = notePathFromTitle(ui.newTitle.value, newItemParent);
    content = templateContent(element("new-note-template").value, ui.newTitle.value);
  } catch (error) {
    notice(ui.newError, error.message, "error");
    ui.newTitle.setAttribute("aria-invalid", "true");
    ui.newTitle.focus();
    return;
  }
  if (connectionState !== "ready" || newNoteOrigin.root !== currentRoot) {
    notice(ui.newError, "The connection or notes folder changed. Cancel and reopen New note after reconnecting.", "error");
    return;
  }
  if ((newNoteOrigin.id !== documentId || newNoteOrigin.revision !== editorRevision)
      && !confirmDiscard("create a new note")) return;
  const origin = { id: documentId, revision: editorRevision, root: currentRoot };
  creating = true;
  notice(ui.newError, "");
  refreshControls();
  try {
    const payload = expectDocument(await api("/api/document", { method: "POST", body: { path, content } }));
    ui.newDialog.close();
    if (origin.id === documentId && origin.revision === editorRevision && origin.root === currentRoot) {
      useDocument(payload, origin.root, makeNoteUrl(committedUrl, payload.id), "push", "Created a new note.");
      if (ui.panes.dataset.view === "preview") setView("rich");
      if (ui.panes.dataset.view === "rich") inlineEditor.focus();
      else ui.editor.focus();
    } else {
      documentNotice(`Created “${payload.path}”. Your current editor text was kept because the open note or folder changed.`, "success");
    }
    void refreshFiles();
  } catch (error) {
    const prefix = error.status === 409 ? "A note with this file name already exists. Choose a different title. " : "";
    notice(ui.newError, `${prefix}${error.message} No existing note was replaced.`, "error");
    ui.newTitle.setAttribute("aria-invalid", "true");
    connectionFailure(error);
  } finally {
    creating = false;
    refreshControls();
  }
}

function openNewFolder(parentPath = "") {
  if (!projectCanCreate()) return;
  if (connectionState !== "ready" || creating || movingEntry) return;
  newItemParent = typeof parentPath === "string" ? parentPath : "";
  const prefix = newItemParent ? `${newItemParent}/` : "";
  ui.newFolderPath.value = `${prefix}New folder`;
  ui.newFolderPath.setAttribute("aria-invalid", "false");
  notice(ui.newFolderError, "");
  ui.newFolderDialog.showModal();
  ui.newFolderPath.focus();
  ui.newFolderPath.setSelectionRange(prefix.length, ui.newFolderPath.value.length);
}

async function createFolder(event) {
  event.preventDefault();
  if (creating) return;
  let path;
  try {
    path = validateNewDirectoryPath(ui.newFolderPath.value);
  } catch (error) {
    notice(ui.newFolderError, error.message, "error");
    ui.newFolderPath.setAttribute("aria-invalid", "true");
    ui.newFolderPath.focus();
    return;
  }
  creating = true;
  notice(ui.newFolderError, "");
  refreshControls();
  try {
    const result = await api("/api/directory", { method: "POST", body: { path } });
    if (result?.path !== path) throw new ApiError("The service returned a different folder.");
    ui.newFolderDialog.close();
    collapsedFolders.delete(newItemParent);
    collapsedFolders.delete(path);
    documentNotice(`Created “${path}”.`, "success");
    await refreshFiles();
  } catch (error) {
    notice(ui.newFolderError, `${error.message} No existing file or folder was replaced.`, "error");
    ui.newFolderPath.setAttribute("aria-invalid", "true");
    connectionFailure(error);
  } finally {
    creating = false;
    refreshControls();
  }
}

function closeFileContextMenu() {
  ui.fileContextMenu.hidden = true;
  contextFile = null;
}

function openFileContextMenu(event, path) {
  event.preventDefault();
  contextFile = { path, kind: "file" };
  ui.fileRename.disabled = !projectCanCreate();
  ui.fileContextMenu.hidden = false;
  ui.fileContextMenu.style.left = `${event.clientX}px`;
  ui.fileContextMenu.style.top = `${event.clientY}px`;
  window.requestAnimationFrame(() => {
    if (ui.fileContextMenu.hidden) return;
    const bounds = ui.fileContextMenu.getBoundingClientRect();
    ui.fileContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`;
    ui.fileContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`;
  });
}

async function showFileDetails() {
  const selected = contextFile;
  closeFileContextMenu();
  if (!selected) return;
  try {
    const details = await api(`/api/entry?id=${encodeURIComponent(currentResourceId(selected.path))}`);
    if (!details || details.path !== selected.path || typeof details.name !== "string"
        || !Number.isFinite(details.size)) {
      throw new ApiError("The service returned incomplete file details.");
    }
    setText(ui.detailsName, details.name);
    setText(ui.detailsMetadataTitle, details.title || "—");
    setText(ui.detailsPath, details.path);
    setText(ui.detailsSize, formatByteCount(details.size));
    setText(ui.detailsModified, Number.isFinite(details.modifiedUnixMs)
      ? new Date(details.modifiedUnixMs).toLocaleString() : "—");
    ui.detailsDialog.showModal();
  } catch (error) {
    documentNotice(`Could not read file details: ${error.message}`, "error");
    connectionFailure(error);
  }
}

function openRenameDialog() {
  const selected = contextFile;
  closeFileContextMenu();
  if (!selected) return;
  contextFile = selected;
  const name = selected.path.split("/").at(-1);
  ui.renamePath.value = name;
  element("rename-update-links").checked = true;
  ui.renamePath.setAttribute("aria-invalid", "false");
  notice(ui.renameError, "");
  ui.renameDialog.showModal();
  ui.renamePath.focus();
  const extension = selected.kind === "file" ? name.lastIndexOf(".") : -1;
  ui.renamePath.setSelectionRange(0, extension > 0 ? extension : name.length);
}

async function renameEntry(event) {
  event.preventDefault();
  if (!contextFile || movingEntry) return;
  const name = ui.renamePath.value.trim();
  if (!name || name.includes("/") || name.includes("\\")) {
    notice(ui.renameError, "Enter one file or folder name without slashes.", "error");
    ui.renamePath.setAttribute("aria-invalid", "true");
    return;
  }
  const parent = contextFile.path.includes("/")
    ? contextFile.path.slice(0, contextFile.path.lastIndexOf("/")) : "";
  const destination = entryDestination(contextFile.path, parent, name);
  try {
    if (contextFile.kind === "file") validateNewNotePath(destination);
    else validateNewDirectoryPath(destination);
  } catch (error) {
    notice(ui.renameError, error.message, "error");
    ui.renamePath.setAttribute("aria-invalid", "true");
    return;
  }
  if (await moveLibraryEntry(contextFile, destination, element("rename-update-links").checked)) {
    ui.renameDialog.close();
    contextFile = null;
  }
}

async function moveLibraryEntry(entry, destination, updateLinks = true) {
  if (movingEntry || entry.path === destination) return false;
  const activePath = activeDocument?.path;
  const affectsActive = activePath === entry.path
    || entry.kind === "directory" && activePath?.startsWith(`${entry.path}/`);
  if (affectsActive && dirty()) {
    documentNotice("Save or discard the open note before moving or renaming it.", "warning");
    return false;
  }
  movingEntry = true;
  refreshControls();
  try {
    const result = await api("/api/entry", {
      method: "PATCH",
      body: { id: currentResourceId(entry.path, entry.kind === "directory" ? "directory" : "document"), destination, updateLinks },
    });
    if (!result || typeof result.path !== "string" || result.kind !== entry.kind || !isResourceId(result.id)) {
      throw new ApiError("The service returned an incomplete move result.");
    }
    await refreshFiles();
    destination = result.path;
    if (authMode === "users") void loadUserWorkspace();
    if (activePath === entry.path && result.document) {
      useDocument(
        expectDocument(result.document),
        currentRoot,
        makeNoteUrl(committedUrl, result.document.id),
        "replace",
        `Moved to “${destination}”.`,
      );
    } else if (affectsActive) {
      const nextPath = `${destination}${activePath.slice(entry.path.length)}`;
      await navigateTo(nextPath, "", { mode: "replace", reload: true });
    } else {
      documentNotice(`Moved to “${destination}”.`, "success");
    }
    if (result.warning) documentNotice(result.warning, "warning");
    else if (result.referencesUpdated) documentNotice(`Moved to “${destination}”; updated references in ${result.referencesUpdated} notes.`, "success");
    return true;
  } catch (error) {
    const message = `Could not move “${entry.path}”: ${error.message}`;
    if (ui.renameDialog.open) notice(ui.renameError, message, "error");
    else documentNotice(message, "error");
    connectionFailure(error);
    return false;
  } finally {
    movingEntry = false;
    refreshControls();
  }
}

function setDropTarget(target) {
  if (dropTarget === target) return;
  if (dropTarget) dropTarget.removeAttribute("data-drop-target");
  dropTarget = target;
  if (dropTarget) dropTarget.setAttribute("data-drop-target", "true");
}

function setView(view, focus = false) {
  const previousView = ui.panes.dataset.view;
  if (["editor", "split"].includes(view)) ui.editor.prepare();
  ui.panes.dataset.view = view;
  const visiblePanes = new Set(view === "split" ? ["editor-pane", "preview-pane"] : [`${view === "rich" ? "rich" : view}-pane`]);
  for (const pane of ui.panes.children) {
    const visible = [...visiblePanes].some((className) => pane.classList.contains(className));
    pane.inert = !visible;
    pane.setAttribute("aria-hidden", String(!visible));
  }
  if (view !== previousView) {
    if (view === "rich") notice(element("rich-warning"), "");
    focusAfterLoad = view === "rich" && focus;
    loadInlineEditor();
  }
  for (const button of document.querySelectorAll(".view-options button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  setText(ui.viewLabel, {
    rich: "Live", editor: "Source", split: "Compare", preview: "Read",
  }[view] ?? "View");
  publishCollaborativeCursor();
  schedulePeerCursors();
  if (["split", "preview"].includes(view)) schedulePreview(0);
  else invalidatePreview();
  if (focus) {
    if (view === "preview") ui.preview.focus();
    else if (view === "rich") inlineEditor.focus();
    else if (activeDocument) ui.editor.focus({ preventScroll: true });
  }
}

async function copyText() {
  if (!activeDocument) return;
  const text = ui.editor.value;
  const id = documentId;
  window.clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(text);
    setText(ui.copy, "Copied");
    setText(ui.copyStatus, "Editor text copied to the clipboard.");
  } catch {
    if (id === documentId) {
      setView("editor");
      ui.editor.focus();
      ui.editor.select();
      setText(ui.copy, "Press Ctrl+C");
      setText(ui.copyStatus, "Clipboard access is unavailable. Editor text selected; press Ctrl+C to copy.");
      documentNotice("Clipboard access is unavailable. Your text is selected in the editor; press Ctrl+C to copy it.");
    }
  }
  copyTimer = window.setTimeout(() => setText(ui.copy, "Copy Markdown"), 3000);
}
