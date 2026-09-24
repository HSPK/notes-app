async function connect() {
  if (publicView) { await connectPublic(); return; }
  restoreActiveWorkspaceNote();
  stopAppearancePolling();
  connectionController?.abort();
  treeController?.abort();
  treeGate.invalidate();
  treeLoading = false;
  cancelDocumentLoad();
  invalidatePreview();
  const controller = new AbortController();
  connectionController = controller;
  const ticket = connectionGate.next();
  connectionState = "connecting";
  notice(ui.connectionMessage, "");
  refreshControls();
  try {
    if (!await ensureProject()) { refreshControls(); return; }
    if (!connectionGate.isCurrent(ticket)) return;
    const session = await api("/api/session", { method: "POST", signal: controller.signal });
    if (!connectionGate.isCurrent(ticket)) return;
    if (!session || typeof session.root !== "string" || !Number.isInteger(session.port)) {
      throw new ApiError("The service returned incomplete session settings.");
    }
    currentPort = session.port;
    if (session.project) activeProject = session.project;
    connectionState = "ready";
    setRoot(session.root);
    await refreshSharedPreferences();
    const tokenStorageUnavailable = authMode === "launchToken" && storageUnavailable;
    notice(ui.connectionMessage, tokenStorageUnavailable
      ? "This browser could not store the connection token for this tab. Copy unsaved work before refreshing; you may need to reopen Notes using the app or CLI launch URL."
      : "", tokenStorageUnavailable ? "warning" : "");
    refreshControls();
    void refreshAppearance(true);
    void refreshFiles();
    void refreshGitSync();
    if (activeDocument) {
      scheduleAutoSave();
      schedulePreview(0);
    } else {
      const route = readNoteRoute(window.location.href);
      if (route.id) void navigateTo(route.id, route.hash, { mode: "replace", url: new URL(window.location.href) });
      else previewStatus("Select a note to begin");
    }
  } catch (error) {
    if (!connectionGate.isCurrent(ticket) || aborted(error)) return;
    connectionFailure(error, true);
    previewStatus(activeDocument ? "Disconnected. Your editor text and last preview are kept." : "Open Notes using the app or CLI launch URL to connect", true);
    renderTreeStatus();
  } finally {
    if (connectionGate.isCurrent(ticket)) {
      connectionController = null;
      refreshControls();
    }
  }
}

ui.authForm.addEventListener("submit", (event) => void submitAuthentication(event));
ui.logout.addEventListener("click", () => void logout());
ui.commandOpen.addEventListener("click", openCommandPanel);
ui.commandClose.addEventListener("click", closeCommandPanel);
ui.commandForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runCommand();
});
ui.commandQuery.addEventListener("input", () => {
  commandIndex = 0;
  renderCommandPanel();
});
ui.commandQuery.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    selectCommand(commandIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    selectCommand(commandIndex - 1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    runCommand();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeCommandPanel();
  }
});
ui.reconnect.addEventListener("click", () => {
  if (authMode === "users" && !authUser) showAuthentication(false);
  else void connect();
});
ui.sidebarToggle.addEventListener("click", () => setSidebar(document.body.dataset.sidebar !== "open"));
ui.scrim.addEventListener("click", () => setSidebar(false));
ui.filesTab.addEventListener("click", () => selectSidebarTab("files"));
ui.outlineTab.addEventListener("click", () => selectSidebarTab("outline"));
gitUi.tab.addEventListener("click", () => selectSidebarTab("git"));
const sidebarTabs = [ui.filesTab, ui.outlineTab, gitUi.tab];
for (const tab of sidebarTabs) {
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = sidebarTabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? sidebarTabs.length - 1
      : (index + (event.key === "ArrowLeft" ? -1 : 1) + sidebarTabs.length) % sidebarTabs.length;
    selectSidebarTab(sidebarTabs[next].id.replace("-tab", ""), true);
  });
}
ui.outlineList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-heading]");
  if (!button || !activeDocument) return;
  const heading = outlineItems[Number(button.dataset.heading)];
  if (ui.panes.dataset.view === "rich") {
    if (element("rich-editor").getAttribute("aria-busy") === "true") pendingHeading = heading.from;
    else inlineEditor.jumpTo(heading.from);
  }
  else if (ui.panes.dataset.view === "preview") scrollToHeading(`#${encodeURIComponent(heading.id)}`);
  else {
    ui.editor.focus();
    ui.editor.setSelectionRange(heading.from, heading.from);
    ui.editor.scrollTop = Math.max(0, ui.editor.value.slice(0, heading.from).split("\n").length - 4)
      * ui.editor.lineHeight;
  }
  if (compactLayout.matches) setSidebar(false);
});
ui.focusMode.addEventListener("click", toggleFocusMode);
ui.emptyNew.addEventListener("click", () => openNewNote());
compactLayout.addEventListener("change", () => setSidebar(!compactLayout.matches));
window.addEventListener("resize", () => setSidebarWidth(preferredSidebarWidth));
ui.sidebarResizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || compactLayout.matches || document.body.dataset.sidebar !== "open") return;
  event.preventDefault();
  document.body.dataset.resizingSidebar = "true";
  ui.sidebarResizer.setPointerCapture(event.pointerId);
  setSidebarWidth(event.clientX);
});
ui.sidebarResizer.addEventListener("pointermove", (event) => {
  if (!ui.sidebarResizer.hasPointerCapture(event.pointerId)) return;
  setSidebarWidth(event.clientX);
});
const finishSidebarResize = (event) => {
  if (!ui.sidebarResizer.hasPointerCapture(event.pointerId)) return;
  ui.sidebarResizer.releasePointerCapture(event.pointerId);
  delete document.body.dataset.resizingSidebar;
  setSidebarWidth(preferredSidebarWidth, true);
};
ui.sidebarResizer.addEventListener("pointerup", finishSidebarResize);
ui.sidebarResizer.addEventListener("pointercancel", finishSidebarResize);
ui.sidebarResizer.addEventListener("lostpointercapture", () => {
  delete document.body.dataset.resizingSidebar;
});
ui.sidebarResizer.addEventListener("dblclick", () => setSidebarWidth(SIDEBAR_DEFAULT, true));
ui.sidebarResizer.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
  event.preventDefault();
  const width = event.key === "Home" ? SIDEBAR_DEFAULT
    : preferredSidebarWidth + (event.key === "ArrowLeft" ? -10 : 10);
  setSidebarWidth(width, true);
});
for (const button of document.querySelectorAll("[data-page-width]")) {
  button.addEventListener("click", () => setPageWidth(button.dataset.pageWidth, true));
}
document.addEventListener("pointerdown", (event) => {
  if (!ui.fileContextMenu.hidden && !ui.fileContextMenu.contains(event.target)) {
    closeFileContextMenu();
  }
  for (const popup of document.querySelectorAll(".popup[open]")) {
    if (!popup.contains(event.target)) popup.open = false;
  }
});
document.addEventListener("click", (event) => {
  if (event.target.closest(".popup-panel button, .popup-panel a")) closeMenus();
});
ui.refreshFiles.addEventListener("click", () => void refreshFiles());
ui.filter.addEventListener("input", scheduleFileFilterRender);
ui.fileList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-path]");
  if (button) void navigateTo(button.dataset.path);
});
ui.fileList.addEventListener("contextmenu", (event) => {
  const button = event.target.closest("button[data-path]");
  if (button) openFileContextMenu(event, button.dataset.path);
});
ui.fileList.addEventListener("dragstart", (event) => {
  if (event.target.closest(".directory-actions")) {
    event.preventDefault();
    return;
  }
  const entry = event.target.closest("[data-entry-path]");
  if (!entry) return;
  draggedEntry = { path: entry.dataset.entryPath, kind: entry.dataset.entryKind };
  entry.setAttribute("data-dragging", "true");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedEntry.path);
});
ui.fileList.addEventListener("dragend", () => {
  for (const entry of ui.fileList.querySelectorAll("[data-dragging]")) {
    entry.removeAttribute("data-dragging");
  }
  draggedEntry = null;
  setDropTarget(null);
});
ui.appShell.addEventListener("dragover", (event) => {
  if (!draggedEntry) return;
  const target = event.target.closest("[data-directory-path]");
  if (!target) {
    setDropTarget(null);
    return;
  }
  const directory = target.dataset.directoryPath;
  const destination = entryDestination(draggedEntry.path, directory);
  if (destination === draggedEntry.path
      || draggedEntry.kind === "directory"
        && (directory === draggedEntry.path || directory.startsWith(`${draggedEntry.path}/`))) {
    setDropTarget(null);
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  setDropTarget(target.closest(".directory") ?? target);
});
ui.appShell.addEventListener("drop", (event) => {
  if (!draggedEntry) return;
  const target = event.target.closest("[data-directory-path]");
  if (!target) return;
  event.preventDefault();
  const entry = draggedEntry;
  const destination = entryDestination(entry.path, target.dataset.directoryPath);
  draggedEntry = null;
  setDropTarget(null);
  void moveLibraryEntry(entry, destination);
});
ui.reload.addEventListener("click", () => {
  if (activeDocument) void navigateTo(activeDocument.id, readNoteRoute(committedUrl).hash, { mode: "replace", reload: true });
});
ui.copy.addEventListener("click", () => void copyText());
ui.newNote.addEventListener("click", () => openNewNote());
ui.newFolder.addEventListener("click", () => openNewFolder());
ui.newForm.addEventListener("submit", (event) => void createNote(event));
ui.newFolderForm.addEventListener("submit", (event) => void createFolder(event));
ui.cancelNew.addEventListener("click", () => {
  if (!creating) ui.newDialog.close();
});
ui.newDialog.addEventListener("cancel", (event) => {
  if (creating) event.preventDefault();
});
ui.newTitle.addEventListener("input", () => {
  ui.newTitle.setAttribute("aria-invalid", "false");
  refreshNewNoteHint();
});
ui.cancelNewFolder.addEventListener("click", () => {
  if (!creating) ui.newFolderDialog.close();
});
ui.newFolderDialog.addEventListener("cancel", (event) => {
  if (creating) event.preventDefault();
});
ui.newFolderPath.addEventListener("input", () => ui.newFolderPath.setAttribute("aria-invalid", "false"));
ui.fileDetails.addEventListener("click", () => void showFileDetails());
ui.fileRename.addEventListener("click", openRenameDialog);
ui.renameForm.addEventListener("submit", (event) => void renameEntry(event));
ui.cancelRename.addEventListener("click", () => {
  if (!movingEntry) {
    ui.renameDialog.close();
    contextFile = null;
  }
});
ui.renameDialog.addEventListener("cancel", (event) => {
  if (movingEntry) event.preventDefault();
  else contextFile = null;
});
ui.renamePath.addEventListener("input", () => ui.renamePath.setAttribute("aria-invalid", "false"));
ui.closeDetails.addEventListener("click", () => ui.detailsDialog.close());
for (const button of document.querySelectorAll(".view-options button")) {
  button.addEventListener("click", () => setView(button.dataset.view, true));
}
document.querySelector(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  if (ui.panes.dataset.view === "rich") inlineEditor.focus();
  else if (ui.panes.dataset.view === "preview") ui.preview.focus();
  else ui.editor.focus();
});
ui.editor.addEventListener("input", (event) => {
  if (!activeDocument) return;
  editorRevision += 1;
  if (cancelDocumentLoad()) documentNotice("Opening a note was canceled because you continued editing.");
  else if (documentMessageKind === "success") documentNotice("");
  renderDocumentStatus(true);
  collaborationChanged();
  queueDraftPersistence(true);
  scheduleAutoSave();
  scheduleOutlineRefresh(event.detail?.changes);
  scheduleControlRefresh();
  schedulePreview();
});

ui.preview.addEventListener("click", (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest("a[href]");
  if (!link || !activeDocument) return;
  const href = link.getAttribute("href");
  if (href.startsWith("#")) {
    event.preventDefault();
    commitUrl(makeNoteUrl(committedUrl, activeDocument.id, href));
    scrollToHeading(href);
    return;
  }
  let url;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return;
  }
  if (internalNoteUrl(url)) {
    event.preventDefault();
    const route = readNoteRoute(url);
    void navigateTo(route.id ?? (publicView ? activeDocument.id : null), route.hash, { url });
  }
});

window.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (opensCommandPanel(event)) {
    event.preventDefault();
    openCommandPanel();
    return;
  }
  if (event.key === "Escape") {
    closeMenus();
    if (compactLayout.matches) setSidebar(false);
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.shiftKey && event.key.toLowerCase() === "l") {
    event.preventDefault();
    setSidebar(document.body.dataset.sidebar !== "open");
    return;
  }
  if (event.shiftKey && (event.code === "Digit1" || event.key === "1")) {
    event.preventDefault();
    setSidebar(true);
    selectSidebarTab("outline", true);
    return;
  }
  if (event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    toggleFocusMode();
    return;
  }
  if (!event.shiftKey && (event.key === "/" || event.code === "Slash")) {
    event.preventDefault();
    setView(ui.panes.dataset.view === "rich" ? "editor" : "rich", true);
    return;
  }
  if (event.key.toLowerCase() !== "s") return;
  event.preventDefault();
  if (ui.newDialog.open) {
    if (!creating) notice(ui.newError, "Choose Create note to create this file, or Cancel to return to the editor.");
  } else {
    void saveDocument();
  }
});
window.addEventListener("focus", () => {
  void refreshAppearance(true);
  scheduleTreeRefresh();
  scheduleGitRefresh();
});
window.addEventListener("blur", stopAppearancePolling);
window.addEventListener("pagehide", stopAppearancePolling);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopAppearancePolling();
    window.clearTimeout(treeRefreshTimer);
    window.clearTimeout(gitRefreshTimer);
  } else {
    void refreshAppearance(true);
    scheduleTreeRefresh();
    scheduleGitRefresh();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (!dirty() && !pendingSave && !creating) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("popstate", () => {
  const url = new URL(window.location.href);
  if (authMode === "users" && url.searchParams.get("project") !== activeProject?.id) {
    void switchProject(url.searchParams.get("project"), { url, mode: "pop" });
    return;
  }
  const route = readNoteRoute(url);
  void navigateTo(route.id, route.hash, { mode: "pop", url });
});
window.addEventListener("hashchange", () => {
  if (loadingDocument) return;
  const route = readNoteRoute(window.location.href);
  if (route.id === (activeDocument?.id ?? null) || publicView) {
    committedUrl = window.location.href;
    if (route.hash !== "#editor") scrollToHeading(route.hash);
  }
});

setSidebar(!compactLayout.matches);
void bootstrapAuthentication();
