import {
  MAX_MARKDOWN_BYTES,
  RequestGate,
  buildFileTree,
  createDocumentModel,
  createSaveSnapshot,
  filterNotes,
  formatByteCount,
  isDirty,
  makeNoteUrl,
  markdownByteLength,
  normalizeNotePath,
  readLaunchUrl,
  readNoteRoute,
  reconcileSave,
  serializeEditorText,
  validateNewNotePath,
} from "./model.mjs";
import { createInlineEditor, extractOutline, attachScrollbars, applyAppearance } from "./editor.bundle.mjs";

const element = (id) => document.getElementById(id);
const ui = {
  connectionLabel: element("connection-label"),
  connectionMessage: element("connection-message"),
  appearanceMessage: element("appearance-message"),
  reconnect: element("reconnect"),
  rootPath: element("root-path"),
  newNote: element("new-note"),
  refreshFiles: element("refresh-files"),
  filter: element("file-filter"),
  fileCount: element("file-count"),
  treeMessage: element("tree-message"),
  treeLimit: element("tree-limit"),
  fileNav: element("file-nav"),
  fileList: element("file-list"),
  title: element("document-title"),
  dirty: element("dirty-indicator"),
  reload: element("reload-document"),
  copy: element("copy-text"),
  copyStatus: element("copy-status"),
  save: element("save-document"),
  saveLabel: element("save-label"),
  conflictMessage: element("conflict-message"),
  rootWarning: element("root-warning"),
  documentMessage: element("document-message"),
  loadingMessage: element("loading-message"),
  sizeWarning: element("size-warning"),
  panes: element("document-panes"),
  editor: element("editor"),
  stats: element("editor-stats"),
  preview: element("preview"),
  previewStatus: element("preview-status"),
  newDialog: element("new-note-dialog"),
  newForm: element("new-note-form"),
  newPath: element("new-note-path"),
  newError: element("new-note-error"),
  cancelNew: element("cancel-new-note"),
  create: element("create-note"),
  empty: element("empty-document"),
  emptyNew: element("empty-new-note"),
  libraryName: element("library-name"),
  sidebar: element("sidebar"),
  sidebarToggle: element("sidebar-toggle"),
  scrim: element("sidebar-scrim"),
  filesTab: element("files-tab"),
  outlineTab: element("outline-tab"),
  filesPanel: element("files-panel"),
  outlinePanel: element("outline-panel"),
  outlineList: element("outline-list"),
  outlineEmpty: element("outline-empty"),
  formatToggle: element("format-toggle"),
  formatPanel: element("format-panel"),
  focusMode: element("focus-mode"),
};

attachScrollbars(element("files-scroll-frame"), ui.fileNav, { horizontal: false });
attachScrollbars(element("outline-scroll-frame"), element("outline-scroll"), { horizontal: false });
attachScrollbars(ui.editor.parentElement, ui.editor);
attachScrollbars(ui.preview.parentElement, ui.preview);

const compactLayout = window.matchMedia("(max-width: 650px)");
let outlineItems = [];
let outlineSource = null;
let focusAfterLoad = false;
let pendingHeading = null;
let sidebarBeforeFocus = true;
let wordSource = null;
let wordCount = 0;
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const TOKEN_KEY = "notes.connection.token";
const launch = readLaunchUrl(window.location.href);
let token = launch.token;
let storageUnavailable = false;
try {
  if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
  else token = window.sessionStorage.getItem(TOKEN_KEY);
} catch {
  storageUnavailable = true;
}
if (token && !/^[a-f0-9]+$/i.test(token)) token = null;
window.history.replaceState(window.history.state, "", launch.url);

let committedUrl = launch.url.href;
let connectionState = "connecting";
let currentRoot = null;
let currentPort = null;
let activeDocument = null;
let documentId = 0;
let editorRevision = 0;
let conflict = false;
let documentMessageKind = "";
let loadingDocument = null;
let pendingSave = null;
let creating = false;
let newNoteOrigin = null;
let editorBytes = 0;
let files = [];
let treeLoaded = false;
let treeLoading = false;
let treeError = "";
let treeTruncated = false;
let previewTimer = null;
let previewController = null;
let connectionController = null;
let treeController = null;
let copyTimer = null;
let appearanceController = null;
let appearanceTimer = null;
let appearanceGeneration = 0;
const collapsedFolders = new Set();
const connectionGate = new RequestGate();
const treeGate = new RequestGate();
const documentGate = new RequestGate();
const previewGate = new RequestGate();
const inlineEditor = createInlineEditor({
  root: element("rich-editor"),
  toolbar: element("format-toolbar"),
  styleNonce: document.querySelector('meta[name="notes-style-nonce"]').content,
  onOutline(items) {
    if (!activeDocument || ui.panes.dataset.view !== "rich") return;
    outlineSource = ui.editor.value;
    renderOutline(items);
  },
  onSelection({ line, column }) {
    let position = 0;
    for (let index = 1; index < line; index += 1) {
      const next = ui.editor.value.indexOf("\n", position);
      if (next < 0) break;
      position = next + 1;
    }
    position += column - 1;
    const current = outlineItems.findLastIndex((item) => item.from <= position);
    for (const button of ui.outlineList.querySelectorAll("button")) {
      if (Number(button.dataset.heading) === current) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
    }
  },
  onChange(text) {
    if (!activeDocument || ui.panes.dataset.view !== "rich") return;
    ui.editor.value = text;
    outlineSource = text;
    ui.editor.dispatchEvent(new Event("input"));
  },
  onFallback(message) {
    notice(element("rich-warning"), message, "warning");
    setView("editor");
  },
  onReady() {
    if (ui.panes.dataset.view !== "rich") return;
    if (pendingHeading !== null) {
      inlineEditor.jumpTo(pendingHeading);
      pendingHeading = null;
    } else if (focusAfterLoad) {
      inlineEditor.focus();
    } else {
      scrollToHeading(readNoteRoute(committedUrl).hash);
    }
    focusAfterLoad = false;
  },
  onLink(href) {
    if (!activeDocument) return;
    if (href.startsWith("#")) {
      commitUrl(makeNoteUrl(committedUrl, activeDocument.path, href));
      scrollToHeading(href);
      return;
    }
    const url = new URL(href, window.location.href);
    if (internalNoteUrl(url)) {
      const route = readNoteRoute(url);
      void navigateTo(route.path, route.hash, { url });
    } else {
      window.open(url.href, "_blank", "noopener,noreferrer");
    }
  },
});

function loadInlineEditor() {
  if (activeDocument && ui.panes.dataset.view === "rich") {
    void inlineEditor.load(ui.editor.value, activeDocument.path);
  } else {
    inlineEditor.clear();
  }
}

function stopAppearancePolling() {
  window.clearTimeout(appearanceTimer);
  appearanceTimer = null;
  appearanceGeneration += 1;
  appearanceController?.abort();
  appearanceController = null;
}

function scheduleAppearancePolling() {
  window.clearTimeout(appearanceTimer);
  appearanceTimer = null;
  if (connectionState === "ready" && document.visibilityState === "visible" && document.hasFocus()) {
    appearanceTimer = window.setTimeout(() => void refreshAppearance(), 2000);
  }
}

function appearanceNotice(message) {
  if (ui.appearanceMessage.textContent === message && ui.appearanceMessage.hidden === !message) return;
  notice(ui.appearanceMessage, message, message ? "warning" : "");
}

async function refreshAppearance(force = false) {
  if (connectionState !== "ready" || document.visibilityState === "hidden") return;
  if (appearanceController && !force) return;
  if (!force && !document.hasFocus()) return;
  window.clearTimeout(appearanceTimer);
  appearanceTimer = null;
  appearanceController?.abort();
  const controller = new AbortController();
  appearanceController = controller;
  const ticket = ++appearanceGeneration;
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 5000);
  try {
    const settings = await api("/api/appearance", { signal: controller.signal });
    window.clearTimeout(timeout);
    if (ticket !== appearanceGeneration || controller.signal.aborted) return;
    const result = await applyAppearance(settings);
    if (ticket !== appearanceGeneration || controller.signal.aborted) return;
    appearanceNotice(result.warning);
  } catch (error) {
    if (ticket !== appearanceGeneration || (controller.signal.aborted && !timedOut)) return;
    appearanceNotice(`Appearance settings could not be loaded. ${timedOut ? "The request timed out." : error.message} Your note is unchanged.`);
  } finally {
    window.clearTimeout(timeout);
    if (ticket === appearanceGeneration) {
      appearanceController = null;
      scheduleAppearancePolling();
    }
  }
}

class ApiError extends Error {
  constructor(message, status = 0, network = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.network = network;
  }
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function notice(node, text, kind = "") {
  setText(node, text);
  node.hidden = !text;
  node.classList.toggle("is-error", kind === "error");
  node.classList.toggle("is-warning", kind === "warning");
  node.classList.toggle("is-success", kind === "success");
}

function documentNotice(text, kind = "") {
  documentMessageKind = kind;
  notice(ui.documentMessage, text, kind);
  ui.documentMessage.title = text;
}

function previewStatus(text, error = false) {
  setText(ui.previewStatus, text);
  ui.previewStatus.classList.toggle("is-error", error);
}

function rootChanged() {
  return Boolean(activeDocument && activeDocument.root !== currentRoot);
}

function dirty() {
  return isDirty(activeDocument, ui.editor.value);
}

function aborted(error) {
  return error?.name === "AbortError";
}

async function api(path, { method = "GET", body, signal } = {}) {
  if (!token) throw new ApiError("This tab has no Notes connection token.", 401);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (aborted(error) || signal?.aborted) throw error;
    throw new ApiError("The local Notes service could not be reached.", 0, true);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (aborted(error) || signal?.aborted) throw error;
    throw new ApiError(`The service returned an unreadable response (HTTP ${response.status}).`, response.status);
  }
  if (!response.ok) {
    throw new ApiError(
      typeof payload?.error === "string" ? payload.error : `The request failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  return payload;
}

function expectDocument(payload) {
  if (!payload || typeof payload.path !== "string" || typeof payload.content !== "string"
      || typeof payload.html !== "string" || payload.version === undefined || payload.version === null) {
    throw new ApiError("The service returned an incomplete document.");
  }
  return payload;
}

function connectionFailure(error, force = false) {
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
  if (currentRoot === null) {
    setText(ui.rootPath, "No folder connected — open Notes using the app or CLI launch URL.");
  }
  notice(ui.connectionMessage, message, "error");
  refreshControls();
}

function setRoot(root) {
  const changed = currentRoot !== null && currentRoot !== root;
  if (changed) {
    files = [];
    treeLoaded = false;
    treeTruncated = false;
    collapsedFolders.clear();
    renderFiles();
    invalidatePreview();
  }
  currentRoot = root;
  setText(ui.rootPath, root || "No folder selected — choose one in Settings or use the CLI --serve option.");
  ui.rootPath.title = root;
  const displayRoot = root.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  setText(ui.libraryName, displayRoot.split(/[\\/]/).at(-1) || "Notes folder");
  ui.libraryName.title = displayRoot;
  refreshControls();
  if (changed && activeDocument) {
    if (rootChanged()) previewStatus("Preview paused: the notes folder changed.", true);
    else schedulePreview(0);
  }
}

function refreshControls() {
  const changed = dirty();
  const ready = connectionState === "ready";
  const writing = Boolean(pendingSave || creating);
  editorBytes = activeDocument ? markdownByteLength(serializeEditorText(activeDocument, ui.editor.value)) : 0;
  const tooLarge = editorBytes > MAX_MARKDOWN_BYTES;
  ui.editor.disabled = !activeDocument;
  ui.save.disabled = !activeDocument || !changed || writing || Boolean(loadingDocument)
    || !ready || conflict || rootChanged() || tooLarge;
  ui.reload.disabled = !activeDocument || writing || !ready;
  ui.copy.disabled = !activeDocument;
  ui.newNote.disabled = !ready || writing;
  ui.emptyNew.disabled = ui.newNote.disabled;
  ui.empty.hidden = Boolean(activeDocument);
  ui.panes.hidden = !activeDocument;
  ui.formatToggle.disabled = !activeDocument || ui.panes.dataset.view !== "rich";
  ui.refreshFiles.disabled = !ready || treeLoading;
  ui.reconnect.disabled = connectionState === "connecting" || writing;
  ui.reconnect.hidden = ready;
  ui.newPath.disabled = creating;
  ui.cancelNew.disabled = creating;
  ui.create.disabled = creating;
  setText(ui.create, creating ? "Creating…" : "Create note");
  setText(ui.saveLabel, pendingSave ? "Saving…" : "Save");
  ui.connectionLabel.dataset.state = connectionState;
  setText(ui.connectionLabel, ready ? "Local service" : connectionState === "connecting" ? "Connecting…" : "Disconnected");
  ui.connectionLabel.title = ready && currentPort ? `Connected on loopback port ${currentPort}` : "";
  setText(ui.title, activeDocument?.path ?? "Select a note");

  let state = "empty";
  let status = "No note open";
  if (activeDocument) {
    state = conflict ? "conflict" : pendingSave ? "saving" : changed ? "dirty" : "saved";
    status = conflict ? "Disk conflict — editor text kept"
      : pendingSave ? (ui.editor.value === pendingSave.snapshot.text ? "Saving a snapshot…" : "Saving — newer edits are unsaved")
      : changed ? "Unsaved changes" : "Saved";
    let lines = 1;
    for (const character of ui.editor.value) if (character === "\n") lines += 1;
    const ending = activeDocument.format.lineEnding === "\r\n" ? "CRLF"
      : activeDocument.format.lineEnding === "\r" ? "CR" : "LF";
    if (wordSource !== ui.editor.value) {
      wordSource = ui.editor.value;
      wordCount = 0;
      for (const word of segmenter.segment(wordSource)) if (word.isWordLike) wordCount += 1;
    }
    setText(ui.stats, `${wordCount.toLocaleString()} ${wordCount === 1 ? "word" : "words"}`);
    ui.stats.title = `${lines.toLocaleString()} lines · ${formatByteCount(editorBytes)} · ${ending}${activeDocument.format.bom ? " · BOM" : ""}`;
  } else {
    setText(ui.stats, "");
  }
  ui.dirty.dataset.state = state;
  setText(ui.dirty, status);
  document.title = `${changed ? "• " : ""}${activeDocument ? `${activeDocument.path} — ` : ""}Notes`;
  ui.editor.setAttribute("aria-invalid", String(tooLarge));
  notice(ui.sizeWarning, tooLarge
    ? `This note is ${formatByteCount(editorBytes)}; the limit is 4 MiB. Reduce the text before saving or previewing. Your text has not been removed.`
    : "", "error");
  notice(ui.rootWarning, rootChanged()
    ? "The notes folder changed. Your open text has been kept, but it belongs to the previous folder. Copy any changes before reloading or choosing a note from the new folder."
    : "", "warning");
  if (outlineSource !== ui.editor.value) {
    outlineSource = ui.editor.value;
    renderOutline(activeDocument ? extractOutline(outlineSource) : []);
  }
}

function renderOutline(items) {
  outlineItems = items;
  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.text || "Untitled heading";
    button.dataset.level = String(item.level);
    button.dataset.heading = String(index);
    row.append(button);
    fragment.append(row);
  });
  ui.outlineList.replaceChildren(fragment);
  ui.outlineEmpty.hidden = items.length > 0;
}

function selectSidebarTab(tab, focus = false) {
  const outline = tab === "outline";
  ui.filesPanel.hidden = outline;
  ui.outlinePanel.hidden = !outline;
  ui.filesTab.setAttribute("aria-selected", String(!outline));
  ui.outlineTab.setAttribute("aria-selected", String(outline));
  ui.filesTab.tabIndex = outline ? -1 : 0;
  ui.outlineTab.tabIndex = outline ? 0 : -1;
  if (focus) (outline ? ui.outlineTab : ui.filesTab).focus();
}

function setSidebar(open) {
  document.body.dataset.sidebar = open ? "open" : "closed";
  ui.sidebarToggle.setAttribute("aria-expanded", String(open));
  ui.sidebar.inert = !open;
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

function renderTreeStatus() {
  const visible = filterNotes(files, ui.filter.value);
  setText(ui.fileCount, treeLoaded
    ? `${ui.filter.value.trim() ? `${visible.length.toLocaleString()} of ` : ""}${files.length.toLocaleString()} ${files.length === 1 ? "note" : "notes"}`
    : "Markdown files");
  let message = treeError;
  if (treeLoading) message = treeLoaded ? "Refreshing the file list…" : "Loading Markdown files…";
  else if (!message && treeLoaded && files.length === 0) {
    message = "No Markdown files in this folder. Create a note, or choose another folder in Settings or the CLI.";
  } else if (!message && treeLoaded && visible.length === 0) {
    message = "No notes match your filter.";
  } else if (!message && !treeLoaded) {
    message = connectionState === "ready" ? "Refresh to list Markdown files." : "Open Notes using the app or CLI launch URL to connect.";
  }
  notice(ui.treeMessage, message, treeError && !treeLoading ? "error" : "");
  notice(ui.treeLimit, treeTruncated
    ? "The service limited this file list. Filtering searches only the notes listed here; other notes may not appear. Choose a smaller notes folder in Settings or the CLI if needed."
    : "", "warning");
  ui.fileNav.setAttribute("aria-busy", String(treeLoading));
}

function renderFiles() {
  const filtering = Boolean(ui.filter.value.trim());
  const tree = buildFileTree(filterNotes(files, ui.filter.value));
  function appendBranch(branch, list) {
    for (const directory of branch.directories) {
      const item = document.createElement("li");
      const details = document.createElement("details");
      details.className = "directory";
      details.dataset.path = directory.path;
      details.open = filtering || !collapsedFolders.has(directory.path);
      const summary = document.createElement("summary");
      summary.textContent = directory.name;
      summary.title = directory.path;
      const children = document.createElement("ul");
      children.className = "file-branch";
      appendBranch(directory, children);
      details.append(summary, children);
      details.addEventListener("toggle", () => {
        if (ui.filter.value.trim() || !details.isConnected) return;
        if (details.open) collapsedFolders.delete(directory.path);
        else collapsedFolders.add(directory.path);
      });
      item.append(details);
      list.append(item);
    }
    for (const file of branch.files) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "file-button";
      button.dataset.path = file.path;
      button.title = file.path;
      button.setAttribute("aria-label", file.path);
      if (activeDocument?.path === file.path && !rootChanged()) button.setAttribute("aria-current", "page");
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = file.name;
      button.append(name);
      item.append(button);
      list.append(item);
    }
  }
  const fragment = document.createDocumentFragment();
  appendBranch(tree, fragment);
  ui.fileList.replaceChildren(fragment);
  renderTreeStatus();
}

function updateFileSelection() {
  for (const button of ui.fileList.querySelectorAll("button[data-path]")) {
    if (button.dataset.path === activeDocument?.path && !rootChanged()) {
      button.setAttribute("aria-current", "page");
      let parent = button.parentElement;
      while (parent && parent !== ui.fileList) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
    } else {
      button.removeAttribute("aria-current");
    }
  }
}

async function refreshFiles() {
  if (connectionState !== "ready") return;
  treeController?.abort();
  const controller = new AbortController();
  treeController = controller;
  const ticket = treeGate.next();
  treeLoading = true;
  refreshControls();
  renderTreeStatus();
  try {
    const result = await api("/api/tree", { signal: controller.signal });
    if (!treeGate.isCurrent(ticket)) return;
    if (!result || typeof result.root !== "string" || !Array.isArray(result.files)
        || result.files.some((file) => typeof file?.path !== "string" || typeof file?.name !== "string")) {
      throw new ApiError("The service returned an incomplete file list.");
    }
    setRoot(result.root);
    files = result.files.map((file) => ({ path: normalizeNotePath(file.path), name: file.name }));
    treeLoaded = true;
    treeError = "";
    treeTruncated = Boolean(result.truncated);
    renderFiles();
    updateFileSelection();
  } catch (error) {
    if (!treeGate.isCurrent(ticket) || aborted(error)) return;
    treeError = `Could not refresh files: ${error.message}${treeLoaded ? " The previous list is still shown." : ""}`;
    connectionFailure(error);
  } finally {
    if (treeGate.isCurrent(ticket)) {
      treeLoading = false;
      treeController = null;
      renderTreeStatus();
      refreshControls();
    }
  }
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
    && (url.pathname === "/" || url.pathname === "/index.html")
    && url.searchParams.has("file");
}

function renderPreview(html, resetScroll = false) {
  const scrollTop = resetScroll ? 0 : ui.preview.scrollTop;
  // This is the only HTML sink: the authenticated Rust renderer escapes and sanitizes Markdown.
  ui.preview.innerHTML = html;
  if (!html.trim()) emptyPreview("A fresh page", "Start typing Markdown in the editor. Your preview will appear here.");
  for (const link of ui.preview.querySelectorAll("a[href]")) {
    try {
      const url = new URL(link.getAttribute("href"), window.location.href);
      if (url.origin !== window.location.origin) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      } else if (internalNoteUrl(url) || link.getAttribute("href").startsWith("#")) {
        link.removeAttribute("target");
      }
    } catch {
      // Invalid destinations remain inert to in-app routing.
    }
  }
  ui.preview.scrollTop = scrollTop;
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
  const target = [...ui.preview.querySelectorAll("[id]")].find((node) => node.id === id);
  if (!target) return;
  const top = target.getBoundingClientRect().top - ui.preview.getBoundingClientRect().top + ui.preview.scrollTop - 14;
  ui.preview.scrollTo({
    top: Math.max(0, top),
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

function useDocument(payload, root, url, mode, message = "") {
  invalidatePreview();
  pendingHeading = null;
  documentId += 1;
  editorRevision += 1;
  activeDocument = { ...createDocumentModel(payload), root };
  ui.editor.value = activeDocument.text;
  ui.editor.scrollTop = 0;
  commitUrl(makeNoteUrl(url, payload.path, url.hash), mode);
  notice(element("rich-warning"), "");
  loadInlineEditor();
  conflict = false;
  notice(ui.conflictMessage, "");
  documentNotice(message, message ? "success" : "");
  renderPreview(payload.html, true);
  previewStatus("Up to date");
  refreshControls();
  updateFileSelection();
  if (compactLayout.matches) setSidebar(false);
  const id = documentId;
  window.requestAnimationFrame(() => {
    if (id === documentId) scrollToHeading(url.hash);
  });
}

function clearDocument(url, mode) {
  invalidatePreview();
  pendingHeading = null;
  documentId += 1;
  editorRevision += 1;
  activeDocument = null;
  ui.editor.value = "";
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
  const targetUrl = url ?? makeNoteUrl(committedUrl, path, hash);
  cancelDocumentLoad(mode !== "pop");
  if (!reload && path === activeDocument?.path && !rootChanged()) {
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
    clearDocument(targetUrl, mode);
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
    const payload = expectDocument(await api(`/api/document?path=${encodeURIComponent(path)}`, { signal: controller.signal }));
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
    }
  }
}

function schedulePreview(delay = 300) {
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
    const body = { path: activeDocument.path, content: serializeEditorText(activeDocument, ui.editor.value) };
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

async function saveDocument() {
  if (!activeDocument || pendingSave || creating) return;
  if (loadingDocument) {
    documentNotice("A note is still opening. Keep typing to cancel that request before saving.");
    return;
  }
  if (conflict) {
    documentNotice("Resolve the disk conflict first. Copy your changes before choosing Reload from disk.", "warning");
    return;
  }
  if (rootChanged() || connectionState !== "ready") {
    documentNotice("Saving is unavailable until this tab is connected to the same notes folder. Your editor text has been kept.", "error");
    return;
  }
  if (!dirty()) {
    documentNotice("There are no unsaved changes.");
    return;
  }
  const snapshot = createSaveSnapshot(activeDocument, ui.editor.value);
  if (markdownByteLength(snapshot.content) > MAX_MARKDOWN_BYTES) {
    refreshControls();
    documentNotice("The note exceeds the 4 MiB limit and has not been saved.", "error");
    return;
  }
  const operation = { snapshot, id: documentId, root: activeDocument.root };
  pendingSave = operation;
  documentNotice("Saving this version to disk…");
  refreshControls();
  try {
    const payload = expectDocument(await api("/api/document", {
      method: "PUT",
      body: { path: snapshot.path, content: snapshot.content, version: snapshot.version },
    }));
    if (operation.id !== documentId) return;
    const result = reconcileSave(snapshot, payload, ui.editor.value);
    activeDocument = { ...result.document, root: operation.root };
    if (ui.editor.value !== result.text) {
      ui.editor.value = result.text;
      editorRevision += 1;
      loadInlineEditor();
    }
    documentNotice(result.dirty
      ? "The captured version was saved. Your newer typing is still unsaved."
      : "Saved to disk.", "success");
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
  }
}

function openNewNote() {
  if (connectionState !== "ready" || pendingSave || creating) return;
  cancelDocumentLoad();
  if (!confirmDiscard("create a new note")) return;
  newNoteOrigin = { id: documentId, revision: editorRevision, root: currentRoot };
  const parent = activeDocument && !rootChanged() && activeDocument.path.includes("/")
    ? activeDocument.path.slice(0, activeDocument.path.lastIndexOf("/") + 1) : "";
  ui.newPath.value = `${parent}Untitled.md`;
  ui.newPath.setAttribute("aria-invalid", "false");
  notice(ui.newError, "");
  ui.newDialog.showModal();
  ui.newPath.focus();
  ui.newPath.setSelectionRange(parent.length, ui.newPath.value.length - 3);
}

async function createNote(event) {
  event.preventDefault();
  if (creating) return;
  let path;
  try {
    path = validateNewNotePath(ui.newPath.value);
  } catch (error) {
    notice(ui.newError, error.message, "error");
    ui.newPath.setAttribute("aria-invalid", "true");
    ui.newPath.focus();
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
    const payload = expectDocument(await api("/api/document", { method: "POST", body: { path, content: "" } }));
    ui.newDialog.close();
    if (origin.id === documentId && origin.revision === editorRevision && origin.root === currentRoot) {
      useDocument(payload, origin.root, makeNoteUrl(committedUrl, payload.path), "push", "Created a new note.");
      if (ui.panes.dataset.view === "preview") setView("rich");
      if (ui.panes.dataset.view === "rich") inlineEditor.focus();
      else ui.editor.focus();
    } else {
      documentNotice(`Created “${payload.path}”. Your current editor text was kept because the open note or folder changed.`, "success");
    }
    void refreshFiles();
  } catch (error) {
    const prefix = error.status === 409 ? "A file already exists at this path. Choose a different name. " : "";
    notice(ui.newError, `${prefix}${error.message} No existing note was replaced.`, "error");
    ui.newPath.setAttribute("aria-invalid", "true");
    connectionFailure(error);
  } finally {
    creating = false;
    refreshControls();
  }
}

function setView(view, focus = false) {
  const previousView = ui.panes.dataset.view;
  ui.panes.dataset.view = view;
  if (view !== "rich") {
    ui.formatPanel.hidden = true;
    ui.formatToggle.setAttribute("aria-expanded", "false");
  }
  if (view !== previousView) {
    if (view === "rich") notice(element("rich-warning"), "");
    focusAfterLoad = view === "rich" && focus;
    loadInlineEditor();
  }
  for (const button of document.querySelectorAll(".view-switcher button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  setText(element("view-label"), { rich: "Live", editor: "Source", split: "Split", preview: "Read" }[view]);
  refreshControls();
  if (["split", "preview"].includes(view)) schedulePreview(0);
  else invalidatePreview();
  if (focus) {
    if (view === "preview") ui.preview.focus();
    else if (view === "rich") inlineEditor.focus();
    else if (activeDocument) ui.editor.focus();
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

async function connect() {
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
    const session = await api("/api/session", { method: "POST", signal: controller.signal });
    if (!connectionGate.isCurrent(ticket)) return;
    if (!session || typeof session.root !== "string" || !Number.isInteger(session.port)) {
      throw new ApiError("The service returned incomplete session settings.");
    }
    currentPort = session.port;
    connectionState = "ready";
    setRoot(session.root);
    notice(ui.connectionMessage, storageUnavailable
      ? "This browser could not store the connection token for this tab. Copy unsaved work before refreshing; you may need to reopen Notes using the app or CLI launch URL."
      : "", storageUnavailable ? "warning" : "");
    refreshControls();
    void refreshAppearance(true);
    void refreshFiles();
    if (activeDocument) {
      schedulePreview(0);
    } else {
      const route = readNoteRoute(window.location.href);
      if (route.path) void navigateTo(route.path, route.hash, { mode: "replace", url: new URL(window.location.href) });
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

ui.reconnect.addEventListener("click", () => void connect());
ui.sidebarToggle.addEventListener("click", () => setSidebar(document.body.dataset.sidebar !== "open"));
ui.scrim.addEventListener("click", () => setSidebar(false));
ui.filesTab.addEventListener("click", () => selectSidebarTab("files"));
ui.outlineTab.addEventListener("click", () => selectSidebarTab("outline"));
for (const tab of [ui.filesTab, ui.outlineTab]) {
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectSidebarTab(event.key === "Home" ? "files" : event.key === "End" ? "outline"
      : ui.outlinePanel.hidden ? "outline" : "files", true);
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
      * Number.parseFloat(getComputedStyle(ui.editor).lineHeight);
  }
  if (compactLayout.matches) setSidebar(false);
});
ui.formatToggle.addEventListener("click", () => {
  const open = ui.formatPanel.hidden;
  ui.formatPanel.hidden = !open;
  ui.formatToggle.setAttribute("aria-expanded", String(open));
});
ui.focusMode.addEventListener("click", toggleFocusMode);
ui.emptyNew.addEventListener("click", openNewNote);
compactLayout.addEventListener("change", () => setSidebar(!compactLayout.matches));
document.addEventListener("pointerdown", (event) => {
  for (const popup of document.querySelectorAll(".popup[open]")) {
    if (!popup.contains(event.target)) popup.open = false;
  }
});
document.addEventListener("click", (event) => {
  if (event.target.closest(".popup-panel button, .popup-panel a")) closeMenus();
});
ui.refreshFiles.addEventListener("click", () => void refreshFiles());
ui.filter.addEventListener("input", renderFiles);
ui.fileList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-path]");
  if (button) void navigateTo(button.dataset.path);
});
ui.save.addEventListener("click", () => void saveDocument());
ui.reload.addEventListener("click", () => {
  if (activeDocument) void navigateTo(activeDocument.path, readNoteRoute(committedUrl).hash, { mode: "replace", reload: true });
});
ui.copy.addEventListener("click", () => void copyText());
ui.newNote.addEventListener("click", openNewNote);
ui.newForm.addEventListener("submit", (event) => void createNote(event));
ui.cancelNew.addEventListener("click", () => {
  if (!creating) ui.newDialog.close();
});
ui.newDialog.addEventListener("cancel", (event) => {
  if (creating) event.preventDefault();
});
ui.newPath.addEventListener("input", () => ui.newPath.setAttribute("aria-invalid", "false"));
for (const button of document.querySelectorAll(".view-switcher button")) {
  button.addEventListener("click", () => setView(button.dataset.view, true));
}
document.querySelector(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  if (ui.panes.dataset.view === "rich") inlineEditor.focus();
  else if (ui.panes.dataset.view === "preview") ui.preview.focus();
  else ui.editor.focus();
});
ui.editor.addEventListener("input", () => {
  if (!activeDocument) return;
  editorRevision += 1;
  if (cancelDocumentLoad()) documentNotice("Opening a note was canceled because you continued editing.");
  else if (documentMessageKind === "success") documentNotice("");
  refreshControls();
  schedulePreview();
});

ui.preview.addEventListener("click", (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest("a[href]");
  if (!link || !activeDocument) return;
  const href = link.getAttribute("href");
  if (href.startsWith("#")) {
    event.preventDefault();
    commitUrl(makeNoteUrl(committedUrl, activeDocument.path, href));
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
    void navigateTo(route.path, route.hash, { url });
  }
});

window.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    closeMenus();
    ui.formatPanel.hidden = true;
    ui.formatToggle.setAttribute("aria-expanded", "false");
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
window.addEventListener("focus", () => void refreshAppearance(true));
window.addEventListener("blur", stopAppearancePolling);
window.addEventListener("pagehide", stopAppearancePolling);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") stopAppearancePolling();
  else void refreshAppearance(true);
});
window.addEventListener("beforeunload", (event) => {
  if (!dirty() && !pendingSave && !creating) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("popstate", () => {
  const url = new URL(window.location.href);
  const route = readNoteRoute(url);
  void navigateTo(route.path, route.hash, { mode: "pop", url });
});
window.addEventListener("hashchange", () => {
  if (loadingDocument) return;
  const route = readNoteRoute(window.location.href);
  if (route.path === (activeDocument?.path ?? null)) {
    committedUrl = window.location.href;
    if (route.hash !== "#editor") scrollToHeading(route.hash);
  }
});

setSidebar(!compactLayout.matches);
void connect();
