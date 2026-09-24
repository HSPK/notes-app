function expectDocument(payload) {
  if (!payload || !isResourceId(payload.id) || typeof payload.path !== "string" || typeof payload.content !== "string"
      || typeof payload.html !== "string" || payload.version === undefined || payload.version === null
      || (payload.title !== undefined && typeof payload.title !== "string")) {
    throw new ApiError("The service returned an incomplete document.");
  }
  return payload;
}

function connectionFailure(error, force = false) {
  if (authMode === "users" && error.status === 401) {
    showAuthentication(false, "Your login session expired. Log in again; unsaved editor text is still present.");
    return;
  }
  if ((authMode === "users" || publicView) && error.status === 403) {
    documentNotice(error.message, "error");
    return;
  }
  let message = "";
  if (error.status === 401 || error.status === 403) {
    message = "This tab is no longer authorized, or was not opened from Notes. The service may have restarted. "
      + "Your editor text is still here. Copy any unsaved changes, then reopen Notes using the desktop app or the current CLI launch URL.";
  } else if (error.network) {
    message = "The local Notes service is unavailable. Your editor text is still here. "
      + "Check that Notes is running, then choose Reconnect. If it restarted, copy your changes and reopen it using the desktop app or the current CLI launch URL.";
  } else if (force) {
    message = `Could not connect: ${error.message} Your editor text has been kept. Check the Notes app or CLI, then try Reconnect.`;
  }
  if (!message) return;
  connectionState = "error";
  notice(ui.connectionMessage, message, "error");
  refreshControls();
}

let authInvitation = false;

function showAuthentication(setup, message = "", registration = false) {
  authSetup = setup;
  authInvitation = !setup && registration;
  connectionState = "error";
  document.body.dataset.auth = "open";
  ui.appShell.inert = true;
  ui.authScreen.hidden = false;
  setText(ui.authTitle, setup ? "Create the administrator" : authInvitation ? "Create your account" : "Log in to Notes");
  setText(ui.authDescription, setup
    ? "This is the first visit. Create the local administrator shared by every Notes host on this computer."
    : authInvitation ? "Use the one-time invitation provided by your administrator." : "Enter your local Notes account.");
  element("auth-invitation-field").hidden = !authInvitation;
  element("auth-invitation").required = authInvitation;
  element("auth-use-invitation").hidden = setup || authInvitation;
  element("auth-back-login").hidden = !authInvitation;
  ui.authConfirmField.hidden = !(setup || authInvitation);
  ui.authConfirm.required = setup || authInvitation;
  ui.authPassword.autocomplete = setup || authInvitation ? "new-password" : "current-password";
  ui.authConfirm.autocomplete = "new-password";
  setText(ui.authHint, setup
    ? "Use 3-64 ASCII characters for the username and at least 12 UTF-8 bytes for the password."
    : authUser?.username ? `Session for ${authUser.username} ended.` : "");
  notice(ui.authError, message, message ? "error" : "");
  setText(ui.authSubmit, setup ? "Create administrator" : authInvitation ? "Create account" : "Log in");
  ui.logout.hidden = true;
  refreshControls();
  window.requestAnimationFrame(() => {
    if (authUser?.username && !setup) ui.authUsername.value = authUser.username;
    ui.authUsername.focus();
  });
}

function hideAuthentication() {
  delete document.body.dataset.auth;
  ui.appShell.inert = false;
  ui.authScreen.hidden = true;
  notice(ui.authError, "");
  ui.logout.hidden = authMode !== "users" || !authUser;
  if (authUser) {
    ui.logout.textContent = `Log out ${authUser.username}`;
  }
}

async function bootstrapAuthentication() {
  if (publicView) { await connectPublic(); return; }
  connectionState = "connecting";
  refreshControls();
  try {
    const status = await api("/api/auth/status");
    if (!status || !["users", "launchToken"].includes(status.mode)
        || typeof status.authenticated !== "boolean" || typeof status.setupRequired !== "boolean") {
      throw new ApiError("The service returned an incomplete authentication status.");
    }
    authMode = status.mode;
    if (authMode === "users") {
      token = null;
      storageUnavailable = false;
      authUser = status.authenticated && typeof status.username === "string"
        ? { username: status.username, role: status.role, id: status.id, scope: status.scope, draftKey: status.draftKey } : null;
      if (status.setupRequired) {
        showAuthentication(true);
        return;
      }
      if (!status.authenticated) {
        showAuthentication(false);
        return;
      }
    } else if (!status.authenticated) {
      throw new ApiError(
        "This tab has no valid Notes connection token. Reopen Notes using the desktop app or current CLI launch URL.",
        401,
      );
    }
    hideAuthentication();
    await loadUserWorkspace();
    await connect();
  } catch (error) {
    connectionFailure(error, true);
  }
}

async function submitAuthentication(event) {
  event.preventDefault();
  if (authenticating) return;
  if ((authSetup || authInvitation) && ui.authPassword.value !== ui.authConfirm.value) {
    notice(ui.authError, "The password confirmation does not match.", "error");
    ui.authConfirm.focus();
    return;
  }
  authenticating = true;
  notice(ui.authError, "");
  setText(ui.authSubmit, authSetup ? "Creating…" : "Logging in…");
  refreshControls();
  try {
    const result = await api(authSetup ? "/api/auth/setup" : authInvitation ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      body: { username: ui.authUsername.value, password: ui.authPassword.value,
        ...(authInvitation ? { invitation: element("auth-invitation").value.trim() } : {}) },
    });
    if (!result?.user || typeof result.user.username !== "string") {
      throw new ApiError("The service returned an incomplete authenticated user.");
    }
    if (authUser && ((authUser.id ? authUser.id !== result.user.id : authUser.username !== result.user.username)
        || authUser.scope && authUser.scope !== result.user.scope)) {
      const pending = persistCurrentDraft();
      stopCollaboration();
      await pending;
      clearDocument(new URL("/", window.location.href), "replace");
      window.location.replace("/");
      return;
    }
    authUser = result.user;
    ui.authPassword.value = "";
    ui.authConfirm.value = "";
    element("auth-invitation").value = "";
    hideAuthentication();
    await loadUserWorkspace();
    await connect();
  } catch (error) {
    if (authSetup && error.status === 409) {
      authSetup = false;
      showAuthentication(false, "Another request completed the initial setup. Log in with that account.");
    } else {
      notice(ui.authError, error.message, "error");
    }
  } finally {
    authenticating = false;
    setText(ui.authSubmit, authSetup ? "Create administrator" : authInvitation ? "Create account" : "Log in");
    refreshControls();
  }
}

async function logout() {
  if (authMode !== "users" || authenticating || pendingSave || creating) return;
  if (!confirmDiscard("log out")) return;
  ui.logout.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST" });
    window.location.reload();
  } catch (error) {
    documentNotice(`Could not log out: ${error.message}`, "error");
    connectionFailure(error);
    ui.logout.disabled = false;
  }
}

function setRoot(root) {
  const changed = currentRoot !== null && currentRoot !== root;
  if (changed) {
    files = [];
    directories = [];
    treeLoaded = false;
    treeTruncated = false;
    collapsedFolders.clear();
    renderFiles();
    invalidatePreview();
  }
  currentRoot = root;
  refreshControls();
  if (changed && activeDocument) {
    if (rootChanged()) previewStatus("Preview paused: the notes folder changed.", true);
    else schedulePreview(0);
  }
}

function refreshDocumentTitle(modified = !ui.modified.hidden) {
  setText(ui.title, activeDocument?.title ?? activeDocument?.path ?? "Select a note");
  const title = browserDocumentTitle(activeDocument, modified);
  if (document.title !== title) document.title = title;
}

function renderDocumentStatus(changed) {
  let state = "empty";
  let status = "No note open";
  if (activeDocument) {
    state = conflict ? "conflict" : pendingSave || collaboration?.saving ? "saving" : changed ? "dirty" : "saved";
    status = conflict ? "Disk conflict — editor text kept"
      : pendingSave ? (ui.editor.value === pendingSave.snapshot.text ? "Saving a snapshot…" : "Saving — newer edits are unsaved")
      : collaboration?.saving ? "Saving shared changes…" : projectWritable() ? "" : "Read only";
  }
  ui.dirty.dataset.state = state;
  setText(ui.dirty, status);
  ui.dirty.hidden = !status;
  const modified = Boolean(activeDocument && changed);
  setText(ui.modified, modified ? " *" : "");
  ui.modified.hidden = !modified;
  refreshDocumentTitle(modified);
}

function scheduleControlRefresh(delay = 180) {
  window.clearTimeout(deferredControlTimer);
  deferredControlTimer = window.setTimeout(() => {
    deferredControlTimer = null;
    refreshControls();
  }, delay);
}

function scheduleOutlineRefresh(changes = null, delay = webPreferences.outlineDelayMs) {
  const pending = outlineTimer !== null;
  window.clearTimeout(outlineTimer);
  if (ui.outlinePanel.hidden) {
    outlineTimer = null;
    outlineChanges = null;
    return;
  }
  outlineChanges = pending ? null : changes;
  outlineTimer = window.setTimeout(() => {
    outlineTimer = null;
    if (!ui.outlinePanel.hidden) refreshOutline();
  }, delay);
}

function refreshControls() {
  window.clearTimeout(deferredControlTimer);
  deferredControlTimer = null;
  const analysis = currentEditorAnalysis();
  const changed = analysis.changed;
  const ready = connectionState === "ready";
  const writing = Boolean(pendingSave || creating || movingEntry);
  editorBytes = analysis.bytes;
  const tooLarge = editorBytes > MAX_MARKDOWN_BYTES;
  ui.editor.disabled = !activeDocument || collaborationLocked();
  ui.editor.setReadOnly(!projectWritable());
  inlineEditor.setReadOnly(!projectWritable() || collaborationLocked());
  ui.reload.disabled = !activeDocument || writing || !ready;
  ui.copy.disabled = !activeDocument;
  ui.newNote.disabled = !ready || writing || !projectCanCreate();
  ui.newFolder.disabled = !ready || writing || !projectCanCreate();
  ui.emptyNew.disabled = ui.newNote.disabled;
  ui.empty.hidden = Boolean(activeDocument);
  ui.panes.hidden = !activeDocument;
  ui.refreshFiles.disabled = !ready || treeLoading;
  ui.reconnect.disabled = connectionState === "connecting" || writing;
  ui.reconnect.hidden = ready;
  ui.logout.disabled = authenticating || writing || connectionState === "connecting";
  ui.authUsername.disabled = authenticating;
  ui.authPassword.disabled = authenticating;
  ui.authConfirm.disabled = authenticating;
  ui.authSubmit.disabled = authenticating;
  ui.newTitle.disabled = creating;
  element("new-note-template").disabled = creating;
  ui.cancelNew.disabled = creating;
  ui.create.disabled = creating;
  ui.newFolderPath.disabled = creating;
  ui.cancelNewFolder.disabled = creating;
  ui.createFolder.disabled = creating;
  ui.renamePath.disabled = movingEntry;
  ui.cancelRename.disabled = movingEntry;
  ui.confirmRename.disabled = movingEntry;
  setText(ui.create, creating ? "Creating…" : "Create note");
  setText(ui.createFolder, creating ? "Creating…" : "Create folder");
  setText(ui.confirmRename, movingEntry ? "Moving…" : "Rename");
  ui.connectionLabel.dataset.state = connectionState;
  setText(ui.connectionLabel, ready ? "Local service" : connectionState === "connecting" ? "Connecting…" : "Disconnected");
  ui.connectionLabel.title = ready && currentPort ? `Connected on loopback port ${currentPort}` : "";

  if (activeDocument) {
    const ending = activeDocument.format.lineEnding === "\r\n" ? "CRLF"
      : activeDocument.format.lineEnding === "\r" ? "CR" : "LF";
    if (wordSource !== ui.editor.value) {
      wordSource = ui.editor.value;
      wordCount = wordCounter.count(wordSource);
    }
    setText(ui.stats, `${wordCount.toLocaleString()} ${wordCount === 1 ? "word" : "words"}`);
    ui.stats.title = `${analysis.lines.toLocaleString()} lines · ${formatByteCount(editorBytes)} · ${ending}${activeDocument.format.bom ? " · BOM" : ""}`;
  } else {
    setText(ui.stats, "");
  }
  renderDocumentStatus(changed);
  ui.editor.setAttribute("aria-invalid", String(tooLarge));
  notice(ui.sizeWarning, tooLarge
    ? `This note is ${formatByteCount(editorBytes)}; the limit is 4 MiB. Reduce the text before saving or previewing. Your text has not been removed.`
    : "", "error");
  notice(ui.rootWarning, rootChanged()
    ? "The notes folder changed. Your open text has been kept, but it belongs to the previous folder. Copy any changes before reloading or choosing a note from the new folder."
    : "", "warning");
  if (!ui.outlinePanel.hidden) refreshOutline();
  updateProjectControls();
  refreshWorkspaceControls();
}

function refreshOutline() {
  window.clearTimeout(outlineTimer);
  outlineTimer = null;
  const changes = outlineChanges;
  outlineChanges = null;
  if (outlineSource === ui.editor.value) return;
  outlineSource = ui.editor.value;
  renderOutline(activeDocument ? outlineExtractor.extract(outlineSource, changes) : []);
}

function renderOutline(items) {
  if (items.length === outlineItems.length && outlineButtons.length === items.length
      && (items.length === 0 || outlineButtons[0].isConnected)) {
    items.forEach((item, index) => {
      const previous = outlineItems[index];
      const button = outlineButtons[index];
      if (item.text !== previous.text) button.textContent = item.text || "Untitled heading";
      if (item.level !== previous.level) button.dataset.level = String(item.level);
    });
    outlineItems = items;
    ui.outlineEmpty.hidden = items.length > 0;
    return;
  }
  outlineItems = items;
  outlineButtons = [];
  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.text || "Untitled heading";
    button.dataset.level = String(item.level);
    button.dataset.heading = String(index);
    outlineButtons.push(button);
    row.append(button);
    fragment.append(row);
  });
  ui.outlineList.replaceChildren(fragment);
  ui.outlineEmpty.hidden = items.length > 0;
}

function selectSidebarTab(tab, focus = false) {
  const selected = ["files", "outline", "git"].includes(tab) ? tab : "files";
  const tabs = [
    ["files", ui.filesTab, ui.filesPanel],
    ["outline", ui.outlineTab, ui.outlinePanel],
    ["git", gitUi.tab, gitUi.panel],
  ];
  for (const [name, button, panel] of tabs) {
    const active = name === selected;
    panel.hidden = !active;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  if (selected === "outline") refreshOutline();
  if (selected === "git") {
    window.setTimeout(() => {
      if (!gitUi.panel.hidden) void refreshGit();
    }, 0);
  } else scheduleGitRefresh();
  if (focus) tabs.find(([name]) => name === selected)[1].focus();
}

function setSidebar(open) {
  if (publicView) open = false;
  document.body.dataset.sidebar = open ? "open" : "closed";
  ui.sidebarToggle.setAttribute("aria-expanded", String(open));
  ui.sidebar.inert = !open;
  ui.sidebarResizer.tabIndex = open && !compactLayout.matches ? 0 : -1;
  ui.scrim.hidden = !open || !compactLayout.matches;
  if (!open && ui.sidebar.contains(document.activeElement)) ui.sidebarToggle.focus();
}

function closeMenus() {
  for (const popup of document.querySelectorAll(".popup[open]")) popup.open = false;
}

function toggleFocusMode() {
  const enabled = document.body.dataset.focus !== "true";
  if (enabled) sidebarBeforeFocus = document.body.dataset.sidebar === "open";
  document.body.dataset.focus = String(enabled);
  ui.focusMode.setAttribute("aria-pressed", String(enabled));
  setSidebar(enabled ? false : sidebarBeforeFocus);
  closeMenus();
}
