let autoSaveTimer = null;
let deferredPreview = null;

function cancelAutoSave() {
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
}

function scheduleAutoSave(delay = webPreferences.autoSaveDelayMs) {
  cancelAutoSave();
  if (!activeDocument || conflict || rootChanged() || connectionState !== "ready") return;
  autoSaveTimer = window.setTimeout(() => {
    autoSaveTimer = null;
    if (!activeDocument || loadingDocument || pendingSave || creating || movingEntry
        || conflict || rootChanged() || connectionState !== "ready" || !dirty()) return;
    void saveDocument(true);
  }, delay);
}

function restoreCommittedUrl() {
  if (window.location.href !== committedUrl) {
    window.history.replaceState(window.history.state, "", committedUrl);
  }
}

function commitUrl(url, mode = "push") {
  if (mode === "push" && url.href !== committedUrl) window.history.pushState(null, "", url);
  else if (window.location.href !== url.href) window.history.replaceState(window.history.state, "", url);
  committedUrl = url.href;
}

function invalidatePreview() {
  window.clearTimeout(previewTimer);
  previewTimer = null;
  previewGate.invalidate();
  previewController?.abort();
  previewController = null;
}

function cancelDocumentLoad(restoreRoute = true) {
  if (!loadingDocument) return false;
  const previous = loadingDocument;
  loadingDocument = null;
  documentGate.invalidate();
  previous.controller.abort();
  notice(ui.loadingMessage, "");
  if (restoreRoute && previous.mode === "pop") restoreCommittedUrl();
  refreshControls();
  if (activeDocument) schedulePreview(0);
  return true;
}

function confirmDiscard(action) {
  if (!dirty()) return true;
  return window.confirm(`“${activeDocument.path}” has unsaved changes.\n\nDiscard those changes and ${action}?\nChoose Cancel to keep editing.`);
}

function emptyPreview(title, message) {
  const container = document.createElement("div");
  container.className = "empty-state";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  container.append(heading, paragraph);
  ui.preview.replaceChildren(container);
}

function internalNoteUrl(url) {
  return url.origin === window.location.origin
    && ((url.pathname === "/" || url.pathname === "/index.html") && isResourceId(url.searchParams.get("document"))
      || publicView && url.pathname === "/share" && url.searchParams.get("share") === publicToken);
}

function renderPreview(html, resetScroll = false) {
  resetScroll ||= renderedPreviewDocument !== documentId
    || deferredPreview?.document === documentId && deferredPreview.resetScroll;
  if (!["split", "preview"].includes(ui.panes.dataset.view)) {
    deferredPreview = { html, resetScroll, document: documentId, revision: editorRevision };
    return;
  }
  deferredPreview = null;
  const scrollTop = resetScroll ? 0 : ui.preview.scrollTop;
  // This is the only HTML sink: the authenticated Rust renderer escapes and sanitizes Markdown.
  ui.preview.innerHTML = html;
  for (const node of ui.preview.querySelectorAll("a[href], img[src]")) {
    const attribute = node.tagName === "IMG" ? "src" : "href";
    node.dataset.noteUrl = node.getAttribute(attribute);
    node.dataset.noteTitle = node.getAttribute("title") ?? "";
  }
  refreshPreviewLinks();
  if (!html.trim()) emptyPreview("A fresh page", "Start typing Markdown in the editor. Your preview will appear here.");
  for (const link of ui.preview.querySelectorAll('a[href]:not([href^="/"]):not([href^="#"])')) {
    if (link.origin !== window.location.origin) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  ui.preview.scrollTop = scrollTop;
  renderedPreviewDocument = documentId;
  renderedPreviewRevision = editorRevision;
}

function refreshPreviewLinks() {
  for (const node of ui.preview.querySelectorAll("[data-note-url]")) {
    const attribute = node.tagName === "IMG" ? "src" : "href";
    const url = projectUrl(node.dataset.noteUrl);
    if (url) {
      node.setAttribute(attribute, url);
      if (node.dataset.noteTitle) node.title = node.dataset.noteTitle;
      else node.removeAttribute("title");
    }
    else {
      node.removeAttribute(attribute);
      node.title = "This resource is unavailable in the current document.";
    }
  }
}

function scrollToHeading(hash) {
  if (!hash || hash === "#") {
    const scroller = ui.panes.dataset.view === "rich"
      ? element("rich-editor").querySelector("[data-editor-scroller]") : ui.preview;
    scroller?.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // A literal percent sign is also a valid heading identifier.
  }
  if (ui.panes.dataset.view === "rich") {
    inlineEditor.jumpTo(id);
    return;
  }
  const target = ui.preview.querySelector(`#${CSS.escape(id)}`);
  if (!target) return;
  const top = target.getBoundingClientRect().top - ui.preview.getBoundingClientRect().top + ui.preview.scrollTop - 14;
  ui.preview.scrollTo({
    top: Math.max(0, top),
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

function useDocument(payload, root, url, mode, message = "") {
  stopDocumentParticipation();
  stopCollaboration();
  cancelAutoSave();
  invalidatePreview();
  pendingHeading = null;
  documentId += 1;
  editorRevision += 1;
  activeDocument = { ...createDocumentModel(payload), root };
  documentPermissions = payload.permissions ? validatedDocumentPermissions(payload.permissions) : null;
  ui.editor.reset(activeDocument.text);
  void startDocumentParticipation();
  renderCollaborators();
  if (["editor", "split"].includes(ui.panes.dataset.view)) ui.editor.prepare();
  commitUrl(makeNoteUrl(url, payload.id, url.hash), mode);
  notice(element("rich-warning"), "");
  loadInlineEditor();
  conflict = false;
  notice(ui.conflictMessage, "");
  documentNotice(message, message ? "success" : "");
  renderPreview(payload.html, true);
  previewStatus("Up to date");
  refreshControls();
  updateFileSelection();
  noteVisited();
  if (compactLayout.matches) setSidebar(false);
  const id = documentId;
  window.requestAnimationFrame(() => {
    if (id !== documentId) return;
    ui.editor.scrollTop = 0;
    scrollToHeading(url.hash);
  });
}

function clearDocument(url, mode) {
  stopDocumentParticipation();
  stopCollaboration();
  cancelAutoSave();
  invalidatePreview();
  pendingHeading = null;
  documentId += 1;
  editorRevision += 1;
  activeDocument = null;
  documentPermissions = null;
  deferredPreview = null;
  renderedPreviewDocument = -1;
  renderedPreviewRevision = -1;
  ui.editor.reset("");
  inlineEditorPath = null;
  inlineEditor.clear();
  notice(element("rich-warning"), "");
  conflict = false;
  notice(ui.conflictMessage, "");
  documentNotice("");
  emptyPreview("A place for your Markdown", "Open a file from the list, or create a new note.");
  previewStatus("Select a note to begin");
  commitUrl(url, mode);
  refreshControls();
  updateFileSelection();
}

async function navigateTo(path, hash = "", { mode = "push", url, reload = false } = {}) {
  let targetUrl = url ?? new URL(committedUrl);
  if (authMode === "users" && targetUrl.searchParams.get("project") && targetUrl.searchParams.get("project") !== activeProject?.id) {
    await loadProjects();
    return switchProject(targetUrl.searchParams.get("project"), { url: targetUrl, mode });
  }
  cancelDocumentLoad(mode !== "pop");
  if (!reload && (path === activeDocument?.id || path === activeDocument?.path) && !rootChanged()) {
    targetUrl = makeNoteUrl(targetUrl, activeDocument.id, hash);
    commitUrl(targetUrl, mode);
    scrollToHeading(hash);
    return true;
  }
  if (pendingSave || creating) {
    documentNotice("Please wait for the current save or creation to finish before changing notes.");
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
  const action = reload ? "reload this note from disk" : path ? "open another note" : "close this note";
  if (!confirmDiscard(action)) {
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
  if (ui.newDialog.open) ui.newDialog.close();
  if (!path) {
    clearDocument(makeNoteUrl(targetUrl, null), mode);
    return true;
  }
  if (connectionState !== "ready") {
    documentNotice("This tab is disconnected. Your current text has been kept. Reconnect or reopen Notes using the app or CLI launch URL.", "error");
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
  invalidatePreview();
  const ticket = documentGate.next();
  const controller = new AbortController();
  const originalRevision = editorRevision;
  const originalDocument = documentId;
  const root = currentRoot;
  loadingDocument = { ticket, controller, mode };
  notice(ui.loadingMessage, `${reload ? "Reloading" : "Opening"} “${path}”…${activeDocument ? " You can keep typing to cancel." : ""}`);
  if (activeDocument) previewStatus("Waiting for the requested note…");
  refreshControls();
  try {
    const resource = await documentResource(path, controller.signal);
    if (!documentGate.isCurrent(ticket) || originalRevision !== editorRevision || originalDocument !== documentId) return false;
    if (authMode === "users" && resource.project !== activeProject?.id) {
      targetUrl = makeNoteUrl(targetUrl, resource.id, hash);
      targetUrl.searchParams.set("project", resource.project);
      await loadProjects();
      return switchProject(resource.project, { url: targetUrl, mode });
    }
    targetUrl = makeNoteUrl(targetUrl, resource.id, hash);
    const payload = expectDocument(await api(`/api/document?id=${encodeURIComponent(resource.id)}`, { signal: controller.signal }));
    if (!documentGate.isCurrent(ticket) || originalRevision !== editorRevision || originalDocument !== documentId) return false;
    if (root !== currentRoot) throw new ApiError("The notes folder changed while this file was opening. Try opening it again.");
    useDocument(payload, root, targetUrl, mode, reload ? "Reloaded from disk." : "");
    return true;
  } catch (error) {
    if (!documentGate.isCurrent(ticket) || aborted(error)) return false;
    documentNotice(`Could not ${reload ? "reload" : "open"} “${path}”: ${error.message} Your current editor text has been kept.`, "error");
    connectionFailure(error);
    if (mode === "pop") restoreCommittedUrl();
    if (activeDocument) schedulePreview(0);
    return false;
  } finally {
    if (documentGate.isCurrent(ticket)) {
      loadingDocument = null;
      notice(ui.loadingMessage, "");
      refreshControls();
      if (activeDocument && dirty()) scheduleAutoSave();
    }
  }
}

function schedulePreview(delay = webPreferences.previewDelayMs) {
  invalidatePreview();
  if (!activeDocument) return;
  if (!["split", "preview"].includes(ui.panes.dataset.view)) return;
  if (editorBytes > MAX_MARKDOWN_BYTES) {
    previewStatus("Preview paused: the note exceeds 4 MiB.", true);
    return;
  }
  if (rootChanged()) {
    previewStatus("Preview paused: the notes folder changed.", true);
    return;
  }
  if (deferredPreview?.document === documentId && deferredPreview.revision === editorRevision) {
    renderPreview(deferredPreview.html, deferredPreview.resetScroll);
  } else {
    deferredPreview = null;
  }
  if (renderedPreviewDocument === documentId && renderedPreviewRevision === editorRevision) {
    previewStatus("Up to date");
    return;
  }
  if (connectionState !== "ready") {
    previewStatus("Disconnected. The last successful preview is still shown.", true);
    return;
  }
  const ticket = previewGate.next();
  const revision = editorRevision;
  const id = documentId;
  previewStatus(delay ? "Waiting for typing…" : "Updating…");
  previewTimer = window.setTimeout(async () => {
    if (!previewGate.isCurrent(ticket) || id !== documentId || revision !== editorRevision) return;
    const controller = new AbortController();
    previewController = controller;
    const body = { id: activeDocument.id, content: serializeEditorText(activeDocument, ui.editor.value) };
    previewStatus("Updating…");
    try {
      const payload = await api("/api/preview", { method: "POST", body, signal: controller.signal });
      if (!previewGate.isCurrent(ticket) || id !== documentId || revision !== editorRevision) return;
      if (typeof payload?.html !== "string") throw new ApiError("The service returned an incomplete preview.");
      renderPreview(payload.html);
      previewStatus("Up to date");
    } catch (error) {
      if (!previewGate.isCurrent(ticket) || aborted(error)) return;
      previewStatus(`Preview failed: ${error.message} The last successful preview is still shown.`, true);
      connectionFailure(error);
    } finally {
      if (previewGate.isCurrent(ticket)) previewController = null;
    }
  }, delay);
}

async function saveDocument(automatic = false) {
  if (!projectWritable()) { if (!automatic) documentNotice("This page is read-only.", "warning"); return; }
  cancelAutoSave();
  if (collaboration) { saveCollaboration(); return; }
  if (!activeDocument || pendingSave || creating || movingEntry) return;
  if (loadingDocument) {
    if (!automatic) documentNotice("A note is still opening. Keep typing to cancel that request before saving.");
    return;
  }
  if (conflict) {
    if (!automatic) documentNotice("Resolve the disk conflict first. Copy your changes before choosing Reload from disk.", "warning");
    return;
  }
  if (rootChanged() || connectionState !== "ready") {
    if (!automatic) documentNotice("Saving is unavailable until this tab is connected to the same notes folder. Your editor text has been kept.", "error");
    return;
  }
  if (!dirty()) return;
  const snapshot = createSaveSnapshot(activeDocument, ui.editor.value);
  if (markdownByteLength(snapshot.content) > MAX_MARKDOWN_BYTES) {
    refreshControls();
    if (!automatic) documentNotice("The note exceeds the 4 MiB limit and has not been saved.", "error");
    return;
  }
  const operation = { snapshot, id: documentId, root: activeDocument.root };
  pendingSave = operation;
  refreshControls();
  try {
    const payload = expectDocument(await api("/api/document", {
      method: "PUT",
      body: { id: snapshot.id, content: snapshot.content, version: snapshot.version },
    }));
    if (operation.id !== documentId) return;
    const currentTitle = activeDocument.title;
    const result = reconcileSave(snapshot, payload, ui.editor.value);
    activeDocument = { ...result.document, root: operation.root };
    updateFileTitle(snapshot.path, result.document.title);
    if (result.dirty) activeDocument.title = currentTitle;
    if (ui.editor.value !== result.text) {
      ui.editor.value = result.text;
      editorRevision += 1;
      loadInlineEditor();
    }
    documentNotice(payload.warning ?? "", payload.warning ? "warning" : "");
    finishLocalDraft();
    if (!result.dirty) {
      invalidatePreview();
      renderPreview(payload.html);
      previewStatus("Up to date");
    }
  } catch (error) {
    if (operation.id !== documentId) return;
    if (error.status === 409) {
      conflict = true;
      notice(ui.conflictMessage, `This file changed on disk: ${error.message} Your editor text has been kept and was not saved. `
        + "Copy your changes before choosing Reload from disk. Notes will not overwrite the external changes.", "warning");
      documentNotice("");
    } else {
      documentNotice(`Could not save: ${error.message} Your editor text has been kept.`, "error");
      connectionFailure(error);
    }
  } finally {
    if (pendingSave === operation) pendingSave = null;
    refreshControls();
    if (activeDocument && dirty()) scheduleAutoSave();
  }
}
