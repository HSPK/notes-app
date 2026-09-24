// Generated from frontend/app/*.mjs by npm run build.
import {
  MAX_MARKDOWN_BYTES,
  RequestGate,
  buildFileTree,
  browserDocumentTitle,
  createHiddenPathMatcher,
  createDocumentModel,
  createSaveSnapshot,
  createWordCounter,
  entryDestination,
  filterNotes,
  formatByteCount,
  isDirty,
  isResourceId,
  makeNoteUrl,
  markdownByteLength,
  normalizeNotePath,
  parseHiddenPatterns,
  readLaunchUrl,
  readNoteRoute,
  reconcileSave,
  sameTreeEntries,
  sameTreeStructure,
  serializeEditorText,
  validateNewDirectoryPath,
  validateNewNotePath,
} from "./model.mjs";
import {
  createInlineEditor, createOutlineExtractor, createSourceEditor, createSharedText, attachScrollbars, applyAppearance,
} from "./editor.bundle.mjs";

const element = (id) => document.getElementById(id);
const ui = {
  appShell: element("app-shell"),
  authScreen: element("auth-screen"),
  authForm: element("auth-form"),
  authTitle: element("auth-title"),
  authDescription: element("auth-description"),
  authUsername: element("auth-username"),
  authPassword: element("auth-password"),
  authConfirmField: element("auth-confirm-field"),
  authConfirm: element("auth-confirm"),
  authHint: element("auth-hint"),
  authError: element("auth-error"),
  authSubmit: element("auth-submit"),
  commandOpen: element("command-palette-open"),
  commandDialog: element("command-dialog"),
  commandForm: element("command-form"),
  commandQuery: element("command-query"),
  commandList: element("command-list"),
  commandEmpty: element("command-empty"),
  commandClose: element("command-close"),
  settingsOpen: element("settings-open"),
  settingsDialog: element("settings-dialog"),
  settingsForm: element("settings-form"),
  settingsClose: element("settings-close"),
  settingsCancel: element("settings-cancel"),
  settingsSearch: element("settings-search"),
  settingsHiddenPatterns: element("hidden-patterns"),
  settingsPageWidth: element("settings-page-width"),
  settingsSidebarWidth: element("settings-sidebar-width"),
  settingsSidebarValue: element("settings-sidebar-value"),
  settingsCommandShortcut: element("settings-command-shortcut"),
  settingsError: element("settings-error"),
  logout: element("logout"),
  connectionLabel: element("connection-label"),
  connectionMessage: element("connection-message"),
  appearanceMessage: element("appearance-message"),
  reconnect: element("reconnect"),
  newNote: element("new-note"),
  newFolder: element("new-folder"),
  refreshFiles: element("refresh-files"),
  filter: element("file-filter"),
  treeMessage: element("tree-message"),
  treeLimit: element("tree-limit"),
  fileNav: element("file-nav"),
  fileList: element("file-list"),
  title: element("document-name"),
  modified: element("document-modified"),
  viewLabel: element("view-label"),
  dirty: element("dirty-indicator"),
  reload: element("reload-document"),
  copy: element("copy-text"),
  copyStatus: element("copy-status"),
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
  newTitle: element("new-note-title"),
  newNoteHint: element("new-note-hint"),
  newError: element("new-note-error"),
  cancelNew: element("cancel-new-note"),
  create: element("create-note"),
  newFolderDialog: element("new-folder-dialog"),
  newFolderForm: element("new-folder-form"),
  newFolderPath: element("new-folder-path"),
  newFolderError: element("new-folder-error"),
  cancelNewFolder: element("cancel-new-folder"),
  createFolder: element("create-folder"),
  fileContextMenu: element("file-context-menu"),
  fileDetails: element("file-details"),
  fileRename: element("file-rename"),
  renameDialog: element("rename-dialog"),
  renameForm: element("rename-form"),
  renamePath: element("rename-path"),
  renameError: element("rename-error"),
  cancelRename: element("cancel-rename"),
  confirmRename: element("confirm-rename"),
  detailsDialog: element("details-dialog"),
  detailsName: element("details-name"),
  detailsMetadataTitle: element("details-metadata-title"),
  detailsPath: element("details-path"),
  detailsSize: element("details-size"),
  detailsModified: element("details-modified"),
  closeDetails: element("close-details"),
  empty: element("empty-document"),
  emptyNew: element("empty-new-note"),
  libraryHeading: document.querySelector(".library-heading"),
  sidebar: element("sidebar"),
  sidebarResizer: element("sidebar-resizer"),
  sidebarToggle: element("sidebar-toggle"),
  scrim: element("sidebar-scrim"),
  filesTab: element("files-tab"),
  outlineTab: element("outline-tab"),
  filesPanel: element("files-panel"),
  outlinePanel: element("outline-panel"),
  outlineList: element("outline-list"),
  outlineEmpty: element("outline-empty"),
  focusMode: element("focus-mode"),
};

attachScrollbars(element("files-scroll-frame"), ui.fileNav, { horizontal: false });
attachScrollbars(element("outline-scroll-frame"), element("outline-scroll"), { horizontal: false });
attachScrollbars(ui.editor.parentElement, ui.editor);
attachScrollbars(ui.preview.parentElement, ui.preview);
ui.editor = createSourceEditor({
  textarea: ui.editor,
  nonce: document.querySelector('meta[name="notes-style-nonce"]').content,
});

const compactLayout = window.matchMedia("(max-width: 650px)");
const SIDEBAR_WIDTH_KEY = "notes.layout.sidebarWidth";
const PAGE_WIDTH_KEY = "notes.layout.pageWidth";
const COMMAND_SHORTCUT_KEY = "notes.shortcuts.commandPanel";
const HIDDEN_PATTERNS_KEY = "notes.library.hiddenPatterns";
const SIDEBAR_MIN = 210;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 260;
const pageWidths = new Set(["focused", "balanced", "wide"]);
let outlineItems = [];
let commandIndex = 0;
let visibleCommands = [];
let outlineSource = null;
let outlineButtons = [];
let focusAfterLoad = false;
let pendingHeading = null;
let sidebarBeforeFocus = true;
let wordSource = null;
let wordCount = 0;
const wordCounter = createWordCounter();
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
let authMode = null;
let authUser = null;
let authSetup = false;
let authenticating = false;
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
let newItemParent = "";
let contextFile = null;
let movingEntry = false;
let draggedEntry = null;
let dropTarget = null;
let editorBytes = 0;
let editorAnalysisDocument = null;
let editorAnalysisRevision = -1;
let editorAnalysis = { changed: false, bytes: 0, lines: 1 };
let files = [];
let directories = [];
let treeLoaded = false;
let treeLoading = false;
let treeError = "";
let treeTruncated = false;
let previewTimer = null;
let previewController = null;
let renderedPreviewDocument = -1;
let renderedPreviewRevision = -1;
let connectionController = null;
let treeController = null;
let copyTimer = null;
let deferredControlTimer = null;
let outlineTimer = null;
let outlineChanges = null;
let appearanceController = null;
let appearanceTimer = null;
let appearanceGeneration = 0;
const collapsedFolders = new Set();
const connectionGate = new RequestGate();
const treeGate = new RequestGate();
const documentGate = new RequestGate();
const previewGate = new RequestGate();
let inlineEditorPath = null;
const outlineExtractor = createOutlineExtractor();
const inlineEditor = createInlineEditor({
  root: element("rich-editor"),
  outlineExtractor,
  styleNonce: document.querySelector('meta[name="notes-style-nonce"]').content,
  transformUrl: (url, path) => projectUrl(url, path),
  onTag: (tag) => openWorkspaceSearch({ tags: [tag] }),
  onNotice: (message) => notice(element("metadata-message"), message, "warning"),
  wikiDocuments: () => publicView ? [] : visibleLibraryFiles(),
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
  onTitle(title) {
    if (!activeDocument || ui.panes.dataset.view !== "rich") return;
    activeDocument.title = title;
    refreshDocumentTitle();
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
      commitUrl(makeNoteUrl(committedUrl, activeDocument.id, href));
      scrollToHeading(href);
      return;
    }
    const url = new URL(href, window.location.href);
    if (internalNoteUrl(url)) {
      const route = readNoteRoute(url);
      void navigateTo(route.id ?? (publicView ? activeDocument.id : null), route.hash, { url });
    } else {
      window.open(url.href, "_blank", "noopener,noreferrer");
    }
  },
});

function loadInlineEditor() {
  if (!activeDocument) {
    inlineEditorPath = null;
    inlineEditor.clear();
    return;
  }
  if (ui.panes.dataset.view !== "rich") return;
  if (inlineEditorPath === activeDocument.path && inlineEditor.getSource() === ui.editor.value) return;
  inlineEditorPath = activeDocument.path;
  void inlineEditor.load(ui.editor.value, activeDocument.path);
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
  if (publicView) return;
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
    sharedAppearance = settings;
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
  notice(ui.previewStatus, text, error ? "error" : "");
  ui.previewStatus.hidden = !error;
}

function readLayoutPreference(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    console.warn(`Could not read ${key}.`, error);
    return null;
  }
}

function storeLayoutPreference(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch (error) {
    console.warn(`Could not save ${key}.`, error);
  }
}

let preferredSidebarWidth = Number.parseInt(readLayoutPreference(SIDEBAR_WIDTH_KEY) ?? "", 10);
if (!Number.isFinite(preferredSidebarWidth)) preferredSidebarWidth = SIDEBAR_DEFAULT;
let commandShortcut = readLayoutPreference(COMMAND_SHORTCUT_KEY);
if (!["primary-k", "primary-shift-p"].includes(commandShortcut)) commandShortcut = "primary-k";

function visibleSidebarWidth(width) {
  const viewportMaximum = Math.max(SIDEBAR_MIN, window.innerWidth - 320);
  return Math.round(Math.min(SIDEBAR_MAX, viewportMaximum, Math.max(SIDEBAR_MIN, width)));
}

function setSidebarWidth(width, persist = false) {
  preferredSidebarWidth = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
  const visible = visibleSidebarWidth(preferredSidebarWidth);
  document.documentElement.style.setProperty("--sidebar-width", `${visible}px`);
  ui.sidebarResizer.setAttribute("aria-valuenow", String(visible));
  if (persist) storeLayoutPreference(SIDEBAR_WIDTH_KEY, preferredSidebarWidth);
}

function setPageWidth(value, persist = false) {
  const width = pageWidths.has(value) ? value : "balanced";
  document.documentElement.dataset.pageWidth = width;
  for (const button of document.querySelectorAll("[data-page-width]")) {
    button.setAttribute("aria-pressed", String(button.dataset.pageWidth === width));
  }
  if (persist) storeLayoutPreference(PAGE_WIDTH_KEY, width);
}

setSidebarWidth(preferredSidebarWidth);
setPageWidth(readLayoutPreference(PAGE_WIDTH_KEY));

const primaryKey = navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";
const commandItems = [
  { name: "New note", action: openNewNote, enabled: () => connectionState === "ready" && !pendingSave && !creating },
  { name: "Save note", key: `${primaryKey}+S`, action: () => void saveDocument(), enabled: () => Boolean(activeDocument && dirty() && !pendingSave && !creating) },
  { name: "View: Live", action: () => setView("rich", true), enabled: () => Boolean(activeDocument) },
  { name: "View: Source", action: () => setView("editor", true), enabled: () => Boolean(activeDocument) },
  { name: "View: Compare", action: () => setView("split", true), enabled: () => Boolean(activeDocument) },
  { name: "View: Read", action: () => setView("preview", true), enabled: () => Boolean(activeDocument) },
  { name: "Page width: Focused", action: () => setPageWidth("focused", true) },
  { name: "Page width: Balanced", action: () => setPageWidth("balanced", true) },
  { name: "Page width: Wide", action: () => setPageWidth("wide", true) },
  { name: "Toggle sidebar", key: `${primaryKey}+Shift+L`, action: () => setSidebar(document.body.dataset.sidebar !== "open") },
  { name: "Distraction free", action: toggleFocusMode },
  { name: "Open settings", action: () => openSettings() },
  { name: "Refresh files", action: () => void refreshFiles(), enabled: () => connectionState === "ready" && !treeLoading },
];

function selectCommand(index) {
  if (!visibleCommands.length) return;
  commandIndex = (index + visibleCommands.length) % visibleCommands.length;
  for (const [buttonIndex, button] of [...ui.commandList.children].entries()) {
    button.setAttribute("aria-selected", String(buttonIndex === commandIndex));
  }
  ui.commandList.children[commandIndex]?.scrollIntoView({ block: "nearest" });
}

function renderCommandPanel() {
  const query = ui.commandQuery.value.trim().toLowerCase();
  visibleCommands = commandItems.filter((command) =>
    command.enabled?.() !== false && (!publicView || !["New note", "Open settings", "Refresh files", "Toggle sidebar"].includes(command.name))
      && (!query || command.name.toLowerCase().includes(query)));
  commandIndex = Math.min(commandIndex, Math.max(0, visibleCommands.length - 1));
  ui.commandList.replaceChildren(...visibleCommands.map((command, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === commandIndex));
    const name = document.createElement("span");
    name.className = "command-name";
    name.textContent = command.name;
    button.append(name);
    if (command.key) {
      const key = document.createElement("span");
      key.className = "command-key";
      key.textContent = command.key;
      button.append(key);
    }
    button.addEventListener("pointermove", () => selectCommand(index));
    button.addEventListener("click", () => runCommand(index));
    return button;
  }));
  ui.commandEmpty.hidden = visibleCommands.length > 0;
}

function openCommandPanel() {
  if (ui.commandDialog.open || !ui.authScreen.hidden) return;
  closeMenus();
  ui.commandQuery.value = "";
  commandIndex = 0;
  renderCommandPanel();
  ui.commandDialog.showModal();
  ui.commandQuery.focus();
}

function closeCommandPanel() {
  if (ui.commandDialog.open) ui.commandDialog.close();
}

function runCommand(index = commandIndex) {
  const command = visibleCommands[index];
  if (!command) return;
  closeCommandPanel();
  command.action();
}

function opensCommandPanel(event) {
  if (!(event.ctrlKey || event.metaKey)) return false;
  return commandShortcut === "primary-shift-p"
    ? event.shiftKey && event.key.toLowerCase() === "p"
    : !event.shiftKey && event.key.toLowerCase() === "k";
}

function rootChanged() {
  return Boolean(activeDocument && activeDocument.root !== currentRoot);
}

function currentEditorAnalysis() {
  if (editorAnalysisDocument === activeDocument && editorAnalysisRevision === editorRevision) {
    return editorAnalysis;
  }
  if (!activeDocument) {
    editorAnalysis = { changed: false, bytes: 0, lines: 1 };
  } else {
    const text = ui.editor.value;
    let lines = 1;
    for (const character of text) if (character === "\n") lines += 1;
    editorAnalysis = {
      changed: isDirty(activeDocument, text),
      bytes: markdownByteLength(serializeEditorText(activeDocument, text)),
      lines,
    };
  }
  editorAnalysisDocument = activeDocument;
  editorAnalysisRevision = editorRevision;
  return editorAnalysis;
}

function dirty() {
  return currentEditorAnalysis().changed;
}

function aborted(error) {
  return error?.name === "AbortError";
}

const statusNotices = document.createElement("div");
statusNotices.className = "status-notices";
statusNotices.id = "status-notices";
const statusDetails = document.createElement("button");
statusDetails.id = "status-details";
statusDetails.type = "button";
statusDetails.textContent = "…";
statusDetails.title = "Show full status messages";
statusDetails.setAttribute("aria-label", "Show full status messages");
statusDetails.hidden = true;
const statusPanel = document.createElement("div");
const statusOrigins = new Map();
let automaticStatusPanel = false;
statusPanel.className = "status-panel";
statusPanel.setAttribute("popover", "auto");
statusPanel.setAttribute("aria-label", "Status messages");
document.body.append(statusPanel);
ui.dirty.after(statusNotices, statusDetails);
for (const node of new Set([
  ...document.querySelectorAll(".document-alerts > *"),
  ...document.querySelectorAll("dialog .notice"), ui.authError,
  ...document.querySelectorAll("[data-status-source]"),
  ui.documentMessage, ui.treeMessage, ui.treeLimit, element("git-message"), ui.previewStatus,
])) {
  node.classList.remove("visually-hidden");
  statusOrigins.set(node, node.closest("dialog, #auth-screen"));
  statusNotices.append(node);
}
document.querySelector(".document-alerts").remove();
element("git-message").textContent = "";
element("git-message").hidden = true;
function updateStatusDetails() {
  const messages = [...statusNotices.children].filter((node) => !node.hidden && node.textContent);
  statusDetails.hidden = messages.length === 0;
  for (const node of messages) node.title = node.textContent;
  const formErrors = messages.filter((node) => {
    const origin = statusOrigins.get(node);
    return node.classList.contains("is-error") && (origin?.open || origin === ui.authScreen && !origin.hidden);
  });
  if (formErrors.length) {
    automaticStatusPanel = true;
    statusPanel.setAttribute("role", "alert");
    renderStatusDetails(formErrors);
    if (!statusPanel.matches(":popover-open")) statusPanel.showPopover();
  } else if (automaticStatusPanel) {
    automaticStatusPanel = false;
    statusPanel.removeAttribute("role");
    if (statusPanel.matches(":popover-open")) statusPanel.hidePopover();
  } else if (statusPanel.matches(":popover-open")) renderStatusDetails(messages);
}
function renderStatusDetails(messages) {
  statusPanel.replaceChildren(...messages.map((node) => {
    const item = document.createElement("p");
    item.className = node.classList.contains("is-error") ? "is-error" : node.classList.contains("is-warning") ? "is-warning" : "";
    item.textContent = node.textContent;
    return item;
  }));
}
new MutationObserver(updateStatusDetails).observe(statusNotices, {
  childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class"],
});
statusDetails.addEventListener("click", () => {
  automaticStatusPanel = false;
  renderStatusDetails([...statusNotices.children].filter((node) => !node.hidden && node.textContent));
  statusPanel.togglePopover();
});
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("close", () => {
    for (const [node, origin] of statusOrigins) if (origin === dialog) notice(node, "");
  });
}

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

const draftEncoder = new TextEncoder();
const draftDecoder = new TextDecoder();
let draftDatabase = null;
let draftKeys = null;
let draftKeySignature = null;
let draftTimer = null;
let draftQueue = Promise.resolve();
let draftTouched = -1;
let draftRecovery = null;
function draftNonce() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
let draftTab = draftNonce();
try {
  draftTab = sessionStorage.getItem("notes.draft.tab") ?? draftTab;
  sessionStorage.setItem("notes.draft.tab", draftTab);
} catch (error) { console.warn("Draft tab identity cannot be retained.", error); }

function localRecoveryAvailable() {
  return Boolean(crypto.subtle);
}

function openDraftDatabase() {
  draftDatabase ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("notes-private-drafts", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("drafts", { keyPath: "key" });
      store.createIndex("document", "document");
      store.createIndex("owner", "owner");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { draftDatabase = null; reject(request.error); };
    request.onblocked = () => documentNotice("Local recovery storage is blocked by another tab. Close old Notes tabs to finish upgrading.", "warning");
  });
  return draftDatabase;
}

async function draftIdentity() {
  if (!crypto.subtle) throw new Error("Encrypted local recovery requires HTTPS or localhost.");
  const secret = authMode === "users" ? authUser?.draftKey : publicView ? publicToken : token;
  const scope = authMode === "users" ? `${authUser?.scope}:${authUser?.id}` : publicView ? "public-link" : currentRoot;
  if (!/^[a-f0-9]{64}$/i.test(secret ?? "") || !scope) throw new Error("The private recovery key is unavailable. Reconnect before closing unsaved work.");
  const signature = `${scope}:${secret}`;
  if (draftKeySignature === signature) return draftKeys;
  draftKeySignature = signature;
  draftKeys = (async () => {
    const raw = Uint8Array.from(secret.match(/../g), (byte) => parseInt(byte, 16));
    const master = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
    const derive = (purpose, algorithm, usages) => crypto.subtle.deriveKey({
      name: "HKDF", hash: "SHA-256", salt: draftEncoder.encode(scope), info: draftEncoder.encode(purpose),
    }, master, algorithm, false, usages);
    const encryption = await derive("notes-draft-content", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
    const naming = await derive("notes-draft-identifiers", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]);
    const identify = async (text) => [...new Uint8Array(await crypto.subtle.sign("HMAC", naming, draftEncoder.encode(text)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { encryption, identify, owner: await identify("owner") };
  })();
  return draftKeys;
}

async function draftTransaction(mode, operation) {
  const database = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("drafts", mode);
    let result;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Local recovery storage was interrupted."));
    operation(transaction.objectStore("drafts"), (value) => { result = value; });
  });
}

async function encryptDraft(keys, value, associated) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = draftEncoder.encode(JSON.stringify(value));
  const compressed = typeof CompressionStream !== "undefined";
  const input = compressed ? await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer() : bytes;
  const payload = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: draftEncoder.encode(associated) }, keys.encryption, input);
  return { iv, compressed, payload: new Blob([payload]) };
}

async function decryptDraft(keys, record) {
  const plain = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: record.iv, additionalData: draftEncoder.encode(record.key),
  }, keys.encryption, await record.payload.arrayBuffer());
  const bytes = record.compressed
    ? await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer() : plain;
  const value = JSON.parse(draftDecoder.decode(bytes));
  if (typeof value.path !== "string" || typeof value.source !== "string" || typeof value.project !== "string") {
    throw new Error("This local recovery record is invalid.");
  }
  return { ...value, key: record.key, generation: record.generation, updated: record.updated };
}

function encodeDraftUpdates(updates) {
  if (!updates.length) return "";
  const bytes = mergeSharedUpdates(updates);
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(""));
}
function decodeDraftUpdates(value) { return value ? Uint8Array.from(atob(value), (character) => character.charCodeAt(0)) : null; }
function draftProject() { return activeProject?.id ?? (publicView ? "public" : currentRoot); }

function captureDraft() {
  if (!activeDocument) return null;
  const shared = collaboration?.id === documentId ? collaboration : null;
  if (draftTouched !== documentId && !shared?.localModified && !shared?.recoveryRecord) return null;
  return {
    keep: dirty() || Boolean(shared?.localUpdates.size || shared?.pending.size || shared?.unmerged),
    project: draftProject(), document: activeDocument.id, path: activeDocument.path, source: ui.editor.value, version: activeDocument.version,
    room: shared?.room ?? null, updates: encodeDraftUpdates(shared ? [...shared.localUpdates.values()] : []),
    unmerged: Boolean(shared?.unmerged), selection: collaborativeSelection(), tab: draftTab,
  };
}

async function removeDraftRecord(key, generation = null) {
  await draftTransaction("readwrite", (store) => {
    const found = store.get(key);
    found.onsuccess = () => {
      if (found.result && (!generation || found.result.generation === generation)) store.delete(key);
    };
  });
}

function persistCurrentDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  let snapshot;
  try { snapshot = captureDraft(); }
  catch (error) { documentNotice(`Local recovery failed: ${error.message}`, "warning"); return Promise.resolve(); }
  if (!snapshot) return Promise.resolve();
  if (!localRecoveryAvailable()) {
    return snapshot.keep
      ? Promise.reject(new Error("Encrypted local recovery requires HTTPS or localhost. Save or copy unsaved text before leaving this document."))
      : Promise.resolve();
  }
  const identity = draftIdentity().then((keys) => ({ keys }), (error) => ({ error }));
  draftQueue = draftQueue.catch((error) => console.error("An earlier local draft write failed.", error)).then(async () => {
    const result = await identity;
    if (result.error) throw result.error;
    const keys = result.keys;
    const document = await keys.identify(`${snapshot.project}\0${snapshot.document}`);
    const key = await keys.identify(`${snapshot.project}\0${snapshot.document}\0${snapshot.tab}`);
    if (!snapshot.keep) { await removeDraftRecord(key); return; }
    const encrypted = await encryptDraft(keys, snapshot, key);
    await draftTransaction("readwrite", (store) => {
      store.put({ ...encrypted, key, document, owner: keys.owner, updated: Date.now(), generation: draftNonce() });
    });
  });
  return draftQueue.catch((error) => {
    documentNotice(`Local recovery could not be saved: ${error.message} Keep this tab open or copy your text.`, "warning");
    throw error;
  });
}

function queueDraftPersistence(local = false) {
  if (local) draftTouched = documentId;
  if (!localRecoveryAvailable()) return;
  if (draftTimer === null) draftTimer = setTimeout(() => { void persistCurrentDraft().catch(console.error); }, 250);
}

function finishLocalDraft() {
  if (!activeDocument || dirty() || collaboration?.localUpdates.size || collaboration?.pending.size || collaboration?.unmerged) return;
  if (collaboration && !collaboration.initialized) return;
  const record = collaboration?.recoveryRecord;
  const pending = persistCurrentDraft();
  draftTouched = -1;
  if (collaboration) { collaboration.localModified = false; collaboration.recoveryRecord = null; }
  void pending.then(async () => { if (record) await removeDraftRecord(record.key, record.generation); })
    .catch((error) => documentNotice(`Could not clear local recovery: ${error.message}`, "warning"));
}

async function loadDraftForDocument(project, id) {
  await draftQueue.catch((error) => console.error("Local draft storage is unavailable.", error));
  const keys = await draftIdentity();
  const document = await keys.identify(`${project}\0${id}`);
  const records = await draftTransaction("readonly", (store, result) => {
    const request = store.index("document").getAll(document);
    request.onsuccess = () => result(request.result);
  });
  records.sort((left, right) => right.updated - left.updated);
  for (const record of records) {
    if (record.owner !== keys.owner) continue;
    const draft = await decryptDraft(keys, record);
    if (draft.project === project && draft.document === id) return draft;
  }
  return null;
}

async function recoverDocumentDraft() {
  if (!activeDocument) return;
  if (!localRecoveryAvailable()) return;
  const id = documentId;
  try {
    const record = await loadDraftForDocument(draftProject(), activeDocument.id);
    if (!record || id !== documentId) return;
    if (record.source === ui.editor.value && !record.updates) {
      await removeDraftRecord(record.key, record.generation);
      return;
    }
    if (!collaboration && documentParticipation && documentPermissions?.collaborative
        && record.room && !record.unmerged) {
      documentParticipation.recoveryRecord = record;
      collaborationNotice("A local collaborative draft is kept. It will merge when shared editing resumes.");
      return;
    }
    if (collaboration) {
      const current = collaboration;
      if (!current.initialized && record.room && !record.unmerged) {
        const update = decodeDraftUpdates(record.updates);
        if (update) {
          current.shared.apply(update);
          current.localUpdates.set(++current.localSequence, update);
          current.localModified = true;
        }
        current.room = record.room;
        current.recoveryRecord = record;
        return;
      }
    }
    showDraftRecovery(record);
  } catch (error) { documentNotice(`Could not read local recovery: ${error.message}`, "warning"); }
}

function showDraftRecovery(record) {
  draftRecovery = record;
  element("draft-recovery-info").textContent = `${record.path} · ${new Date(record.updated).toLocaleString()}`;
  element("draft-recovery-source").value = record.source.slice(0, 200_000);
  element("draft-recovery-apply").disabled = !activeDocument || activeDocument.id !== record.document || draftProject() !== record.project
    || !(activeProject?.owned || projectWritable());
  notice(element("draft-recovery-error"), record.source.length > 200_000 ? "Preview truncated. Copy draft preserves the complete text." : "");
  if (!element("draft-recovery-dialog").open) element("draft-recovery-dialog").showModal();
}

element("draft-recovery-close").addEventListener("click", () => element("draft-recovery-dialog").close());
element("draft-recovery-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(draftRecovery.source); documentNotice("Recovered draft copied.", "success"); }
  catch (error) { notice(element("draft-recovery-error"), error.message, "error"); }
});
element("draft-recovery-discard").addEventListener("click", async () => {
  if (!window.confirm("Permanently discard this local recovery copy?")) return;
  try { await removeDraftRecord(draftRecovery.key, draftRecovery.generation); element("draft-recovery-dialog").close(); }
  catch (error) { notice(element("draft-recovery-error"), error.message, "error"); }
});
element("draft-recovery-apply").addEventListener("click", async () => {
  const record = draftRecovery;
  if (!activeDocument || record.document !== activeDocument.id || record.project !== draftProject()) return;
  if (!window.confirm("Apply this draft as a new edit? Review it first: it may replace newer text.")) return;
  try {
    if (collaboration?.initialized && !collaboration.closed && projectWritable()) {
      ui.editor.value = record.source;
      ui.editor.dispatchEvent(new Event("input"));
      loadInlineEditor();
      await persistCurrentDraft();
    } else {
      const current = expectDocument(await api(`/api/document?id=${encodeURIComponent(record.document)}`));
      const model = createDocumentModel(current);
      const saved = await api("/api/document", { method: "PUT", body: {
        id: record.document, version: current.version, content: serializeEditorText(model, record.source),
      } });
      useDocument(saved, currentRoot, new URL(committedUrl), "replace", "Recovered the local draft.");
    }
    await removeDraftRecord(record.key, record.generation);
    element("draft-recovery-dialog").close();
  } catch (error) { notice(element("draft-recovery-error"), error.message, "error"); }
});

element("drafts-open").addEventListener("click", async () => {
  closeMenus();
  try {
    const keys = await draftIdentity();
    const records = await draftTransaction("readonly", (store, result) => {
      const request = store.index("owner").getAll(keys.owner);
      request.onsuccess = () => result(request.result);
    });
    records.sort((a, b) => b.updated - a.updated);
    const list = element("drafts-list");
    list.replaceChildren();
    for (const record of records) {
      const draft = await decryptDraft(keys, record);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${draft.path} · ${new Date(draft.updated).toLocaleString()}`;
      button.addEventListener("click", () => { element("drafts-dialog").close(); showDraftRecovery(draft); });
      list.append(button);
    }
    notice(element("drafts-message"), records.length ? "" : "No unsaved local drafts.");
    element("drafts-dialog").showModal();
  } catch (error) { documentNotice(`Local recovery is unavailable: ${error.message}`, "error"); }
});
element("drafts-close").addEventListener("click", () => element("drafts-dialog").close());
window.addEventListener("pagehide", () => { void persistCurrentDraft().catch(console.error); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void persistCurrentDraft().catch(console.error); });

let userWorkspace = { favorites: [], recent: [] };
let workspaceRevision = 0;
let workspaceQueue = Promise.resolve();
let workspaceLoaded = false;
let workspaceControlSignature = null;
const workspaceDialog = element("workspace-dialog");
const sameWorkspaceNote = (note, project, id) => note.project === project && note.id === id;
function activeWorkspaceKey() { return `notes.workspace.active.${authUser?.scope ?? ""}.${authUser?.id ?? ""}`; }

function acceptWorkspace(result) {
  if (!Number.isSafeInteger(result?.revision) || !result.workspace
      || !["favorites", "recent"].every((field) => Array.isArray(result.workspace[field]))) {
    throw new ApiError("The saved workspace response is incomplete.");
  }
  if (result.revision < workspaceRevision) return;
  workspaceRevision = result.revision;
  userWorkspace = result.workspace;
  workspaceLoaded = true;
  refreshWorkspaceFavorite();
  if (workspaceDialog.open) renderWorkspaceList();
}

async function loadUserWorkspace() {
  if (authMode !== "users") return;
  try { acceptWorkspace(await api("/api/workspace")); }
  catch (error) { documentNotice(`Could not load your workspace: ${error.message}`, "warning"); }
}

function changeWorkspace(action) {
  workspaceQueue = workspaceQueue.catch((error) => console.error("An earlier workspace update failed.", error))
    .then(async () => {
      const result = await api("/api/workspace", { method: "POST", body: action });
      acceptWorkspace(result);
      return result;
    });
  return workspaceQueue;
}

function noteVisited() {
  if (authMode !== "users" || !activeProject || !activeDocument) return;
  const note = { project: activeProject.id, id: activeDocument.id };
  storeLayoutPreference(activeWorkspaceKey(), JSON.stringify(note));
  void changeWorkspace({ action: "visit", ...note })
    .catch((error) => documentNotice(`Could not remember this note: ${error.message}`, "warning"));
}

function restoreActiveWorkspaceNote() {
  if (!workspaceLoaded || activeDocument || authMode !== "users") return;
  const url = new URL(window.location.href);
  if (url.searchParams.has("document")) return;
  const requested = url.searchParams.get("project");
  let saved;
  try { saved = JSON.parse(readLayoutPreference(activeWorkspaceKey()) ?? "null"); }
  catch (error) { console.warn("The stored active note is invalid.", error); }
  const recent = userWorkspace.recent.filter((note) => !requested || note.project === requested);
  const note = [...recent, ...userWorkspace.favorites].find((note) => saved
    && (!requested || note.project === requested) && sameWorkspaceNote(note, saved.project, saved.id)) ?? recent[0];
  if (!note) return;
  url.searchParams.set("project", note.project);
  url.searchParams.set("document", note.id);
  commitUrl(url, "replace");
}

function refreshWorkspaceFavorite() {
  if (authMode !== "users") { workspaceControlSignature = null; return; }
  const signature = JSON.stringify([workspaceRevision, activeProject?.id, activeDocument?.id]);
  if (signature === workspaceControlSignature) return;
  workspaceControlSignature = signature;
  const isActive = (note) => activeProject && activeDocument && sameWorkspaceNote(note, activeProject.id, activeDocument.id);
  setText(element("workspace-favorite"), userWorkspace.favorites.some(isActive) ? "Remove from favorites" : "Add to favorites");
}

async function openWorkspaceNote(note) {
  workspaceDialog.close();
  try {
    await persistCurrentDraft();
    if (activeProject?.id === note.project) await navigateTo(note.id);
    else {
      await loadProjects();
      const url = new URL(window.location.href);
      url.searchParams.set("project", note.project);
      url.searchParams.set("document", note.id);
      url.hash = "";
      await switchProject(note.project, { url });
    }
  } catch (error) { documentNotice(`Could not open this note: ${error.message}`, "error"); }
}

function renderWorkspaceList() {
  const mode = element("workspace-kind").value;
  const notes = userWorkspace[mode];
  const query = element("workspace-filter").value.trim().toLowerCase();
  const matching = notes.filter((note) => `${note.title} ${note.path}`.toLowerCase().includes(query));
  element("workspace-list").replaceChildren(...matching.map((note) => {
    const row = document.createElement("div");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "workspace-item-name";
    open.textContent = note.title;
    const detail = document.createElement("small");
    detail.textContent = `${projects.find((project) => project.id === note.project)?.name ?? "Project"} / ${note.path}`;
    open.append(detail);
    open.addEventListener("click", () => void openWorkspaceNote(note));
    row.append(open);
    if (mode === "favorites") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        void changeWorkspace({ action: "favorite", project: note.project, id: note.id, value: false })
          .catch((error) => notice(element("workspace-message"), error.message, "error"));
      });
      row.append(remove);
    }
    return row;
  }));
  notice(element("workspace-message"), matching.length ? "" : "No matching workspace items.");
}

element("workspace-open").addEventListener("click", async () => {
  closeMenus();
  element("workspace-filter").value = "";
  renderWorkspaceList();
  if (!workspaceDialog.open) workspaceDialog.showModal();
  await loadUserWorkspace();
});
element("workspace-close").addEventListener("click", () => workspaceDialog.close());
element("workspace-kind").addEventListener("change", renderWorkspaceList);
element("workspace-filter").addEventListener("input", renderWorkspaceList);
element("workspace-favorite").addEventListener("click", async () => {
  closeMenus();
  if (!activeProject || !activeDocument) return;
  const project = activeProject.id;
  const id = activeDocument.id;
  const value = !userWorkspace.favorites.some((note) => sameWorkspaceNote(note, project, id));
  try { await changeWorkspace({ action: "favorite", project, id, value }); }
  catch (error) { documentNotice(`Could not update your workspace: ${error.message}`, "error"); }
});
window.addEventListener("focus", () => { if (authMode === "users") void loadUserWorkspace(); });

async function api(path, { method = "GET", body, signal, keepalive = false } = {}) {
  const resourceProject = activeProject?.id ?? "local";
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const binary = body instanceof Blob;
  if (body !== undefined) headers["Content-Type"] = binary ? body.type : "application/json";
  path = scopedApiPath(path, headers);
  let response;
  try {
    response = await fetch(path, {
      method, headers, credentials: "same-origin", cache: "no-store", redirect: "error", signal, keepalive,
      ...(body !== undefined ? { body: binary ? body : JSON.stringify(body) } : {}),
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
  const permissions = response.headers.get("x-notes-document-permissions");
  if (permissions) {
    try { payload.permissions = validatedDocumentPermissions(JSON.parse(permissions)); }
    catch (error) { throw new ApiError(`Invalid document permissions: ${error.message}`, response.status); }
  }
  rememberResources(payload, resourceProject);
  return payload;
}

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

const gitSyncUi = {
  enabled: element("settings-git-sync-enabled"),
  interval: element("settings-git-sync-interval"),
  summary: element("settings-git-sync-summary"),
};
const gitSyncNotice = document.createElement("p");
gitSyncNotice.className = "notice";
gitSyncNotice.id = "git-sync-message";
gitSyncNotice.setAttribute("role", "status");
gitSyncNotice.hidden = true;
statusNotices.append(gitSyncNotice);
let gitSyncSettings = null;
let gitSyncProject = null;
let gitSyncLoading = false;
let gitSyncTimer = null;
let gitSyncGeneration = 0;

function validateGitSync(value) {
  if (!value || typeof value.enabled !== "boolean" || !Number.isInteger(value.intervalMinutes)
      || value.intervalMinutes < 1 || value.intervalMinutes > 1440 || typeof value.running !== "boolean"
      || ["branch", "upstream", "error"].some(key => value[key] !== null && typeof value[key] !== "string")
      || ["nextRunAt", "lastRunAt", "lastSuccessAt"].some(key => value[key] !== null && !Number.isSafeInteger(value[key]))) {
    throw new ApiError("The service returned invalid automatic Git sync settings.");
  }
  return value;
}

function showGitSyncStatus(value) {
  const time = seconds => new Date(seconds * 1000).toLocaleString();
  const summary = !value.enabled ? "Automatic sync is off."
    : `${value.branch} → ${value.upstream}. ${value.running ? "Syncing…" : value.nextRunAt ? `Next: ${time(value.nextRunAt)}.` : "Waiting for scheduler."}`
      + (value.lastSuccessAt ? ` Last success: ${time(value.lastSuccessAt)}.` : "");
  setText(gitSyncUi.summary, summary);
  notice(gitSyncNotice, value.enabled && value.error ? `Automatic Git sync failed: ${value.error}` : value.running ? "Committing and pushing project changes…" : "", value.error ? "error" : "");
}

function populateGitSyncSettings() {
  gitSyncGeneration += 1;
  gitSyncSettings = null;
  gitSyncProject = activeProject?.id ?? null;
  gitSyncUi.enabled.checked = false;
  gitSyncUi.interval.value = "30";
  gitSyncUi.enabled.disabled = true;
  gitSyncUi.interval.disabled = true;
  setText(gitSyncUi.summary, activeProject?.owned ? "Loading automatic sync settings…" : "Only the project owner can configure automatic Git sync.");
  if (activeProject?.owned) void refreshGitSync(true);
}

async function refreshGitSync(populate = false) {
  if (!activeProject?.owned || publicView || connectionState !== "ready") return;
  if (gitSyncLoading && !populate) return;
  const generation = gitSyncGeneration;
  const project = activeProject.id;
  gitSyncLoading = true;
  try {
    const value = validateGitSync(await api("/api/git/sync"));
    if (generation !== gitSyncGeneration || project !== activeProject?.id) return;
    showGitSyncStatus(value);
    if (populate && ui.settingsDialog.open) {
      gitSyncSettings = value;
      gitSyncProject = project;
      gitSyncUi.enabled.checked = value.enabled;
      gitSyncUi.interval.value = String(value.intervalMinutes);
      gitSyncUi.enabled.disabled = false;
      gitSyncUi.interval.disabled = false;
    }
  } catch (error) {
    if (generation === gitSyncGeneration && project === activeProject?.id) {
      notice(gitSyncNotice, `Automatic Git sync status unavailable: ${error.message}`, "error");
    }
  } finally {
    gitSyncLoading = false;
    clearTimeout(gitSyncTimer);
    if (activeProject?.owned) gitSyncTimer = setTimeout(() => {
      if (document.visibilityState !== "hidden") void refreshGitSync();
    }, 30_000);
  }
}

async function saveGitSyncSettings() {
  if (!activeProject?.owned) return;
  if (gitSyncProject !== activeProject.id) {
    throw new ApiError("The project changed. Reopen Settings before saving.");
  }
  if (!gitSyncSettings && gitSyncUi.enabled.disabled) return;
  const enabled = gitSyncUi.enabled.checked;
  const intervalMinutes = Number(gitSyncUi.interval.value);
  if (enabled === gitSyncSettings.enabled && intervalMinutes === gitSyncSettings.intervalMinutes) return;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    throw new ApiError("Choose a Git sync interval from 1 to 1440 minutes.");
  }
  if (enabled && !window.confirm("Enable automatic commit and push for this project? All saved, non-ignored files and deletions, including changes by other users, will be committed and pushed to this branch's upstream without further confirmation.")) {
    throw new ApiError("Automatic Git sync was not enabled.");
  }
  const value = validateGitSync(await api("/api/git/sync", {
    method: "PUT", body: { enabled, intervalMinutes, confirm: enabled },
  }));
  gitSyncSettings = value;
  showGitSyncStatus(value);
}

function resetGitSyncStatus() {
  gitSyncGeneration += 1;
  gitSyncSettings = null;
  gitSyncProject = null;
  clearTimeout(gitSyncTimer);
  notice(gitSyncNotice, "");
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshGitSync();
});

const preferenceDefaults = {
  imageDirectory: "assets/images",
  imageCompression: "original",
  imageMaxEdge: 0,
  imageQuality: 85,
  autoSaveDelayMs: 1000,
  defaultView: "live",
  sourceLineWrap: true,
  spellcheck: true,
  fontSizePx: 17,
  lineHeightPercent: 175,
  density: "comfortable",
  defaultSidebar: "files",
  sidebarOpen: true,
  hiddenPatterns: [],
  treeRefreshSeconds: 0,
  gitRefreshSeconds: 15,
  gitShowUntracked: true,
  gitDefaultDiff: "working",
  largeDocumentThresholdKib: 768,
  previewDelayMs: 300,
  outlineDelayMs: 75,
  reducedMotion: false,
  highContrast: false,
  strongFocus: true,
};
let sharedAppearance = { theme: "system", latinFont: "sans-serif", cjkFont: "sans-serif" };
let webPreferences = { ...preferenceDefaults };
let preferencesLoaded = false;
let hiddenPatterns;
try {
  hiddenPatterns = parseHiddenPatterns(readLayoutPreference(HIDDEN_PATTERNS_KEY) ?? "");
} catch (error) {
  console.warn("Ignoring invalid stored library hide patterns.", error);
  hiddenPatterns = [];
}
let hiddenPath = createHiddenPathMatcher(hiddenPatterns);
let settingsSnapshot = null;
let selectedSettingsTab = "library";
let settingsSearchOrigin = null;

const settingsUi = Object.fromEntries([
  "auto-save", "default-view", "line-wrap", "spellcheck", "theme", "latin-font", "cjk-font",
  "font-size", "font-size-value", "line-height", "line-height-value", "density", "library-root",
  "tree-refresh", "default-sidebar", "sidebar-open", "git-refresh", "git-untracked", "git-diff",
  "large-threshold", "preview-delay", "outline-delay", "reduced-motion", "high-contrast",
  "strong-focus", "save",
].map((name) => [name.replaceAll("-", "_"), element(`settings-${name}`)]));

function visibleLibraryFiles() {
  return files.filter((file) => !hiddenPath(file.path));
}

function visibleLibraryDirectories() {
  return directories.filter((directory) => !hiddenPath(directory.path));
}

function selectSettingsTab(tab) {
  if (tab === "users" && authUser?.role !== "admin") tab = "library";
  selectedSettingsTab = tab;
  for (const button of document.querySelectorAll("[data-settings-tab]")) {
    const selected = button.dataset.settingsTab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && ui.settingsDialog.open) button.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  for (const panel of document.querySelectorAll("[data-settings-panel]")) {
    panel.hidden = panel.dataset.settingsPanel !== tab;
  }
  if (tab === "users") void loadAccounts();
}

function filterSettings() {
  const query = ui.settingsSearch.value.trim().toLowerCase();
  if (!query) {
    for (const button of document.querySelectorAll("[data-settings-tab]")) {
      button.hidden = button.hasAttribute("data-admin-only") && authUser?.role !== "admin";
    }
    if (settingsSearchOrigin) selectSettingsTab(settingsSearchOrigin);
    settingsSearchOrigin = null;
    return;
  }
  settingsSearchOrigin ??= selectedSettingsTab;
  let firstVisible = null;
  let selectedVisible = false;
  for (const button of document.querySelectorAll("[data-settings-tab]")) {
    const panel = document.querySelector(`[data-settings-panel="${button.dataset.settingsTab}"]`);
    const visible = (!button.hasAttribute("data-admin-only") || authUser?.role === "admin")
      && `${button.textContent} ${panel.textContent}`.toLowerCase().includes(query);
    button.hidden = !visible;
    if (visible) firstVisible ??= button.dataset.settingsTab;
    if (visible && button.getAttribute("aria-selected") === "true") selectedVisible = true;
  }
  if (!selectedVisible && firstVisible) selectSettingsTab(firstVisible);
}

function commandShortcutLabel(value = commandShortcut) {
  return value === "primary-shift-p" ? "Ctrl/Cmd+Shift+P" : "Ctrl/Cmd+K";
}

function updateCommandShortcut(value, persist = false) {
  commandShortcut = value === "primary-shift-p" ? value : "primary-k";
  ui.commandOpen.title = `Commands (${commandShortcutLabel()})`;
  if (persist) storeLayoutPreference(COMMAND_SHORTCUT_KEY, commandShortcut);
}

function validatedPreferences(value) {
  if (!value?.appearance || !value?.web) throw new ApiError("The service returned incomplete settings.");
  const web = { ...preferenceDefaults, ...value.web };
  const choices = {
    imageCompression: ["original", "webp", "jpeg"],
    defaultView: ["live", "source", "compare", "read"],
    density: ["compact", "comfortable"],
    defaultSidebar: ["files", "outline", "git"],
    gitDefaultDiff: ["working", "staged"],
  };
  for (const [name, values] of Object.entries(choices)) {
    if (!values.includes(web[name])) throw new ApiError(`The service returned an invalid ${name} setting.`);
  }
  for (const name of [
    "sourceLineWrap", "spellcheck", "sidebarOpen", "gitShowUntracked",
    "reducedMotion", "highContrast", "strongFocus",
  ]) {
    if (typeof web[name] !== "boolean") throw new ApiError(`The service returned an invalid ${name} setting.`);
  }
  for (const name of [
    "autoSaveDelayMs", "fontSizePx", "lineHeightPercent", "treeRefreshSeconds",
    "gitRefreshSeconds", "largeDocumentThresholdKib", "previewDelayMs", "outlineDelayMs",
    "imageMaxEdge", "imageQuality",
  ]) {
    if (!Number.isInteger(web[name]) || web[name] < 0) {
      throw new ApiError(`The service returned an invalid ${name} setting.`);
    }
  }
  if (!Array.isArray(web.hiddenPatterns) || web.hiddenPatterns.some((pattern) => typeof pattern !== "string")) {
    throw new ApiError("The service returned invalid hidden paths.");
  }
  return {
    appearance: {
      theme: value.appearance.theme,
      latinFont: value.appearance.latinFont,
      cjkFont: value.appearance.cjkFont,
    },
    web,
  };
}

function applySharedPreferences(value, initial = false) {
  sharedAppearance = value.appearance;
  webPreferences = value.web;
  hiddenPatterns = parseHiddenPatterns(webPreferences.hiddenPatterns.join("\n"));
  hiddenPath = createHiddenPathMatcher(hiddenPatterns);
  const root = document.documentElement;
  root.style.setProperty("--document-size", `${webPreferences.fontSizePx}px`);
  root.style.setProperty("--document-line-height", String(webPreferences.lineHeightPercent / 100));
  root.style.setProperty("--source-size", `${Math.max(12, webPreferences.fontSizePx - 2)}px`);
  root.dataset.density = webPreferences.density;
  root.dataset.reducedMotion = String(webPreferences.reducedMotion);
  root.dataset.highContrast = String(webPreferences.highContrast);
  root.dataset.strongFocus = String(webPreferences.strongFocus);
  ui.editor.setLineWrapping(webPreferences.sourceLineWrap);
  ui.editor.setThreshold(webPreferences.largeDocumentThresholdKib * 1024);
  inlineEditor.setSpellcheck(webPreferences.spellcheck);
  void applyAppearance(sharedAppearance).then((result) => appearanceNotice(result.warning));
  if (initial && !activeDocument) {
    setView({
      live: "rich", source: "editor", compare: "split", read: "preview",
    }[webPreferences.defaultView]);
    selectSidebarTab(webPreferences.defaultSidebar);
    setSidebar(!compactLayout.matches && webPreferences.sidebarOpen);
  }
  if (treeLoaded) renderFiles();
  scheduleTreeRefresh();
  scheduleGitRefresh();
}

async function refreshSharedPreferences() {
  try {
    const preferences = validatedPreferences(await api("/api/preferences"));
    if (!preferences.web.hiddenPatterns.length && hiddenPatterns.length) {
      preferences.web.hiddenPatterns = [...hiddenPatterns];
    }
    applySharedPreferences(preferences, !preferencesLoaded);
    preferencesLoaded = true;
  } catch (error) {
    appearanceNotice(`Shared settings could not be loaded. ${error.message}`);
  }
}

function populateSettings() {
  element("settings-image-compression").value = webPreferences.imageCompression;
  element("settings-image-max-edge").value = String(webPreferences.imageMaxEdge);
  element("settings-image-quality").value = String(webPreferences.imageQuality);
  element("settings-image-directory").value = activeProject?.imageDirectory ?? webPreferences.imageDirectory;
  element("settings-image-directory").disabled = authMode === "users" && !activeProject?.owned;
  settingsUi.auto_save.value = String(webPreferences.autoSaveDelayMs);
  settingsUi.default_view.value = webPreferences.defaultView;
  settingsUi.line_wrap.checked = webPreferences.sourceLineWrap;
  settingsUi.spellcheck.checked = webPreferences.spellcheck;
  settingsUi.theme.value = sharedAppearance.theme;
  settingsUi.latin_font.value = sharedAppearance.latinFont;
  settingsUi.cjk_font.value = sharedAppearance.cjkFont;
  settingsUi.font_size.value = String(webPreferences.fontSizePx);
  settingsUi.font_size_value.value = `${webPreferences.fontSizePx} px`;
  settingsUi.line_height.value = String(webPreferences.lineHeightPercent);
  settingsUi.line_height_value.value = `${webPreferences.lineHeightPercent}%`;
  settingsUi.density.value = webPreferences.density;
  setText(element("settings-library-label"), activeProject ? "Current project" : "Current folder");
  settingsUi.library_root.value = activeProject?.name ?? currentRoot ?? "Not connected";
  ui.settingsHiddenPatterns.value = hiddenPatterns.join("\n");
  settingsUi.tree_refresh.value = String(webPreferences.treeRefreshSeconds);
  ui.settingsPageWidth.value = document.documentElement.dataset.pageWidth || "balanced";
  ui.settingsSidebarWidth.value = String(preferredSidebarWidth);
  ui.settingsSidebarValue.value = `${preferredSidebarWidth} px`;
  settingsUi.default_sidebar.value = webPreferences.defaultSidebar;
  settingsUi.sidebar_open.checked = webPreferences.sidebarOpen;
  settingsUi.git_refresh.value = String(webPreferences.gitRefreshSeconds);
  settingsUi.git_untracked.checked = webPreferences.gitShowUntracked;
  settingsUi.git_diff.value = webPreferences.gitDefaultDiff;
  settingsUi.large_threshold.value = String(webPreferences.largeDocumentThresholdKib);
  settingsUi.preview_delay.value = String(webPreferences.previewDelayMs);
  settingsUi.outline_delay.value = String(webPreferences.outlineDelayMs);
  settingsUi.reduced_motion.checked = webPreferences.reducedMotion;
  settingsUi.high_contrast.checked = webPreferences.highContrast;
  settingsUi.strong_focus.checked = webPreferences.strongFocus;
  ui.settingsCommandShortcut.value = commandShortcut;
}

function collectSettings() {
  const patterns = parseHiddenPatterns(ui.settingsHiddenPatterns.value);
  return validatedPreferences({
    appearance: {
      theme: settingsUi.theme.value,
      latinFont: settingsUi.latin_font.value.trim(),
      cjkFont: settingsUi.cjk_font.value.trim(),
    },
    web: {
      imageCompression: element("settings-image-compression").value,
      imageMaxEdge: Number(element("settings-image-max-edge").value),
      imageQuality: Number(element("settings-image-quality").value),
      imageDirectory: activeProject ? webPreferences.imageDirectory : element("settings-image-directory").value.trim(),
      autoSaveDelayMs: Number(settingsUi.auto_save.value),
      defaultView: settingsUi.default_view.value,
      sourceLineWrap: settingsUi.line_wrap.checked,
      spellcheck: settingsUi.spellcheck.checked,
      fontSizePx: Number(settingsUi.font_size.value),
      lineHeightPercent: Number(settingsUi.line_height.value),
      density: settingsUi.density.value,
      defaultSidebar: settingsUi.default_sidebar.value,
      sidebarOpen: settingsUi.sidebar_open.checked,
      hiddenPatterns: patterns,
      treeRefreshSeconds: Number(settingsUi.tree_refresh.value),
      gitRefreshSeconds: Number(settingsUi.git_refresh.value),
      gitShowUntracked: settingsUi.git_untracked.checked,
      gitDefaultDiff: settingsUi.git_diff.value,
      largeDocumentThresholdKib: Number(settingsUi.large_threshold.value),
      previewDelayMs: Number(settingsUi.preview_delay.value),
      outlineDelayMs: Number(settingsUi.outline_delay.value),
      reducedMotion: settingsUi.reduced_motion.checked,
      highContrast: settingsUi.high_contrast.checked,
      strongFocus: settingsUi.strong_focus.checked,
    },
  });
}

function openSettings(tab = "library") {
  if (publicView) return;
  if (ui.settingsDialog.open || !ui.authScreen.hidden) return;
  closeMenus();
  closeCommandPanel();
  populateSettings();
  ui.settingsSearch.value = "";
  settingsSearchOrigin = null;
  settingsSnapshot = {
    preferences: { appearance: { ...sharedAppearance }, web: { ...webPreferences, hiddenPatterns: [...hiddenPatterns] } },
    pageWidth: document.documentElement.dataset.pageWidth || "balanced",
    sidebarWidth: preferredSidebarWidth,
    commandShortcut,
  };
  notice(ui.settingsError, "");
  filterSettings();
  ui.settingsDialog.showModal();
  populateGitSyncSettings();
  selectSettingsTab(tab);
  ui.settingsSearch.focus();
}

function cancelSettings() {
  if (settingsSnapshot) {
    applySharedPreferences(settingsSnapshot.preferences);
    setPageWidth(settingsSnapshot.pageWidth);
    setSidebarWidth(settingsSnapshot.sidebarWidth);
    updateCommandShortcut(settingsSnapshot.commandShortcut);
  }
  settingsSnapshot = null;
  if (ui.settingsDialog.open) ui.settingsDialog.close();
}

async function saveSettings(event) {
  event.preventDefault();
  settingsUi.save.disabled = true;
  notice(ui.settingsError, "");
  try {
    const preferences = collectSettings();
    await saveGitSyncSettings();
    if (activeProject?.owned && element("settings-image-directory").value.trim() !== activeProject.imageDirectory) {
      activeProject = await api("/api/projects", { method: "POST", body: {
        action: "share", id: activeProject.id, shared: activeProject.shared,
        imageDirectory: element("settings-image-directory").value.trim(),
      } });
    }
    const saved = validatedPreferences(await api("/api/preferences", {
      method: "PUT",
      body: preferences,
    }));
    storeLayoutPreference(HIDDEN_PATTERNS_KEY, saved.web.hiddenPatterns.join("\n"));
    setPageWidth(ui.settingsPageWidth.value, true);
    setSidebarWidth(Number(ui.settingsSidebarWidth.value), true);
    updateCommandShortcut(ui.settingsCommandShortcut.value, true);
    applySharedPreferences(saved);
    settingsSnapshot = null;
    ui.settingsDialog.close();
  } catch (error) {
    notice(ui.settingsError, error.message, "error");
  } finally {
    settingsUi.save.disabled = false;
  }
}

function previewAppearanceSettings() {
  const fontSize = Number(settingsUi.font_size.value);
  const lineHeight = Number(settingsUi.line_height.value);
  settingsUi.font_size_value.value = `${fontSize} px`;
  settingsUi.line_height_value.value = `${lineHeight}%`;
  document.documentElement.style.setProperty("--document-size", `${fontSize}px`);
  document.documentElement.style.setProperty("--document-line-height", String(lineHeight / 100));
  document.documentElement.dataset.density = settingsUi.density.value;
  void applyAppearance({
    theme: settingsUi.theme.value,
    latinFont: settingsUi.latin_font.value.trim() || sharedAppearance.latinFont,
    cjkFont: settingsUi.cjk_font.value.trim() || sharedAppearance.cjkFont,
  });
}

updateCommandShortcut(commandShortcut);
ui.settingsOpen.addEventListener("click", () => openSettings());
ui.settingsClose.addEventListener("click", cancelSettings);
ui.settingsCancel.addEventListener("click", cancelSettings);
ui.settingsForm.addEventListener("submit", (event) => void saveSettings(event));
ui.settingsDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelSettings();
});
ui.settingsSearch.addEventListener("input", filterSettings);
ui.settingsPageWidth.addEventListener("change", () => setPageWidth(ui.settingsPageWidth.value));
ui.settingsSidebarWidth.addEventListener("input", () => {
  const width = Number(ui.settingsSidebarWidth.value);
  ui.settingsSidebarValue.value = `${width} px`;
  setSidebarWidth(width);
});
ui.settingsCommandShortcut.addEventListener("change", () => {
  updateCommandShortcut(ui.settingsCommandShortcut.value);
});
for (const name of ["theme", "latin_font", "cjk_font", "font_size", "line_height", "density"]) {
  settingsUi[name].addEventListener("input", previewAppearanceSettings);
}
for (const button of document.querySelectorAll("[data-settings-tab]")) {
  button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
}

let accountBusy = false;
let passwordTarget = null;
const accountsUi = {
  list: element("accounts-list"), invitations: element("invitations-list"),
  error: element("accounts-error"), create: element("invite-create"),
  lifetime: element("invite-lifetime"), created: element("invite-created"), code: element("invite-code"),
  copy: element("invite-copy"), dialog: element("account-password-dialog"),
  password: element("account-password"), passwordError: element("account-password-error"),
};

function accountButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = accountBusy;
  button.addEventListener("click", action);
  return button;
}

function renderAccounts(value) {
  if (!Array.isArray(value?.users) || !Array.isArray(value?.invitations)) throw new ApiError("Incomplete account data.");
  const users = document.createDocumentFragment();
  for (const user of value.users) {
    const row = document.createElement("div");
    row.className = "account-row";
    const name = document.createElement("strong");
    name.textContent = user.username;
    const role = document.createElement("select");
    role.setAttribute("aria-label", `Role for ${user.username}`);
    for (const value of ["user", "admin"]) {
      const option = document.createElement("option");
      option.value = value; option.textContent = value === "admin" ? "Administrator" : "User";
      role.append(option);
    }
    role.value = user.role;
    role.addEventListener("change", () => {
      if (!confirm(`Change ${user.username} to ${role.value}? Existing sessions for this account will end.`)) {
        role.value = user.role; return;
      }
      void accountAction({ action: "role", username: user.username, role: role.value });
    });
    row.append(name, role,
      accountButton("Reset password", () => {
        passwordTarget = user.username;
        accountsUi.password.value = "";
        setText(element("account-password-title"), `Reset password: ${user.username}`);
        notice(accountsUi.passwordError, "");
        accountsUi.dialog.showModal();
        accountsUi.password.focus();
      }),
      accountButton("Delete", () => {
        if (confirm(`Delete account ${user.username}? Their sessions will end; note files will not be deleted.`)) {
          void accountAction({ action: "delete", username: user.username });
        }
      }));
    users.append(row);
  }
  accountsUi.list.replaceChildren(users);
  const invitations = document.createDocumentFragment();
  for (const invite of value.invitations) {
    const row = document.createElement("div");
    row.className = "account-row invitation-row";
    const details = document.createElement("span");
    details.textContent = `${invite.id.slice(0, 8)} · ${invite.usedBy ? `Used by ${invite.usedBy}` : invite.expired
      ? "Expired" : `Expires ${new Date(invite.expiresAt * 1000).toLocaleString()}`}`;
    row.append(details, accountButton("Revoke", () => void accountAction({ action: "revokeInvite", id: invite.id })));
    invitations.append(row);
  }
  accountsUi.invitations.replaceChildren(invitations);
  if (!value.invitations.length) accountsUi.invitations.textContent = "No invitations.";
}

function accountControls() {
  accountsUi.create.disabled = accountBusy;
  for (const control of document.querySelectorAll("#accounts-list button, #accounts-list select, #invitations-list button, #account-password-form button")) {
    control.disabled = accountBusy;
  }
}

async function loadAccounts() {
  if (authUser?.role !== "admin" || accountBusy) return;
  accountBusy = true;
  accountControls();
  notice(accountsUi.error, "");
  try { renderAccounts(await api("/api/admin/accounts")); }
  catch (error) { notice(accountsUi.error, error.message, "error"); }
  finally { accountBusy = false; accountControls(); }
}

async function accountAction(body) {
  if (authUser?.role !== "admin" || accountBusy) return false;
  const self = body.username === authUser.username;
  if (self && !confirmDiscard("update your account and log in again")) return false;
  accountBusy = true;
  accountControls();
  notice(accountsUi.error, "");
  try {
    const response = await api("/api/admin/accounts", { method: "POST", body });
    if (self) { window.location.reload(); return true; }
    renderAccounts(response.accounts);
    if (response.code) {
      accountsUi.code.value = response.code;
      accountsUi.created.hidden = false;
      setText(accountsUi.copy, "Copy invitation");
    }
    return true;
  } catch (error) {
    notice(accountsUi.error, error.message, "error");
    if (accountsUi.dialog.open) notice(accountsUi.passwordError, error.message, "error");
    return false;
  } finally {
    if (body.password) body.password = "";
    accountBusy = false;
    accountControls();
  }
}

accountsUi.create.addEventListener("click", () =>
  void accountAction({ action: "invite", hours: Number(accountsUi.lifetime.value) }));
accountsUi.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(accountsUi.code.value);
    setText(accountsUi.copy, "Copied");
  } catch {
    accountsUi.code.focus(); accountsUi.code.select();
    notice(accountsUi.error, "Clipboard access is unavailable. Copy the selected invitation key manually.", "warning");
  }
});
ui.settingsDialog.addEventListener("close", () => {
  accountsUi.code.value = "";
  accountsUi.created.hidden = true;
});
element("account-password-cancel").addEventListener("click", () => accountsUi.dialog.close());
accountsUi.dialog.addEventListener("close", () => { accountsUi.password.value = ""; passwordTarget = null; });
element("account-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!passwordTarget) return;
  const saved = await accountAction({ action: "password", username: passwordTarget, password: accountsUi.password.value });
  accountsUi.password.value = "";
  if (saved) accountsUi.dialog.close();
});
element("auth-use-invitation").addEventListener("click", () => showAuthentication(false, "", true));
element("auth-back-login").addEventListener("click", () => {
  element("auth-invitation").value = "";
  ui.authPassword.value = ""; ui.authConfirm.value = "";
  showAuthentication(false);
});

let documentPermissions = null;

function validatedDocumentPermissions(value) {
  if (!value || !["writable", "collaborative", "owner"].every((key) => typeof value[key] === "boolean")
      || value.collaborative && !value.writable) {
    throw new ApiError("The service returned incomplete document permissions.");
  }
  return value;
}

function acceptDocumentPermissions(value) {
  const next = validatedDocumentPermissions(value);
  const changed = !documentPermissions || ["writable", "collaborative", "owner"].some((key) => documentPermissions[key] !== next[key]);
  documentPermissions = next;
  if (publicView) publicWritable = value.writable;
  return changed;
}

const resourceIndex = new Map();
const resourceLocations = new Map();
const resolvingResourceLinks = new Set();
const resourceLocation = (project, path) => `${project}\0${normalizeNotePath(path)}`;

function rememberResource(value, project = activeProject?.id ?? "local", kind = "document") {
  if (!value || !isResourceId(value.id) || typeof value.path !== "string") return;
  const resource = { id: value.id, path: value.path, project: value.project ?? project,
    kind: value.kind === "file" ? "document" : value.kind ?? kind };
  const previous = resourceIndex.get(resource.id);
  if (previous) resourceLocations.delete(resourceLocation(previous.project, previous.path));
  resourceIndex.set(resource.id, resource);
  resourceLocations.set(resourceLocation(resource.project, resource.path), resource);
  return !previous || previous.path !== resource.path || previous.project !== resource.project;
}

function rememberResources(payload, project) {
  let changed = rememberResource(payload, project);
  for (const file of payload?.files ?? []) changed = rememberResource(file, project) || changed;
  for (const directory of payload?.directories ?? []) changed = rememberResource(directory, project, "directory") || changed;
  for (const result of payload?.results ?? []) changed = rememberResource(result, result.project ?? project) || changed;
  for (const reference of payload?.references ?? []) {
    changed = rememberResource(reference, reference.project ?? project) || changed;
    if (typeof reference.source === "string") {
      resourceLocations.set(resourceLocation(reference.project ?? project, reference.source), resourceIndex.get(reference.id));
    }
  }
  for (const note of [...(payload?.workspace?.favorites ?? []), ...(payload?.workspace?.recent ?? [])]) {
    changed = rememberResource(note, note.project) || changed;
  }
  if (payload?.document && typeof payload.document === "object") changed = rememberResource(payload.document, project) || changed;
  if (changed) requestAnimationFrame(() => { inlineEditor.refreshLinks?.(); refreshPreviewLinks(); });
}

function requestResourceLink(path, kind) {
  const project = activeDocument?.project ?? activeProject?.id ?? "local";
  const key = resourceLocation(project, path);
  if (resolvingResourceLinks.has(key)) return;
  resolvingResourceLinks.add(key);
  const current = documentId;
  void api("/api/resources/resolve", { method: "POST", body: { path, kind, document: activeDocument?.id ?? null } })
    .then((resource) => {
      resourceLocations.set(key, resource);
      if (current === documentId) { inlineEditor.refreshLinks?.(); refreshPreviewLinks(); }
    })
    .catch((error) => {
      if (current === documentId) documentNotice(`Could not resolve “${path}”: ${error.message}`, "warning");
    })
    .finally(() => resolvingResourceLinks.delete(key));
}

async function documentResource(value, signal) {
  if (isResourceId(value)) {
    const resource = resourceIndex.get(value);
    if (resource) return resource;
    return api(`/api/resource?id=${encodeURIComponent(value)}`, { signal });
  }
  const project = activeDocument?.project ?? activeProject?.id ?? "local";
  const known = resourceLocations.get(resourceLocation(project, value));
  if (known) return known;
  return api("/api/resources/resolve", {
    method: "POST", signal, body: { path: value, kind: "document", document: activeDocument?.id ?? null },
  });
}

function currentResourceId(path, kind = "document") {
  if (isResourceId(path)) return path;
  const resource = resourceLocations.get(resourceLocation(activeDocument?.project ?? activeProject?.id ?? "local", path));
  if (!resource || resource.kind !== kind) throw new ApiError("This resource has no current identity. Refresh the project before continuing.");
  return resource.id;
}

let projects = [];
let activeProject = null;
let projectGeneration = 0;
let projectCreating = false;
let sharingTarget = null;
const projectDialog = element("projects-dialog");
const sharingDialog = element("sharing-dialog");

function projectStorageKey() { return `notes.projects.${authUser?.username ?? "local"}`; }
function projectWritable(path = activeDocument?.path) {
  if (path === activeDocument?.path && documentPermissions) return documentPermissions.writable;
  if (publicView) return publicWritable;
  if (authMode !== "users") return true;
  return activeProject?.owned || (activeProject?.pages[path] ?? activeProject?.access) === "edit";
}
function projectCanCreate() {
  if (publicView) return false;
  return authMode !== "users" || Boolean(activeProject && (activeProject.owned || activeProject.access === "edit"));
}
function projectOwns() { return !publicView && (authMode !== "users" || Boolean(activeProject?.owned)); }
function projectHasGit() { return !publicView && (authMode !== "users" || Boolean(activeProject?.gitAvailable)); }

function projectUrl(value, documentPath = activeDocument?.path) {
  if (!value || !value.startsWith("/")) return value;
  const url = new URL(value, window.location.href);
  const project = activeDocument?.project ?? activeProject?.id ?? "local";
  const asset = url.pathname === "/assets" && isResourceId(url.searchParams.get("id"));
  const document = url.pathname === "/" && isResourceId(url.searchParams.get("document"));
  if (!asset && !document) {
    const path = decodeURIComponent(url.pathname.slice(1));
    const resource = resourceLocations.get(resourceLocation(project, path));
    if (!resource) {
      requestResourceLink(path, /\.(md|markdown)$/i.test(path) ? "document" : "asset");
      return null;
    }
    url.search = "";
    if (resource.kind === "document") {
      url.pathname = "/";
      url.searchParams.set("document", resource.id);
    } else if (resource.kind === "asset") {
      url.pathname = "/assets";
      url.searchParams.set("id", resource.id);
    } else return null;
  }
  const context = resourceLocations.get(resourceLocation(project, documentPath ?? ""))?.id ?? activeDocument?.id;
  if (publicView) {
    if (url.pathname === "/assets") {
      url.pathname = "/api/public/assets";
      url.searchParams.set("share", publicToken);
      if (context) url.searchParams.set("document", context);
    } else if (url.pathname === "/") {
      if (url.searchParams.get("document") !== activeDocument?.id) return null;
      url.pathname = "/share";
      url.search = "";
      url.searchParams.set("share", publicToken);
    }
    return url.pathname + url.search + url.hash;
  }
  if (activeProject && (url.pathname === "/assets" || url.pathname === "/")) {
    url.searchParams.set("project", project);
  }
  if (url.pathname === "/assets" && context) url.searchParams.set("document", context);
  return url.pathname + url.search + url.hash;
}

function updateProjectControls() {
  ui.settingsOpen.hidden = publicView;
  ui.sidebarToggle.hidden = publicView;
  element("projects-open").hidden = authMode !== "users";
  element("app-name").hidden = authMode === "users";
  setText(element("projects-open"), activeProject?.name ?? "Projects");
  element("share-page").hidden = !activeProject?.owned || !activeDocument;
  gitUi.tab.hidden = !projectHasGit();
  if (!projectHasGit() && !gitUi.panel.hidden) selectSidebarTab("files");
}

async function loadProjects() {
  if (authMode !== "users") return;
  const result = await api("/api/projects");
  if (!Array.isArray(result) || result.some((p) => typeof p.id !== "string"
      || typeof p.name !== "string" || !["private", "read", "edit"].includes(p.access))) {
    throw new ApiError("The service returned an incomplete project list.");
  }
  projects = result;
  renderProjects();
}

async function ensureProject() {
  if (authMode !== "users") return true;
  await loadProjects();
  const url = new URL(window.location.href);
  let requested = url.searchParams.get("project");
  const documentRoute = readNoteRoute(url);
  if (!requested && documentRoute.id) {
    const resource = await documentResource(documentRoute.id);
    requested = resource.project;
  }
  const chosen = requested ?? activeProject?.id ?? readLayoutPreference(projectStorageKey());
  activeProject = projects.find((project) => project.id === chosen) ?? (requested ? null : projects[0] ?? null);
  updateProjectControls();
  if (!activeProject) {
    if (requested) throw new ApiError("This project is private or no longer shared with you. Open Projects to choose another.", 403);
    connectionState = "ready";
    currentRoot = null;
    renderFiles();
    documentNotice("Create a project, or open one shared with you.");
    return false;
  }
  url.searchParams.set("project", activeProject.id);
  commitUrl(url, "replace");
  storeLayoutPreference(projectStorageKey(), activeProject.id);
  return true;
}

async function switchProject(id, { url = null, mode = "push" } = {}) {
  if (pendingSave || creating || movingEntry || gitLoading || projectCreating || imageUploading) {
    documentNotice("Wait for the current operation before switching projects.");
    return false;
  }
  if (!confirmDiscard("switch projects")) { if (mode === "pop") restoreCommittedUrl(); return false; }
  const project = projects.find((project) => project.id === id);
  if (!project) { documentNotice("This project is no longer accessible.", "error"); return false; }
  const next = url ?? new URL(window.location.href);
  next.searchParams.set("project", id);
  if (!url) { next.searchParams.delete("document"); next.hash = ""; }
  projectGeneration += 1;
  resetGitSyncStatus();
  cancelDocumentLoad(false);
  treeController?.abort();
  treeGate.invalidate();
  connectionController?.abort();
  connectionGate.invalidate();
  clearDocument(next, mode);
  activeProject = project;
  currentRoot = null;
  files = [];
  directories = [];
  treeLoaded = false;
  treeError = "";
  treeTruncated = false;
  collapsedFolders.clear();
  ui.filter.value = "";
  gitStatus = null;
  gitFilesSignature = null;
  gitUi.files.replaceChildren();
  gitUi.commitMessage.value = "";
  gitUi.diffDialog.close();
  gitDiffSequence += 1;
  storeLayoutPreference(projectStorageKey(), id);
  projectDialog.close();
  renderFiles();
  updateProjectControls();
  await connect();
  return true;
}

function renderProjects() {
  const list = element("projects-list");
  list.replaceChildren();
  for (const project of projects) {
    const row = document.createElement("div");
    row.className = "project-row";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "project-open";
    open.dataset.project = project.id;
    open.setAttribute("aria-current", String(project.id === activeProject?.id));
    const name = document.createElement("strong");
    name.textContent = project.name;
    const detail = document.createElement("small");
    detail.textContent = project.owned
      ? `Yours · ${project.shared === "private" ? "Private" : project.shared === "edit" ? "Everyone can edit" : "Everyone can read"}`
      : `By ${project.owner} · ${project.access === "private" ? "Shared pages only" : project.access === "edit" ? "Can edit" : "Read only"}`;
    open.append(name, detail);
    open.addEventListener("click", () => void switchProject(project.id));
    row.append(open);
    if (project.owned) {
      const manage = document.createElement("button");
      manage.type = "button";
      manage.textContent = "Manage";
      manage.setAttribute("aria-label", `Manage ${project.name}`);
      manage.addEventListener("click", () => openSharing(project));
      row.append(manage);
    }
    list.append(row);
  }
}

async function openProjects() {
  closeMenus();
  element("project-kind").querySelector('[value="folder"]').hidden = authUser?.role !== "admin";
  if (!projectDialog.open) projectDialog.showModal();
  notice(element("project-error"), "");
  try { await loadProjects(); }
  catch (error) { notice(element("project-error"), error.message, "error"); }
}

function openSharing(project, path = null, document = null) {
  document ??= path ? project.documentIds?.[path]
    ?? resourceLocations.get(resourceLocation(project.id, path))?.id : null;
  if (path && !isResourceId(document)) {
    documentNotice("This document identity is unavailable. Refresh the project before changing permissions.", "error");
    return;
  }
  sharingTarget = { project, path, document };
  setText(element("sharing-title"), path ? "Document permissions" : "Project settings");
  setText(element("sharing-description"), path
    ? `${path} · These permissions override the Project. Public links grant access only to this document and its allowed attachments.`
    : `${project.name} · Shared projects are visible to every signed-in user. Only you manage sharing and Git writes.`);
  const options = [...(path ? [["inherit", "Inherit Project permission"]] : []),
    ["private", "Private (owner only)"], ["read", "Signed-in users can read"], ["edit", "Signed-in users can edit"],
    ...(path ? [["publicRead", "Public link (no login required)"]] : [])];
  element("sharing-level").replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  const link = path ? project.publicLinks?.[path] : null;
  element("sharing-level").value = path ? link ? "publicRead" : project.pages[path] ?? "inherit" : project.shared;
  element("sharing-public-edit").checked = link?.access === "edit";
  const expiration = link?.expiresAt ? new Date(link.expiresAt) : null;
  element("sharing-expires").value = expiration ? new Date(expiration.getTime() - expiration.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
  element("sharing-password").value = "";
  element("sharing-password").disabled = false;
  element("sharing-clear-password").checked = false;
  element("sharing-clear-password-field").hidden = !link?.passwordRequired;
  renderPublicShareFields();
  element("sharing-documents").replaceChildren(...(path ? [] : Object.keys(project.pages)).map((documentPath) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-open";
    button.textContent = documentPath;
    button.addEventListener("click", () => openSharing(project, documentPath, project.documentIds?.[documentPath]));
    return button;
  }));
  element("sharing-project-fields").hidden = Boolean(path);
  element("sharing-name").value = project.name;
  element("sharing-image-directory").value = project.imageDirectory;
  element("sharing-name").required = !path;
  element("sharing-image-directory").required = !path;
  element("sharing-credential-field").hidden = Boolean(path) || !project.repository;
  element("sharing-token").value = "";
  notice(element("sharing-error"), "");
  if (!sharingDialog.open) sharingDialog.showModal();
}

element("projects-open").addEventListener("click", () => void openProjects());
element("projects-close").addEventListener("click", () => projectDialog.close());
projectDialog.addEventListener("cancel", (event) => { if (projectCreating) event.preventDefault(); });
element("project-kind").addEventListener("change", () => {
  const kind = element("project-kind").value;
  element("project-source-field").hidden = kind === "new";
  element("project-source").required = kind !== "new";
  element("project-token-field").hidden = kind !== "github";
});
element("project-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (projectCreating) return;
  projectCreating = true;
  const controls = [...event.target.elements];
  const body = {
    action: "create", name: element("project-name").value, kind: element("project-kind").value,
    source: element("project-source").value.trim(), token: element("project-token").value || null,
  };
  controls.forEach((control) => { control.disabled = true; });
  notice(element("project-error"), "");
  documentNotice(body.kind === "github" ? "Cloning GitHub repository…" : "Creating project…");
  try {
    const project = await api("/api/projects", { method: "POST", body });
    projects.push(project);
    element("project-token").value = "";
    projectCreating = false;
    renderProjects();
    await switchProject(project.id);
    documentNotice("Project created.", "success");
  } catch (error) {
    notice(element("project-error"), error.message, "error");
    documentNotice(`Could not create project: ${error.message}`, "error");
  } finally {
    projectCreating = false;
    controls.forEach((control) => { control.disabled = false; });
  }
});
element("share-page").addEventListener("click", () => { closeMenus(); openSharing(activeProject, activeDocument.path); });
element("sharing-cancel").addEventListener("click", () => sharingDialog.close());
async function saveSharing(resetLink = false) {
  const { project, path, document } = sharingTarget;
  element("sharing-save").disabled = true;
  element("sharing-reset-link").disabled = true;
  notice(element("sharing-error"), "");
  try {
    if (!path && element("sharing-token").value) {
      await api("/api/projects", { method: "POST", body: {
        action: "credential", id: project.id, token: element("sharing-token").value,
      } });
      element("sharing-token").value = "";
    }
    let permission = element("sharing-level").value;
    if (permission === "publicRead" && element("sharing-public-edit").checked) permission = "publicEdit";
    const body = path ? { action: "document", id: project.id, document, permission, resetLink }
      : { action: "share", id: project.id, shared: permission, name: element("sharing-name").value,
        imageDirectory: element("sharing-image-directory").value.trim() };
    if (path && permission.startsWith("public")) {
      const expiration = element("sharing-expires").value;
      const expiresAt = expiration ? new Date(expiration).getTime() : null;
      if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new Error("Choose a valid expiration time.");
      body.publicOptions = {
        expiresAt, password: element("sharing-password").value || null,
        clearPassword: element("sharing-clear-password").checked,
      };
    }
    const next = await api("/api/projects", { method: "POST", body });
    projects = projects.map((p) => p.id === next.id ? next : p);
    if (activeProject?.id === next.id) activeProject = next;
    renderProjects();
    updateProjectControls();
    void pollDocumentParticipation();
    sharingTarget.project = next;
    element("sharing-password").value = "";
    element("sharing-clear-password").checked = false;
    element("sharing-clear-password-field").hidden = !next.publicLinks?.[path]?.passwordRequired;
    if (path && permission.startsWith("public")) renderPublicShareFields();
    else sharingDialog.close();
    documentNotice(path ? "Page sharing updated." : "Project settings updated.", "success");
  } catch (error) { notice(element("sharing-error"), error.message, "error"); }
  finally { element("sharing-save").disabled = false; element("sharing-reset-link").disabled = false; }
}
element("sharing-form").addEventListener("submit", (event) => { event.preventDefault(); void saveSharing(); });
sharingDialog.addEventListener("close", () => { element("sharing-token").value = ""; element("sharing-password").value = ""; });
projectDialog.addEventListener("close", () => { element("project-token").value = ""; });
element("sharing-copy-link").addEventListener("click", async () => {
  const url = new URL(window.location.href);
  url.searchParams.set("project", sharingTarget.project.id);
  if (sharingTarget.path) url.searchParams.set("document", sharingTarget.document);
  else url.searchParams.delete("document");
  url.hash = "";
  try {
    const link = sharingTarget.project.publicLinks?.[sharingTarget.path];
    if (element("sharing-level").value === "publicRead" && !link) throw new Error("Save the permissions to create the public link first.");
    await navigator.clipboard.writeText(link ? publicShareUrl(link.token) : url.href);
    documentNotice(link ? "Public link copied. Anyone with this link can access the document." : "Sharing link copied. Recipients must sign in.", "success");
  } catch (error) { notice(element("sharing-error"), `Could not copy the sharing link: ${error.message}`, "error"); }
});

const publicView = window.location.pathname === "/share";
const publicToken = publicView ? new URL(window.location.href).searchParams.get("share") : null;
let publicWritable = false;
const publicApiPaths = new Set(["session", "document", "preview", "images", "resource", "resources/resolve", "collaboration/join", "collaboration/presence"]);

function scopedApiPath(path, headers) {
  if (publicView) {
    const url = new URL(path, window.location.href);
    const name = url.pathname.replace(/^\/api\/(?:public\/)?/, "");
    if (!publicApiPaths.has(name)) throw new ApiError("This action is unavailable from a public document.", 403);
    url.pathname = `/api/public/${name}`;
    headers["X-Notes-Share"] = publicToken ?? "";
    delete headers.Authorization;
    return url.pathname + url.search;
  }
  if (activeProject && !/^\/api\/(?:auth|admin|projects|preferences|appearance|resource)(?:\/|[?]|$)/.test(path)) {
    headers["X-Notes-Project"] = activeProject.id;
  }
  if (authMode === "users" && authUser?.id) headers["X-Notes-User"] = authUser.id;
  return path;
}

async function connectPublic(password) {
  token = null;
  authMode = "public";
  authUser = null;
  hideAuthentication();
  stopAppearancePolling();
  notice(ui.treeMessage, "");
  notice(ui.treeLimit, "");
  setSidebar(false);
  updateProjectControls();
  connectionState = "connecting";
  refreshControls();
  try {
    if (!/^[a-f0-9]{64}$/i.test(publicToken ?? "")) throw new ApiError("Open a valid public document link.", 403);
    const session = await api("/api/public/session", { method: "POST", ...(password !== undefined ? { body: { password } } : {}) });
    if (session.passwordRequired) {
      publicWritable = false;
      connectionState = "error";
      requestPublicPassword();
      return;
    }
    if (!isResourceId(session.id) || typeof session.path !== "string" || typeof session.writable !== "boolean") {
      throw new ApiError("The service returned an incomplete public document.");
    }
    publicWritable = session.writable;
    element("public-password-dialog").close();
    element("public-password").value = "";
    currentRoot = "Public document";
    connectionState = "ready";
    if (!activeDocument) {
      rememberResource(session, session.project ?? "local");
      const url = makeNoteUrl(window.location.href, session.id, window.location.hash);
      await navigateTo(session.id, url.hash, { url, mode: "replace" });
    } else {
      notice(ui.connectionMessage, "");
      if (collaboration) await connectCollaboration(collaboration);
    }
  } catch (error) {
    publicWritable = false;
    connectionState = "error";
    notice(ui.connectionMessage, error.message, "error");
    if (error.status === 401) {
      requestPublicPassword();
      notice(element("public-password-error"), error.message, "error");
    }
  } finally { refreshControls(); }
}

function requestPublicPassword() {
  notice(element("public-password-error"), "");
  if (!element("public-password-dialog").open) element("public-password-dialog").showModal();
  element("public-password").focus();
}
element("public-password-cancel").addEventListener("click", () => element("public-password-dialog").close());
element("public-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  element("public-password-submit").disabled = true;
  try { await connectPublic(element("public-password").value); }
  finally { element("public-password-submit").disabled = false; element("public-password").value = ""; }
});

function publicShareUrl(token) {
  const url = new URL("/share", window.location.href);
  url.searchParams.set("share", token);
  return url.href;
}

function renderPublicShareFields() {
  const path = sharingTarget?.path;
  const publicSelected = Boolean(path && element("sharing-level").value === "publicRead");
  element("sharing-public-fields").hidden = !publicSelected;
  const link = path ? sharingTarget.project.publicLinks?.[path] : null;
  element("sharing-public-url").value = link ? publicShareUrl(link.token) : "";
  element("sharing-reset-link").hidden = !publicSelected || !link;
}

element("sharing-level").addEventListener("change", renderPublicShareFields);
element("sharing-reset-link").addEventListener("click", async () => {
  if (!window.confirm("Reset this public link? Existing links and guest connections will stop working.")) return;
  await saveSharing(true);
});
element("sharing-clear-password").addEventListener("change", () => {
  element("sharing-password").disabled = element("sharing-clear-password").checked;
  if (element("sharing-clear-password").checked) element("sharing-password").value = "";
});

async function openShareCenter() {
  closeMenus();
  const dialog = element("shares-dialog");
  if (!dialog.open) dialog.showModal();
  notice(element("shares-message"), "Loading public links…");
  try {
    const links = await api("/api/shares");
    element("shares-list").replaceChildren(...links.map((link) => {
      const row = document.createElement("div");
      const name = document.createElement("span");
      name.className = "workspace-item-name";
      name.textContent = `${link.projectName} / ${link.path}`;
      const details = document.createElement("small");
      details.textContent = `${link.access === "edit" ? "Anonymous editing" : "Read only"} · ${link.passwordRequired ? "Password protected" : "No password"} · ${
        link.expiresAt ? `${link.expiresAt <= Date.now() ? "Expired" : "Expires"} ${new Date(link.expiresAt).toLocaleString()}` : "No expiration"}`;
      name.append(details);
      const manage = document.createElement("button");
      manage.type = "button";
      manage.textContent = "Manage";
      manage.addEventListener("click", async () => {
        try {
          await loadProjects();
          const project = projects.find((project) => project.id === link.project);
          if (!project?.owned) throw new Error("This project is no longer available.");
          dialog.close();
          openSharing(project, link.path, link.document);
        } catch (error) { notice(element("shares-message"), error.message, "error"); }
      });
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(publicShareUrl(link.token)); documentNotice("Public link copied.", "success"); }
        catch (error) { notice(element("shares-message"), error.message, "error"); }
      });
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        if (!window.confirm(`Revoke the public link for ${link.path}? Signed-in user permissions will be retained.`)) return;
        revoke.disabled = true;
        try {
          const updated = await api("/api/projects", { method: "POST", body: {
            action: "revokePublic", id: link.project, document: link.document,
          } });
          if (activeProject?.id === updated.id) activeProject = updated;
          await loadProjects();
          if (dialog.open) await openShareCenter();
        } catch (error) { notice(element("shares-message"), error.message, "error"); revoke.disabled = false; }
      });
      row.append(name, manage, copy, revoke);
      return row;
    }));
    notice(element("shares-message"), links.length ? "" : "You have no public document links.");
  } catch (error) { notice(element("shares-message"), error.message, "error"); }
}
element("shares-open").addEventListener("click", () => void openShareCenter());
element("shares-close").addEventListener("click", () => element("shares-dialog").close());

const searchDialog = element("search-dialog");
let searchTimer = null;
let searchController = null;
let searchGeneration = 0;
let searchTags = [];
let searchResults = [];
let searchSelection = 0;

async function openWorkspaceSearch({ tags = [] } = {}) {
  if (authMode !== "users") {
    documentNotice("Library search requires a signed-in account.", "warning");
    return;
  }
  closeMenus();
  searchTags = [...tags];
  element("search-query").value = "";
  element("search-project").replaceChildren(new Option("All projects", ""), ...projects.map((project) => new Option(project.name, project.id)));
  element("search-project").value = activeProject?.id ?? "";
  renderSearchTags([]);
  if (!searchDialog.open) searchDialog.showModal();
  element("search-query").focus();
  await runWorkspaceSearch(0, true);
}

function renderSearchTags(facets) {
  element("search-selected-tags").replaceChildren(...searchTags.map((tag) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${tag} ×`;
    button.setAttribute("aria-label", `Remove tag filter ${tag}`);
    button.addEventListener("click", () => { searchTags = searchTags.filter((value) => value !== tag); void runWorkspaceSearch(); });
    return button;
  }));
  element("search-tags").replaceChildren(...facets.map(({ tag, count }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${tag} · ${count}`;
    const selected = searchTags.some((value) => value.toLowerCase() === tag.toLowerCase());
    button.setAttribute("aria-pressed", String(selected));
    button.addEventListener("click", () => {
      const active = searchTags.some((value) => value.toLowerCase() === tag.toLowerCase());
      searchTags = active ? searchTags.filter((value) => value.toLowerCase() !== tag.toLowerCase()) : [...searchTags, tag];
      void runWorkspaceSearch();
    });
    return button;
  }));
}

function highlightedSnippet(value, query) {
  const fragment = document.createDocumentFragment();
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))];
  if (!terms.length) { fragment.append(value); return fragment; }
  const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
  let from = 0;
  for (const match of value.matchAll(pattern)) {
    fragment.append(value.slice(from, match.index));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    fragment.append(mark);
    from = match.index + match[0].length;
  }
  fragment.append(value.slice(from));
  return fragment;
}

function renderSearchResults(results, labels) {
  searchResults = results;
  searchSelection = Math.min(searchSelection, Math.max(0, results.length - 1));
  element("search-results").replaceChildren(...results.map((result, index) => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.index = String(index);
    button.setAttribute("aria-selected", String(index === searchSelection));
    const title = document.createElement("strong");
    title.textContent = result.title;
    const location = document.createElement("small");
    location.textContent = `${labels.get(result.project) ?? result.project} / ${result.path}`;
    const snippet = document.createElement("span");
    snippet.className = "search-snippet";
    snippet.append(highlightedSnippet(result.snippet, element("search-query").value));
    button.append(title, location, snippet);
    button.addEventListener("click", () => void openSearchResult(index));
    row.append(button);
    return row;
  }));
  element("search-empty").hidden = results.length > 0;
}

async function runWorkspaceSearch(cursor = 0, refresh = false) {
  clearTimeout(searchTimer);
  searchController?.abort();
  if (!searchDialog.open) return;
  const controller = new AbortController();
  searchController = controller;
  const generation = ++searchGeneration;
  const query = element("search-query").value;
  notice(element("search-message"), "Searching notes…");
  try {
    const result = await api("/api/search", { method: "POST", signal: controller.signal, body: {
      query, project: element("search-project").value || null, field: element("search-field").value,
      tags: searchTags, cursor, refresh,
    } });
    if (generation !== searchGeneration || !searchDialog.open) return;
    if (!Array.isArray(result.results) || !Array.isArray(result.tags) || !Array.isArray(result.projects)) {
      throw new ApiError("The search response is incomplete.");
    }
    renderSearchTags(result.tags);
    renderSearchResults(result.results, new Map(result.projects.map((project) => [project.id, project.name])));
    const message = result.warnings?.join("\n") || (result.indexing ? "Indexing notes; results are updating…"
      : result.truncated ? "Showing a limited set of results. Narrow the query or tags." : "");
    notice(element("search-message"), message, result.warnings?.length ? "warning" : "");
    if (result.indexing) searchTimer = setTimeout(() => void runWorkspaceSearch(result.cursor), 350);
  } catch (error) {
    if (!aborted(error) && generation === searchGeneration) notice(element("search-message"), error.message, "error");
  }
}

async function openSearchResult(index) {
  const result = searchResults[index];
  if (!result) return;
  searchDialog.close();
  if (activeProject?.id !== result.project) {
    await loadProjects();
    const url = new URL(window.location.href);
    url.searchParams.set("project", result.project);
    url.searchParams.set("document", result.id);
    url.hash = "";
    await switchProject(result.project, { url });
    return;
  }
  if (!await navigateTo(result.id)) return;
  if (activeDocument?.version !== result.version) return;
  if (ui.panes.dataset.view === "rich") {
    if (element("rich-editor").getAttribute("aria-busy") === "true") pendingHeading = result.offset;
    else inlineEditor.jumpTo(result.offset);
  } else if (ui.panes.dataset.view !== "preview") {
    ui.editor.focus();
    ui.editor.setSelectionRange(result.offset, result.offset);
  }
}

element("workspace-search-open").addEventListener("click", () => void openWorkspaceSearch());
element("search-close").addEventListener("click", () => searchDialog.close());
searchDialog.addEventListener("close", () => { clearTimeout(searchTimer); searchController?.abort(); searchGeneration += 1; });
element("search-query").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchController?.abort();
  searchGeneration += 1;
  notice(element("search-message"), "Searching notes…");
  searchTimer = setTimeout(() => void runWorkspaceSearch(), 200);
});
for (const id of ["search-project", "search-field"]) element(id).addEventListener("change", () => void runWorkspaceSearch());
element("search-form").addEventListener("submit", (event) => { event.preventDefault(); void openSearchResult(searchSelection); });
element("search-query").addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key) || !searchResults.length) return;
  event.preventDefault();
  searchSelection = (searchSelection + (event.key === "ArrowDown" ? 1 : -1) + searchResults.length) % searchResults.length;
  for (const button of element("search-results").querySelectorAll("button")) {
    button.setAttribute("aria-selected", String(Number(button.dataset.index) === searchSelection));
  }
  element("search-results").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "p" && authMode === "users") {
    event.preventDefault();
    void openWorkspaceSearch();
  }
});

let fileFilterFrame = null;
let selectedFileButton = null;
let treeRefreshTimer = null;

function scheduleTreeRefresh() {
  window.clearTimeout(treeRefreshTimer);
  treeRefreshTimer = null;
  if (!webPreferences.treeRefreshSeconds || connectionState !== "ready"
      || document.visibilityState === "hidden") return;
  treeRefreshTimer = window.setTimeout(
    () => void refreshFiles(),
    webPreferences.treeRefreshSeconds * 1000,
  );
}

function scheduleFileFilterRender() {
  if (fileFilterFrame !== null) return;
  fileFilterFrame = window.requestAnimationFrame(() => {
    fileFilterFrame = null;
    renderFiles();
  });
}

function renderTreeStatus(
  libraryFiles = visibleLibraryFiles(),
  visible = filterNotes(libraryFiles, ui.filter.value),
) {
  let message = treeError;
  if (treeLoading) message = treeLoaded ? "Refreshing the file list…" : "Loading Markdown files…";
  else if (!message && treeLoaded && libraryFiles.length === 0) {
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
  if (fileFilterFrame !== null) {
    window.cancelAnimationFrame(fileFilterFrame);
    fileFilterFrame = null;
  }
  const filtering = Boolean(ui.filter.value.trim());
  const libraryFiles = visibleLibraryFiles();
  const visible = filterNotes(libraryFiles, ui.filter.value);
  const tree = buildFileTree(
    visible,
    filtering ? [] : visibleLibraryDirectories(),
  );
  let nextSelectedFileButton = null;
  function appendBranch(branch, list) {
    for (const directory of branch.directories) {
      const item = document.createElement("li");
      const details = document.createElement("details");
      details.className = "directory";
      details.dataset.path = directory.path;
      details.open = filtering || !collapsedFolders.has(directory.path);
      const summary = document.createElement("summary");
      summary.draggable = true;
      summary.dataset.entryPath = directory.path;
      summary.dataset.entryKind = "directory";
      summary.dataset.directoryPath = directory.path;
      summary.title = directory.path;
      const label = document.createElement("span");
      label.className = "directory-label";
      label.textContent = directory.title ?? directory.name;
      const actions = document.createElement("span");
      actions.className = "directory-actions";
      const action = (type, title, path) => {
        const button = document.createElement("button");
        button.type = "button";
        button.title = title;
        button.setAttribute("aria-label", `${title} in ${directory.title ?? directory.name}`);
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 20 20");
        svg.setAttribute("aria-hidden", "true");
        const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
        shape.setAttribute("d", path);
        svg.append(shape);
        button.append(svg);
        button.addEventListener("pointerdown", (event) => event.stopPropagation());
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (type === "note") openNewNote(directory.path);
          else openNewFolder(directory.path);
        });
        return button;
      };
      actions.append(
        action("note", "New note", "M5 3.5h7l3 3v10H5zM12 3.5v3h3M10 9v5M7.5 11.5h5"),
        action("folder", "New folder", "M2.5 5.5h6l1.5 2h7.5v9h-15zM13.5 9.5v4M11.5 11.5h4"),
      );
      summary.append(label, actions);
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
      button.draggable = true;
      button.dataset.path = file.path;
      button.dataset.entryPath = file.path;
      button.dataset.entryKind = "file";
      button.title = file.path;
      button.setAttribute("aria-label", file.path);
      if (activeDocument?.path === file.path && !rootChanged()) {
        button.setAttribute("aria-current", "page");
        nextSelectedFileButton = button;
      }
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = file.title ?? file.name;
      button.append(name);
      item.append(button);
      list.append(item);
    }
  }
  const fragment = document.createDocumentFragment();
  appendBranch(tree, fragment);
  ui.fileList.replaceChildren(fragment);
  selectedFileButton = nextSelectedFileButton;
  renderTreeStatus(libraryFiles, visible);
}

function reconcileFileTree(previousFiles, previousDirectories) {
  if (ui.filter.value.trim()) return false;
  const libraryFiles = visibleLibraryFiles();
  const libraryDirectories = visibleLibraryDirectories();
  const fileNodes = new Map([...ui.fileList.querySelectorAll("button[data-path]")]
    .map((button) => [button.dataset.path, button]));
  const directoryNodes = new Map([...ui.fileList.querySelectorAll("details.directory[data-path]")]
    .map((details) => [details.dataset.path, details]));
  if (fileNodes.size !== libraryFiles.length
      || directoryNodes.size !== libraryDirectories.length) return false;
  const tree = buildFileTree(libraryFiles, libraryDirectories);
  const valid = (branch) => branch.files.every((file) => fileNodes.has(file.path))
    && branch.directories.every((directory) => {
      const details = directoryNodes.get(directory.path);
      return details?.lastElementChild?.classList.contains("file-branch") && valid(directory);
    });
  if (!valid(tree)) return false;
  if (fileFilterFrame !== null) {
    window.cancelAnimationFrame(fileFilterFrame);
    fileFilterFrame = null;
  }
  for (let index = 0; index < files.length; index += 1) {
    if ((previousFiles[index].title ?? null) === (files[index].title ?? null)) continue;
    const label = fileNodes.get(files[index].path)?.querySelector(".file-name");
    if (label) label.textContent = files[index].title ?? files[index].name;
  }
  for (let index = 0; index < directories.length; index += 1) {
    if ((previousDirectories[index].title ?? null) === (directories[index].title ?? null)) continue;
    const details = directoryNodes.get(directories[index].path);
    if (!details) continue;
    const display = directories[index].title ?? directories[index].name;
    const label = details.querySelector(":scope > summary .directory-label");
    if (label) label.textContent = display;
    for (const button of details.querySelectorAll(":scope > summary .directory-actions button")) {
      button.setAttribute("aria-label", `${button.title} in ${display}`);
    }
  }
  const reorder = (branch, list) => {
    let cursor = list.firstElementChild;
    const place = (item) => {
      if (item === cursor) cursor = cursor.nextElementSibling;
      else list.insertBefore(item, cursor);
    };
    for (const directory of branch.directories) {
      const details = directoryNodes.get(directory.path);
      place(details.parentElement);
      reorder(directory, details.lastElementChild);
    }
    for (const file of branch.files) place(fileNodes.get(file.path).parentElement);
  };
  reorder(tree, ui.fileList);
  return true;
}

function updateFileSelection() {
  const path = activeDocument && !rootChanged() ? activeDocument.path : null;
  if (selectedFileButton?.isConnected && selectedFileButton.dataset.path === path) {
    revealFileButton(selectedFileButton);
    return;
  }
  const next = path
    ? ui.fileList.querySelector(`button[data-path="${CSS.escape(path)}"]`)
    : null;
  if (selectedFileButton && selectedFileButton !== next) {
    selectedFileButton.removeAttribute("aria-current");
  }
  selectedFileButton = next;
  if (!selectedFileButton) return;
  selectedFileButton.setAttribute("aria-current", "page");
  revealFileButton(selectedFileButton);
}

function revealFileButton(button) {
  button.setAttribute("aria-current", "page");
  let parent = button.parentElement;
  while (parent && parent !== ui.fileList) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
}

function updateFileTitle(path, title) {
  const file = files.find((candidate) => candidate.path === path);
  const next = title || null;
  if (!file || file.title === next) return;
  file.title = next;
  renderFiles();
  updateFileSelection();
}

async function refreshFiles() {
  window.clearTimeout(treeRefreshTimer);
  treeRefreshTimer = null;
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
        || !Array.isArray(result.directories)
        || result.files.some((file) => typeof file?.path !== "string" || typeof file?.name !== "string"
          || (file.title !== undefined && typeof file.title !== "string"))
        || result.directories.some((directory) => typeof directory?.path !== "string"
          || typeof directory?.name !== "string"
          || (directory.title !== undefined && typeof directory.title !== "string"))) {
      throw new ApiError("The service returned an incomplete file list.");
    }
    setRoot(result.root);
    const nextFiles = result.files.map((file) => ({
      path: normalizeNotePath(file.path), name: file.name, title: file.title ?? null,
    }));
    const nextDirectories = result.directories.map((directory) => ({
      path: normalizeNotePath(directory.path), name: directory.name, title: directory.title ?? null,
    }));
    const structureChanged = !sameTreeStructure(files, nextFiles)
      || !sameTreeStructure(directories, nextDirectories);
    const changed = structureChanged || !sameTreeEntries(files, nextFiles)
      || !sameTreeEntries(directories, nextDirectories);
    const previousFiles = files;
    const previousDirectories = directories;
    files = nextFiles;
    directories = nextDirectories;
    treeLoaded = true;
    treeError = "";
    treeTruncated = Boolean(result.truncated);
    if (changed) {
      if (structureChanged || !reconcileFileTree(previousFiles, previousDirectories)) {
        renderFiles();
      }
      updateFileSelection();
    }
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
      scheduleTreeRefresh();
    }
  }
}

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

let attachmentEntries = [];
let attachmentScanTruncated = false;
async function loadAttachments() {
  notice(element("attachments-message"), "Checking Markdown references…");
  try {
    const result = await api("/api/attachments");
    attachmentEntries = result.files;
    attachmentScanTruncated = result.truncated;
    renderAttachments();
    notice(element("attachments-message"), result.truncated ? "The scan was limited. Recycling is disabled until the complete project can be checked." : "", result.truncated ? "warning" : "");
  } catch (error) { notice(element("attachments-message"), error.message, "error"); }
}
function renderAttachments() {
  const entries = attachmentEntries.filter((entry) => !element("attachments-unused").checked || !entry.referenced);
  element("attachments-list").replaceChildren(...entries.map((entry) => {
    const row = document.createElement("div");
    const select = document.createElement("input");
    select.type = "checkbox";
    select.dataset.path = entry.path;
    select.disabled = entry.referenced || entry.size > 16 * 1024 * 1024 || attachmentScanTruncated;
    select.setAttribute("aria-label", `Select ${entry.path}`);
    const name = document.createElement("span");
    name.className = "workspace-item-name";
    name.textContent = entry.path;
    const details = document.createElement("small");
    details.textContent = `${formatByteCount(entry.size)} · ${entry.referenced ? "Referenced by Markdown" : "No saved Markdown reference"}`;
    name.append(details);
    row.append(select, name);
    return row;
  }));
  element("attachments-recycle").disabled = attachmentScanTruncated;
}
element("attachments-open").addEventListener("click", () => { closeMenus(); element("attachments-dialog").showModal(); void loadAttachments(); });
element("attachments-close").addEventListener("click", () => element("attachments-dialog").close());
element("attachments-unused").addEventListener("change", renderAttachments);
element("attachments-refresh").addEventListener("click", () => void loadAttachments());
element("attachments-recycle").addEventListener("click", async () => {
  const paths = new Set([...element("attachments-list").querySelectorAll("input:checked")].map((input) => input.dataset.path));
  const files = attachmentEntries.filter((entry) => paths.has(entry.path)).map(({ id, stamp }) => ({ id, stamp }));
  if (!files.length) { notice(element("attachments-message"), "Select attachments to recycle."); return; }
  if (!window.confirm(`Recycle ${files.length} selected attachments? Other programs or offline drafts may still reference them. They remain recoverable for 30 days.`)) return;
  element("attachments-recycle").disabled = true;
  try {
    await api("/api/attachments", { method: "POST", body: { files } });
    await loadAttachments();
    documentNotice("Selected attachments moved to the recycle bin.", "success");
  } catch (error) { notice(element("attachments-message"), error.message, "error"); }
  finally { element("attachments-recycle").disabled = attachmentScanTruncated; }
});

element("backlinks-open").addEventListener("click", async () => {
  if (!activeDocument || publicView) return;
  closeMenus();
  const id = documentId;
  const project = activeProject?.id;
  element("backlinks-list").replaceChildren();
  element("backlinks-dialog").showModal();
  notice(element("backlinks-message"), "Finding references…");
  try {
    const references = await api(`/api/backlinks?document=${encodeURIComponent(activeDocument.id)}`);
    if (id !== documentId || project !== activeProject?.id) return;
    element("backlinks-list").replaceChildren(...references.map((reference) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = reference.title ?? reference.path;
      button.title = reference.path;
      button.addEventListener("click", () => {
        element("backlinks-dialog").close();
        void navigateTo(reference.id);
      });
      return button;
    }));
    notice(element("backlinks-message"), references.length ? "" : "No accessible notes link to this document.");
  } catch (error) { notice(element("backlinks-message"), error.message, "error"); }
});
element("backlinks-close").addEventListener("click", () => element("backlinks-dialog").close());

let documentParticipation = null;

function stopDocumentParticipation() {
  const current = documentParticipation;
  documentParticipation = null;
  if (!current) return;
  clearTimeout(current.timer);
  current.controller?.abort();
  if (current.participant) {
    void api("/api/collaboration/presence", {
      method: "POST", keepalive: true, body: { document: current.resource, participant: current.participant, leave: true },
    }).catch((error) => console.warn("Document participation will expire after disconnect.", error.message));
  }
}

async function startDocumentParticipation() {
  if (!activeDocument || authMode !== "users" && !publicView) { void recoverDocumentDraft(); return; }
  const current = {
    id: documentId, resource: activeDocument.id, path: activeDocument.path, participant: null, ready: false,
    preparing: false, composing: false, timer: null, controller: null, polling: false, recoveryRecord: null,
  };
  documentParticipation = current;
  await recoverDocumentDraft();
  if (current === documentParticipation) void pollDocumentParticipation(current);
}

async function pollDocumentParticipation(current = documentParticipation) {
  if (!current || current !== documentParticipation || current.polling) return;
  clearTimeout(current.timer);
  current.polling = true;
  current.controller = new AbortController();
  let delay = 1000;
  try {
    const status = await api("/api/collaboration/presence", {
      method: "POST", signal: current.controller.signal,
      body: { document: current.resource, participant: current.participant, ready: current.ready },
    });
    if (current !== documentParticipation || current.id !== documentId) return;
    if (!["solo", "prepare", "join"].includes(status.phase)
        || status.participant !== null && !/^[a-f0-9]{48}$/.test(status.participant ?? "")) {
      throw new ApiError("The service returned incomplete document participation.");
    }
    current.participant = status.participant;
    const wasPreparing = current.preparing;
    const previousCollaboration = collaboration;
    const permissionsChanged = acceptDocumentPermissions(status.permissions);
    let prepared = false;
    if (!documentPermissions.collaborative) {
      delay = 3000;
      current.ready = false;
      current.preparing = false;
      if (collaboration) {
        await persistCurrentDraft();
        if (current !== documentParticipation) return;
        stopCollaboration();
        collaborationNotice("Shared editing permission was removed. Any unsaved local text is kept.", true);
      }
    } else if (status.phase === "solo" && !collaboration) {
      current.ready = false;
      current.preparing = false;
      collaborationNotice(current.recoveryRecord
        ? "A local collaborative draft is kept. It will merge when shared editing resumes." : "");
    } else if (status.phase === "prepare" && collaboration?.initialized) {
      current.ready = true;
    } else if (status.phase === "prepare" && !collaboration && !current.ready && !current.composing
        && !conflict && !element("draft-recovery-dialog").open) {
      prepared = true;
      current.preparing = true;
      refreshControls();
      await persistCurrentDraft();
      if (current !== documentParticipation) return;
      if (current.recoveryRecord && dirty()) {
        showDraftRecovery(current.recoveryRecord);
        current.preparing = false;
        refreshControls();
        return;
      }
      if (dirty() && !pendingSave && !conflict) await saveDocument(true);
      if (current !== documentParticipation) return;
      current.ready = !dirty() && !pendingSave && !conflict;
      if (!current.ready) current.preparing = false;
      collaborationNotice(current.ready
        ? "Another authorized editor is here. Waiting for saved drafts before shared editing…"
        : "Shared editing is waiting. Save or resolve this local draft first.", !current.ready);
      delay = current.ready ? 150 : 1000;
    } else if (status.phase === "join") {
      current.preparing = false;
      if (!collaboration) await startCollaboration();
      else if (!collaboration.connected && !collaboration.connecting && !collaboration.unmerged && !collaboration.failed) {
        await connectCollaboration(collaboration);
      }
    }
    if (prepared || permissionsChanged || wasPreparing !== current.preparing || previousCollaboration !== collaboration) {
      renderCollaborators();
      refreshControls();
    }
  } catch (error) {
    if (current !== documentParticipation || aborted(error)) return;
    current.ready = false;
    current.preparing = false;
    if (error.status === 410) {
      current.participant = null;
      collaborationNotice("Document presence expired; reconnecting…");
      refreshControls();
      delay = 150;
      return;
    }
    if ([401, 403, 404].includes(error.status)) {
      acceptDocumentPermissions({ writable: false, collaborative: false, owner: false });
      if (collaboration) {
        await persistCurrentDraft().catch((failure) => console.error("Could not persist the revoked session's draft.", failure));
        if (current !== documentParticipation) return;
        stopCollaboration();
      }
      if (publicView && error.status === 401) requestPublicPassword();
    }
    collaborationNotice(`Document access could not be refreshed: ${error.message} Local text is kept.`, true);
    refreshControls();
    delay = 3000;
  } finally {
    current.polling = false;
    if (current === documentParticipation) current.timer = setTimeout(() => void pollDocumentParticipation(current), delay);
  }
}

document.addEventListener("compositionstart", (event) => {
  if (documentParticipation && collaborativeTarget(event.target)) documentParticipation.composing = true;
});
document.addEventListener("compositionend", (event) => {
  if (documentParticipation && collaborativeTarget(event.target)) {
    const current = documentParticipation;
    setTimeout(() => { if (current === documentParticipation) current.composing = false; }, 0);
  }
});
window.addEventListener("focus", () => void pollDocumentParticipation());
window.addEventListener("pagehide", stopDocumentParticipation);

const gitUi = {
  tab: element("git-tab"),
  panel: element("git-panel"),
  branch: element("git-branch"),
  sync: element("git-sync-state"),
  ahead: element("git-ahead"),
  behind: element("git-behind"),
  refresh: element("git-refresh"),
  message: element("git-message"),
  files: element("git-file-list"),
  empty: element("git-empty"),
  pull: element("git-pull"),
  push: element("git-push"),
  commitForm: element("git-commit-form"),
  commitMessage: element("git-commit-message"),
  commit: element("git-commit"),
  stagedCount: element("git-staged-count"),
  commitHint: element("git-commit-hint"),
  diffDialog: element("git-diff-dialog"),
  diffTitle: element("git-diff-title"),
  diffPath: element("git-diff-path"),
  diffContent: element("git-diff-content"),
  diffClose: element("git-diff-close"),
  diffWorking: element("git-diff-working"),
  diffStaged: element("git-diff-staged"),
};

attachScrollbars(element("git-scroll-frame"), element("git-scroll"), { horizontal: false });
let gitStatus = null;
let gitLoading = false;
let gitRefreshTimer = null;
let gitDiffPath = null;
let gitDiffStaged = false;
let gitDiffSequence = 0;
let gitFilesSignature = null;
const collapsedGitGroups = new Set();

function validateGitStatus(value) {
  if (!value || typeof value.available !== "boolean" || typeof value.repository !== "boolean"
      || typeof value.clean !== "boolean" || !Array.isArray(value.files)
      || value.files.some((file) => typeof file?.path !== "string"
        || typeof file.indexStatus !== "string" || typeof file.worktreeStatus !== "string")) {
    throw new ApiError("The service returned incomplete Git status.");
  }
  return value;
}

function gitMessage(text, state = "") {
  notice(gitUi.message, text, state);
  gitUi.message.dataset.state = state;
}

function gitCount(element, count) {
  setText(element, String(count));
  element.hidden = !count;
}

function isGitStaged(file) {
  return ![".", "?", "U"].includes(file.indexStatus) && file.worktreeStatus !== "U";
}

function gitIcon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(svg.namespaceURI, "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function gitFileRow(file, staged) {
  const code = staged ? file.indexStatus : file.worktreeStatus;
  const description = {
    "?": "Untracked", M: "Modified", A: "Added", D: "Deleted",
    R: "Renamed", C: "Copied", U: "Conflict", T: "Type changed",
  }[code] ?? code;
  const item = document.createElement("li");
  item.dataset.path = file.path;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "git-file-open";
  open.dataset.gitDiffPath = file.path;
  open.dataset.staged = String(staged);
  open.title = `${file.path}${file.originalPath ? ` (from ${file.originalPath})` : ""}`;
  open.setAttribute("aria-label", `${file.path}, ${description}, ${staged ? "staged" : "working tree"} diff`);
  const state = document.createElement("span");
  state.className = "git-file-state";
  state.dataset.status = code;
  state.textContent = code;
  state.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "git-file-label";
  const name = document.createElement("span");
  name.className = "git-file-name";
  name.textContent = file.path.split("/").at(-1);
  const path = document.createElement("span");
  path.className = "git-file-path";
  path.textContent = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/")) : description;
  label.append(name, path);
  open.append(state, label);
  item.append(open, gitActionButton(staged ? "Unstage" : "Stage", staged ? "unstage" : "stage", file.path));
  return item;
}

function gitGroup(label, files, staged) {
  const group = document.createElement("details");
  group.className = "git-group";
  group.dataset.group = staged ? "staged" : "working";
  group.open = !collapsedGitGroups.has(group.dataset.group);
  const summary = document.createElement("summary");
  const name = document.createElement("span");
  name.textContent = label;
  const count = document.createElement("span");
  count.className = "git-count";
  count.textContent = String(files.length);
  summary.append(name, count);
  const list = document.createElement("ul");
  list.className = "git-file-list";
  list.setAttribute("aria-label", label);
  list.append(...files.map((file) => gitFileRow(file, staged)));
  group.append(summary, list);
  group.addEventListener("toggle", () => {
    if (!group.isConnected) return;
    if (group.open) collapsedGitGroups.delete(group.dataset.group);
    else collapsedGitGroups.add(group.dataset.group);
  });
  return group;
}

function renderGitStatus(status) {
  gitStatus = status;
  setText(gitUi.branch, status.repository
    ? status.branch === "(detached)" ? "Detached HEAD" : status.branch || "Unborn branch"
    : "Source control");
  gitUi.branch.title = gitUi.branch.textContent;
  setText(gitUi.sync, status.upstream ?? (status.repository ? "No upstream configured" : "Local version history"));
  gitUi.sync.title = gitUi.sync.textContent;
  gitCount(gitUi.ahead, status.ahead);
  gitCount(gitUi.behind, status.behind);
  gitMessage(status.message ?? (status.clean ? "Working tree clean." : ""));
  gitUi.empty.hidden = !status.repository || status.files.length > 0 || !status.clean;
  gitUi.commitForm.hidden = !status.repository;
  const signature = JSON.stringify(status.files);
  if (signature !== gitFilesSignature) {
    const staged = status.files.filter(isGitStaged);
    const working = status.files.filter((file) => file.worktreeStatus !== ".");
    const fragment = document.createDocumentFragment();
    if (staged.length) fragment.append(gitGroup("Staged changes", staged, true));
    if (working.length) fragment.append(gitGroup("Changes", working, false));
    gitUi.files.replaceChildren(fragment);
    gitFilesSignature = signature;
  }
  refreshGitControls();
}

function gitActionButton(label, action, path) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "git-file-action";
  button.setAttribute("aria-label", `${label} ${path}`);
  button.title = `${label} ${path}`;
  button.append(gitIcon(action === "stage" ? "M10 4v12M4 10h12" : "M4 10h12"));
  button.dataset.gitAction = action;
  button.dataset.path = path;
  button.disabled = gitLoading;
  return button;
}

function refreshGitControls() {
  const staged = gitStatus?.files.filter(isGitStaged).length ?? 0;
  const unavailable = gitLoading || connectionState !== "ready" || !gitStatus?.repository || !projectOwns();
  gitUi.panel.setAttribute("aria-busy", String(gitLoading));
  gitUi.refresh.disabled = gitLoading || connectionState !== "ready";
  gitUi.pull.disabled = unavailable || !gitStatus?.clean || !gitStatus?.upstream;
  gitUi.push.disabled = unavailable || !gitStatus?.upstream;
  gitUi.commit.disabled = unavailable || !staged || !gitUi.commitMessage.value.trim();
  gitCount(gitUi.stagedCount, staged);
  setText(gitUi.commitHint, staged
    ? `${staged} staged ${staged === 1 ? "file" : "files"} · commits stay local until pushed.`
    : "Stage changes before committing.");
  for (const button of gitUi.files.querySelectorAll("[data-git-action]")) {
    button.disabled = unavailable;
  }
}

function scheduleGitRefresh() {
  window.clearTimeout(gitRefreshTimer);
  gitRefreshTimer = null;
  if (!webPreferences.gitRefreshSeconds || gitUi.panel.hidden || connectionState !== "ready"
      || document.visibilityState === "hidden") return;
  gitRefreshTimer = window.setTimeout(() => void refreshGit(), webPreferences.gitRefreshSeconds * 1000);
}

async function refreshGit() {
  window.clearTimeout(gitRefreshTimer);
  gitRefreshTimer = null;
  if (connectionState !== "ready" || gitLoading || !projectHasGit()) return;
  const generation = projectGeneration;
  gitLoading = true;
  gitMessage("Refreshing Git status…");
  refreshGitControls();
  let next = null;
  try {
    next = validateGitStatus(await api("/api/git"));
    if (generation !== projectGeneration) next = null;
  } catch (error) {
    gitMessage(`Git status failed: ${error.message}`, "error");
    if (error.network) connectionFailure(error);
  } finally {
    gitLoading = false;
    if (next) renderGitStatus(next);
    else refreshGitControls();
    scheduleGitRefresh();
  }
}

async function runGitAction(body) {
  if (!projectOwns()) return;
  if (gitLoading || connectionState !== "ready") return;
  if (body.action === "pull" && (pendingSave || dirty())) {
    gitMessage("Save your current note before pulling.", "error");
    return;
  }
  gitLoading = true;
  gitMessage(`${{ stage: "Staging", unstage: "Unstaging", commit: "Committing", pull: "Pulling", push: "Pushing" }[body.action]}…`);
  refreshGitControls();
  let next = null;
  try {
    next = validateGitStatus(await api("/api/git", { method: "POST", body }));
    if (body.action === "commit") gitUi.commitMessage.value = "";
    void refreshFiles();
  } catch (error) {
    gitMessage(`Git ${body.action} failed: ${error.message}`, "error");
    if (error.network) connectionFailure(error);
  } finally {
    gitLoading = false;
    if (next) renderGitStatus(next);
    else refreshGitControls();
    scheduleGitRefresh();
  }
}

function renderGitDiff(text) {
  const lines = text.split("\n");
  const limit = Math.min(lines.length, 20_000);
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < limit; index += 1) {
    const line = document.createElement("span");
    const value = lines[index];
    line.className = value.startsWith("+") && !value.startsWith("+++")
      ? "is-added" : value.startsWith("-") && !value.startsWith("---")
        ? "is-removed" : value.startsWith("@@") ? "is-hunk" : "";
    line.textContent = value || " ";
    fragment.append(line);
  }
  if (lines.length > limit) {
    const omitted = document.createElement("span");
    omitted.textContent = `\n… ${lines.length - limit} more lines are not displayed.\n`;
    fragment.append(omitted);
  }
  gitUi.diffContent.replaceChildren(fragment);
}

async function openGitDiff(path, staged = webPreferences.gitDefaultDiff === "staged") {
  const sequence = ++gitDiffSequence;
  gitDiffPath = path;
  gitDiffStaged = staged;
  setText(gitUi.diffTitle, staged ? "Staged diff" : "Working tree diff");
  setText(gitUi.diffPath, path);
  gitUi.diffWorking.setAttribute("aria-pressed", String(!staged));
  gitUi.diffStaged.setAttribute("aria-pressed", String(staged));
  gitUi.diffContent.textContent = "Loading diff…";
  if (!gitUi.diffDialog.open) gitUi.diffDialog.showModal();
  try {
    const resource = resourceLocations.get(resourceLocation(activeProject?.id ?? "local", path));
    if (!resource) throw new ApiError("Refresh Git status before opening this resource.");
    const query = new URLSearchParams({ id: resource.id, staged: String(staged) });
    const result = await api(`/api/git/diff?${query}`);
    if (sequence !== gitDiffSequence) return;
    renderGitDiff(result.text || "No textual diff for this file.");
  } catch (error) {
    if (sequence === gitDiffSequence) {
      gitUi.diffContent.textContent = `Could not load diff: ${error.message}`;
    }
  }
}

gitUi.refresh.addEventListener("click", () => void refreshGit());
gitUi.commitMessage.addEventListener("input", refreshGitControls);
gitUi.commitForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = gitUi.commitMessage.value.trim();
  if (message && !gitUi.commit.disabled) void runGitAction({ action: "commit", message });
});
gitUi.files.addEventListener("click", (event) => {
  const action = event.target.closest("[data-git-action]");
  if (action) {
    const resource = resourceLocations.get(resourceLocation(activeProject?.id ?? "local", action.dataset.path));
    if (!resource) { documentNotice("Refresh Git status before changing this resource.", "error"); return; }
    void runGitAction({ action: action.dataset.gitAction, ids: [resource.id] });
    return;
  }
  const open = event.target.closest("[data-git-diff-path]");
  if (open) void openGitDiff(open.dataset.gitDiffPath, open.dataset.staged === "true");
});
gitUi.pull.addEventListener("click", () => {
  if (window.confirm("Pull from the configured upstream using fast-forward only?")) {
    void runGitAction({ action: "pull", confirm: true });
  }
});
gitUi.push.addEventListener("click", () => {
  if (window.confirm("Push committed changes to the configured upstream?")) {
    void runGitAction({ action: "push", confirm: true });
  }
});
gitUi.diffWorking.addEventListener("click", () => void openGitDiff(gitDiffPath, false));
gitUi.diffStaged.addEventListener("click", () => void openGitDiff(gitDiffPath, true));
gitUi.diffClose.addEventListener("click", () => gitUi.diffDialog.close());
gitUi.diffDialog.addEventListener("close", () => {
  gitDiffSequence += 1;
  gitDiffPath = null;
  gitUi.diffContent.replaceChildren();
});

const collaborationUi = {
  people: element("collaboration-people"),
  join: element("collaboration-join"),
  message: element("collaboration-message"),
  cursors: element("collaboration-cursors"),
};
const peerColors = 12;
let cursorFrame = null;

function collaborationNotice(message, error = false) {
  notice(collaborationUi.message, message, error ? "warning" : "");
}

function renderCollaborators() {
  const current = collaboration;
  const preparing = Boolean(documentParticipation?.preparing);
  collaborationUi.join.hidden = !activeDocument || !current && !preparing && (authMode === "users" || publicView);
  collaborationUi.join.disabled = Boolean(current?.connecting);
  collaborationUi.join.title = current?.connected ? "Leave collaborative editing after saving" : "Join this note's collaborative session";
  setText(collaborationUi.join, current?.connected ? "Sharing" : current ? "Reconnect" : preparing ? "Preparing" : "Collaborate");
  collaborationUi.people.replaceChildren();
  const users = current?.users ?? [];
  const limit = compactLayout.matches ? 2 : 5;
  for (const user of users.slice(0, limit)) {
    const avatar = document.createElement("span");
    avatar.className = `collaboration-avatar peer-color-${user.color % peerColors}`;
    avatar.dataset.peer = user.id;
    avatar.setAttribute("role", "img");
    avatar.setAttribute("aria-label", `${user.name}${user.id === current.me?.id ? " (you)" : ""}`);
    avatar.title = `${user.name}${user.id === current.me?.id ? " (you)" : ""} · ${user.cursor?.mode ?? "online"}`;
    avatar.textContent = user.name.slice(0, 2).toUpperCase();
    collaborationUi.people.append(avatar);
  }
  if (users.length > limit) {
    const more = document.createElement("span");
    more.className = "collaboration-avatar";
    more.textContent = `+${users.length - limit}`;
    more.title = users.slice(limit).map((user) => user.name).join(", ");
    collaborationUi.people.append(more);
  }
  schedulePeerCursors();
}

function collaborativeSelection() {
  const mode = ui.panes.dataset.view;
  if (mode === "rich") return inlineEditor.getSelection();
  if (mode === "editor" || mode === "split") return ui.editor.getSelection();
  return null;
}

function drawPeerCursors() {
  cursorFrame = null;
  const current = collaboration;
  const mode = ui.panes.dataset.view;
  const fragment = document.createDocumentFragment();
  if (current?.connected && mode !== "preview") {
    const viewport = mode === "rich"
      ? element("rich-editor").getBoundingClientRect() : ui.editor.viewportRect();
    for (const user of current.users) {
      if (user.id === current.me?.id || !user.cursor) continue;
      const selection = current.shared.resolve(user.cursor);
      if (!selection) continue;
      const rect = mode === "rich" ? inlineEditor.cursorRect(selection.to) : ui.editor.cursorRect(selection.to);
      if (!rect || rect.top < viewport.top || rect.bottom > viewport.bottom
          || rect.left < viewport.left || rect.left > viewport.right) continue;
      const cursor = document.createElement("span");
      cursor.className = `collaboration-caret peer-color-${user.color % peerColors}`;
      cursor.dataset.peer = user.id;
      cursor.setAttribute("aria-hidden", "true");
      cursor.style.left = `${rect.left}px`;
      cursor.style.top = `${rect.top}px`;
      cursor.style.height = `${Math.max(14, rect.bottom - rect.top)}px`;
      const name = document.createElement("span");
      name.className = "collaboration-caret-name";
      name.textContent = user.name;
      cursor.append(name);
      fragment.append(cursor);
    }
  }
  collaborationUi.cursors.replaceChildren(fragment);
}

function schedulePeerCursors() {
  if (cursorFrame === null) cursorFrame = requestAnimationFrame(drawPeerCursors);
}

function publishCollaborativeCursor() {
  const current = collaboration;
  if (!current?.connected || current.socket?.readyState !== WebSocket.OPEN || current.applying || current.composing) return;
  current.selection = current.shared.relative(collaborativeSelection());
  const cursor = current.selection ? { ...current.selection, mode: ui.panes.dataset.view } : null;
  const signature = JSON.stringify(cursor);
  if (signature === current.cursorSignature) return;
  current.cursorSignature = signature;
  current.socket.send(JSON.stringify({ type: "cursor", cursor }));
}

document.addEventListener("selectionchange", () => {
  publishCollaborativeCursor();
  schedulePeerCursors();
});
document.addEventListener("scroll", schedulePeerCursors, true);
window.addEventListener("resize", renderCollaborators);
collaborationUi.join.addEventListener("click", () => {
  if (documentParticipation?.preparing && !collaboration) {
    stopDocumentParticipation();
    collaborationNotice("Automatic collaboration paused for this document. Reopen it to watch for editors.");
    renderCollaborators();
    refreshControls();
    return;
  }
  if (collaboration?.connected) {
    if (dirty() || collaboration.pending.size || collaboration.saving) {
      collaborationNotice("Save all shared changes before leaving collaboration.", true);
      saveCollaboration();
      return;
    }
    stopDocumentParticipation();
    stopCollaboration();
    refreshControls();
  } else if (collaboration) void connectCollaboration(collaboration);
  else void startCollaboration();
});

let collaboration = null;

function collaborationLocked() {
  return Boolean(documentParticipation?.preparing
    || collaboration && (!collaboration.initialized || collaboration.connecting || collaboration.applying));
}

function stopCollaboration() {
  const old = collaboration;
  if (old) void persistCurrentDraft().catch(console.error);
  collaboration = null;
  if (old) {
    old.closed = true;
    clearTimeout(old.retry);
    old.socket?.close();
    old.shared.destroy();
  }
  inlineEditor.setReadOnly(false);
  collaborationNotice("");
  renderCollaborators();
}

async function startCollaboration() {
  if (!activeDocument || collaboration) return;
  if ((authMode === "users" || publicView)
      && (!documentPermissions?.collaborative || !documentParticipation?.ready)) return;
  if (dirty() || pendingSave) {
    collaborationNotice("Save this draft before joining collaborative editing.", true);
    return;
  }
  const current = {
    id: documentId, resource: activeDocument.id, path: activeDocument.path, room: null, closed: false,
    connecting: true, connected: false, applying: false, composing: false,
    users: [], me: null, socket: null, retry: null, sequence: 0,
    pending: new Map(), localUpdates: new Map(), localSequence: 0, localModified: false,
    queue: [], processing: false, selection: null, recoveryRecord: null,
    cursorSignature: null, initialized: false, saving: false, failed: false,
  };
  current.shared = collaborativeModel(current);
  collaboration = current;
  cancelAutoSave();
  await recoverDocumentDraft();
  if (current !== collaboration) return;
  await connectCollaboration(current);
}

function collaborativeModel(current) {
  return createSharedText((update) => {
    const local = ++current.localSequence;
    current.localUpdates.set(local, update);
    current.localModified = true;
    queueDraftPersistence();
    if (!current.connected) return;
    sendCollaborativeUpdate(current, update, [local]);
  });
}

function sendCollaborativeUpdate(current, update, local = [...current.localUpdates.keys()]) {
  if (current.socket?.readyState !== WebSocket.OPEN) return;
  const sequence = ++current.sequence;
  const bytes = new Uint8Array(update.length + 4);
  new DataView(bytes.buffer).setUint32(0, sequence, true);
  bytes.set(update, 4);
  current.pending.set(sequence, local);
  current.socket.send(bytes);
}

async function connectCollaboration(current) {
  if (current !== collaboration || current.closed || current.socket?.readyState === WebSocket.OPEN) return;
  if (current.unmerged) {
    collaborationNotice("An unmerged local draft is kept. Copy it before reopening this note.", true);
    return;
  }
  clearTimeout(current.retry);
  current.connecting = !current.initialized;
  inlineEditor.setReadOnly(current.connecting);
  collaborationNotice("Connecting collaborative editing…");
  renderCollaborators();
  refreshControls();
  try {
    const joined = await api("/api/collaboration/join", {
      method: "POST", body: { document: current.resource, roomId: current.room, participant: documentParticipation?.participant ?? null },
    });
    if (current !== collaboration) return;
    current.room = joined.roomId;
    const url = new URL(publicView ? "/api/public/collaboration/socket" : "/api/collaboration/socket", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", joined.ticket);
    if (activeProject) url.searchParams.set("project", activeProject.id);
    if (publicView) url.searchParams.set("share", publicToken);
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    current.socket = socket;
    let snapshot = true;
    socket.onmessage = ({ data }) => {
      if (socket !== current.socket || current !== collaboration) return;
      current.queue.push({ data, snapshot: data instanceof ArrayBuffer && snapshot });
      if (data instanceof ArrayBuffer) snapshot = false;
      void drainCollaboration(current);
    };
    socket.onerror = () => collaborationNotice("Collaborative connection failed. Your local text is kept.", true);
    socket.onclose = () => {
      if (current !== collaboration || current.closed || socket !== current.socket) return;
      current.connected = false;
      current.connecting = false;
      current.saving = false;
      current.users = [];
      current.queue = [];
      inlineEditor.setReadOnly(!current.initialized);
      collaborationNotice(current.unmerged
        ? "An unmerged local draft is kept. Copy it before reopening this note."
        : "Collaboration disconnected. Local edits are kept; reconnecting…", true);
      renderCollaborators();
      refreshControls();
      if (!current.unmerged) current.retry = setTimeout(() => void connectCollaboration(current), 2000);
    };
  } catch (error) {
    if (current !== collaboration) return;
    current.connecting = false;
    if (error.status === 425) {
      current.retry = setTimeout(() => void connectCollaboration(current), 1000);
      return;
    }
    if (error.status === 403 || error.status === 401) current.writable = false;
    inlineEditor.setReadOnly(!current.initialized);
    collaborationNotice(`Could not join collaboration: ${error.message}`, true);
    renderCollaborators();
    refreshControls();
    if (publicView && error.status === 401) requestPublicPassword();
    if (current.recoveryRecord) showDraftRecovery(current.recoveryRecord);
  }
}

function collaborationChanged() {
  const current = collaboration;
  if (!current || current.applying || !current.initialized || !projectWritable()) return;
  try {
    current.shared.replace(ui.editor.value);
    if (current.unmerged) {
      current.unmerged = null;
      current.failed = false;
      void connectCollaboration(current);
    }
    current.selection = current.shared.relative(collaborativeSelection());
    publishCollaborativeCursor();
  } catch (error) {
    current.failed = true;
    current.unmerged = ui.editor.value;
    current.socket?.close();
    collaborationNotice(`${error.message} Your local text is kept.`, true);
  }
}

function saveCollaboration() {
  if (!projectWritable()) return;
  const current = collaboration;
  if (!current?.connected) {
    collaborationNotice("Not saved: collaboration is disconnected. Your local edits are kept.", true);
    return;
  }
  if (current.failed) return;
  current.saving = true;
  current.socket.send(JSON.stringify({ type: "save" }));
  refreshControls();
}

function collaborativeSaved(current, payload) {
  if (current !== collaboration || payload.path !== current.path) return;
  rememberResources(payload, activeProject?.id ?? "local");
  activeDocument = { ...createDocumentModel(payload), root: currentRoot };
  editorAnalysisDocument = null;
  current.saving = false;
  updateFileTitle(payload.path, payload.title);
  refreshControls();
  if (!dirty()) {
    cancelAutoSave();
    renderPreview(payload.html);
    previewStatus("Up to date");
  }
  if (payload.warning) documentNotice(payload.warning, "warning");
  queueDraftPersistence();
  finishLocalDraft();
}

async function displaySharedText(current, selection) {
  const next = current.shared.value;
  if (ui.editor.value !== next) {
    current.applying = true;
    inlineEditor.setReadOnly(true);
    const focus = document.activeElement;
    const inEditor = Boolean(focus?.closest("#rich-editor, .editor-pane"));
    try {
      ui.editor.value = next;
      editorRevision += 1;
      if (ui.panes.dataset.view === "rich") {
        if (!await inlineEditor.replaceSource(next)) {
          await inlineEditor.load(next, current.path);
        }
      }
      if (current !== collaboration) return;
      current.applying = false;
      inlineEditor.setReadOnly(false);
      refreshControls();
      const restored = current.shared.resolve(selection);
      if (restored && inEditor) {
        if (ui.panes.dataset.view === "rich") inlineEditor.select(restored.from, restored.to);
        else {
          ui.editor.setSelectionRange(restored.from, restored.to);
          ui.editor.focus({ preventScroll: true });
        }
      }
      schedulePreview();
    } finally {
      current.applying = false;
      if (current === collaboration) {
        inlineEditor.setReadOnly(false);
        refreshControls();
      }
    }
  }
  schedulePeerCursors();
}

async function drainCollaboration(current) {
  if (current.processing || current.composing || current.unmerged || current !== collaboration) return;
  current.processing = true;
  try {
    while (current.queue.length && !current.composing && current === collaboration) {
      const { data, snapshot } = current.queue.shift();
      if (data instanceof ArrayBuffer) {
        const selection = current.initialized ? current.shared.relative(collaborativeSelection()) : null;
        const update = new Uint8Array(data, 4);
        current.shared.apply(update);
        if (snapshot) {
          const reconnect = current.initialized;
          current.connecting = false;
          current.connected = true;
          current.initialized = true;
          current.pending.clear();
          current.cursorSignature = null;
          inlineEditor.setReadOnly(false);
          if ((reconnect || current.localUpdates.size) && current.writable !== false) {
            sendCollaborativeUpdate(current, current.shared.changesSince(update));
          }
          collaborationNotice(current.failed
            ? "This collaborative draft could not be saved. Copy your shared edits before reopening the note." : "", current.failed);
          renderCollaborators();
        }
        await displaySharedText(current, selection);
        current.selection = current.shared.relative(collaborativeSelection());
        publishCollaborativeCursor();
        refreshControls();
        finishLocalDraft();
      } else {
        const message = JSON.parse(data);
        if (message.type === "welcome") {
          current.me = message.me;
          current.users = message.users;
          current.failed = message.blocked;
          current.writable = message.writable;
          if (!message.writable && current.recoveryRecord) {
            const record = current.recoveryRecord;
            current.shared.destroy();
            current.shared = collaborativeModel(current);
            current.localUpdates.clear();
            current.localModified = false;
            current.recoveryRecord = null;
            showDraftRecovery(record);
          }
          collaborativeSaved(current, message.saved);
        } else if (message.type === "presence") {
          current.users = message.users;
          renderCollaborators();
        } else if (message.type === "reset") {
          await persistCurrentDraft().catch((error) => console.error("Could not preserve the draft before a document reset.", error));
          stopDocumentParticipation();
          if (documentPermissions) documentPermissions = { ...documentPermissions, writable: false, collaborative: false };
          current.closed = true;
          current.connected = false;
          current.writable = false;
          current.users = [];
          collaborationNotice(message.message, true);
          renderCollaborators();
          refreshControls();
        } else if (message.type === "ack") {
          for (const local of current.pending.get(message.sequence) ?? []) current.localUpdates.delete(local);
          current.pending.delete(message.sequence);
          queueDraftPersistence();
          finishLocalDraft();
        } else if (message.type === "saved") {
          collaborativeSaved(current, message.document);
        } else if (message.type === "error") {
          current.saving = false;
          current.failed = true;
          collaborationNotice(message.message, true);
        }
      }
    }
  } catch (error) {
    current.failed = true;
    collaborationNotice(`Collaboration could not apply an update: ${error.message}. Your local text is kept.`, true);
    current.socket?.close();
  } finally {
    current.processing = false;
  }
}

const collaborativeTarget = (target) => target?.closest(
  "#editor, .virtual-source-editor .cm-content, #rich-editor .ProseMirror, .notes-metadata-source",
);
document.addEventListener("compositionstart", (event) => {
  if (collaboration && collaborativeTarget(event.target)) collaboration.composing = true;
});
document.addEventListener("compositionend", (event) => {
  if (!collaboration || !collaborativeTarget(event.target)) return;
  const current = collaboration;
  setTimeout(() => {
    if (current !== collaboration) return;
    collaborationChanged();
    current.composing = false;
    void drainCollaboration(current);
  }, 0);
});
document.addEventListener("keydown", (event) => {
  const current = collaboration;
  if (!projectWritable() || !current?.initialized || current.composing || current.unmerged || !collaborativeTarget(event.target)
      || !(event.ctrlKey || event.metaKey) || event.altKey
      || !["z", "y"].includes(event.key.toLowerCase())) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const selection = current.shared.relative(collaborativeSelection());
  if (event.shiftKey || event.key.toLowerCase() === "y") current.shared.redo();
  else current.shared.undo();
  void displaySharedText(current, selection);
}, true);
window.addEventListener("pagehide", () => collaboration?.socket?.close());

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

let historyView = null;
let historyGeneration = 0;
let historyBusy = false;
const historyDialog = element("history-dialog");
const trashDialog = element("trash-dialog");

async function openHistory() {
  if (!activeDocument || !activeProject?.owned) return;
  closeMenus();
  const generation = ++historyGeneration;
  historyView = { id: activeDocument.id, path: activeDocument.path, project: activeProject.id, document: documentId, selected: null };
  element("history-list").replaceChildren();
  element("history-diff").textContent = "";
  element("history-restore").disabled = true;
  element("history-copy").disabled = true;
  historyDialog.showModal();
  notice(element("history-message"), "Loading history…");
  try {
    const result = await api(`/api/history?document=${encodeURIComponent(historyView.id)}`);
    if (generation !== historyGeneration || !historyDialog.open) return;
    historyView.version = result.currentVersion;
    historyView.current = activeDocument.content;
    element("history-list").replaceChildren(...result.revisions.map((revision) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.id = String(revision.id);
      const label = document.createElement("span");
      label.textContent = new Date(revision.created).toLocaleString();
      const details = document.createElement("small");
      details.textContent = `${revision.actor || "Editor"} · ${revision.kind} · ${formatByteCount(revision.size)}`;
      button.append(label, details);
      button.addEventListener("click", () => void selectHistoryVersion(revision.id));
      return button;
    }));
    notice(element("history-message"), result.revisions.length ? "" : "No earlier versions have been recorded.");
    if (result.revisions.length) await selectHistoryVersion(result.revisions[0].id);
  } catch (error) { notice(element("history-message"), error.message, "error"); }
}

async function selectHistoryVersion(id) {
  const view = historyView;
  const generation = ++historyGeneration;
  notice(element("history-message"), "Loading version…");
  try {
    const result = await api(`/api/history/content?document=${encodeURIComponent(view.id)}&revision=${id}`);
    if (generation !== historyGeneration || historyView !== view || !historyDialog.open) return;
    view.selected = result;
    for (const button of element("history-list").children) button.setAttribute("aria-pressed", String(Number(button.dataset.id) === id));
    element("history-detail").textContent = "Selected version compared with the open document. Red is removed; green is current.";
    const changes = diffLines(result.content, view.current, { timeout: 200 });
    const diff = element("history-diff");
    diff.replaceChildren();
    let remaining = 200_000;
    for (const change of changes ?? [{ value: result.content }]) {
      const line = document.createElement("span");
      line.className = change.added ? "is-added" : change.removed ? "is-removed" : "";
      line.textContent = change.value.slice(0, remaining);
      diff.append(line);
      remaining -= line.textContent.length;
      if (remaining <= 0) break;
    }
    notice(element("history-message"), !changes ? "The diff is too large. Showing the selected version; Copy version retains all text."
      : remaining <= 0 ? "The preview is truncated. Copy version retains all text." : "", "warning");
    element("history-copy").disabled = false;
    element("history-restore").disabled = !view.version || view.version === result.revision.version;
  } catch (error) { notice(element("history-message"), error.message, "error"); }
}

element("history-open").addEventListener("click", () => void openHistory());
element("history-close").addEventListener("click", () => { if (!historyBusy) historyDialog.close(); });
historyDialog.addEventListener("cancel", (event) => { if (historyBusy) event.preventDefault(); });
historyDialog.addEventListener("close", () => { historyGeneration += 1; historyView = null; });
element("history-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(historyView.selected.content); documentNotice("Version copied.", "success"); }
  catch (error) { notice(element("history-message"), `Could not copy this version: ${error.message}`, "error"); }
});
element("history-restore").addEventListener("click", async () => {
  const view = historyView;
  if (!view?.selected || historyBusy) return;
  if (!window.confirm("Restore this version? Connected editors must reopen the document. Existing sharing permissions stay in effect.")) return;
  historyBusy = true;
  element("history-restore").disabled = true;
  notice(element("history-message"), "Restoring version…");
  try {
    if (view.project !== activeProject?.id || view.document !== documentId) throw new Error("The open document changed.");
    const document = await api("/api/history/restore", { method: "POST", body: {
      document: view.id, revision: view.selected.revision.id, version: view.version,
    } });
    historyDialog.close();
    useDocument(document, currentRoot, new URL(committedUrl), "replace", "Restored the selected version.");
    void refreshFiles();
  } catch (error) { notice(element("history-message"), error.message, "error"); }
  finally { historyBusy = false; element("history-restore").disabled = false; }
});

async function openTrash() {
  closeMenus();
  if (!trashDialog.open) trashDialog.showModal();
  notice(element("trash-message"), "Loading recycle bin…");
  try {
    const entries = await api("/api/trash");
    element("trash-list").replaceChildren(...entries.map((entry) => {
      const row = document.createElement("div");
      const name = document.createElement("span");
      name.className = "workspace-item-name";
      name.textContent = entry.path;
      const details = document.createElement("small");
      details.textContent = `${new Date(entry.deleted).toLocaleString()} · ${formatByteCount(entry.size)}`;
      name.append(details);
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "Restore";
      restore.setAttribute("aria-label", `Restore ${entry.path}`);
      restore.addEventListener("click", async () => {
        restore.disabled = true;
        const project = activeProject?.id;
        try {
          await api("/api/trash/restore", { method: "POST", body: { id: entry.id } });
          if (activeProject?.id === project) {
            if (trashDialog.open) await openTrash();
            void refreshFiles();
          }
        } catch (error) { notice(element("trash-message"), error.message, "error"); restore.disabled = false; }
      });
      row.append(name, restore);
      return row;
    }));
    notice(element("trash-message"), entries.length ? "" : "The recycle bin is empty.");
  } catch (error) { notice(element("trash-message"), error.message, "error"); }
}
element("trash-open").addEventListener("click", () => void openTrash());
element("trash-close").addEventListener("click", () => trashDialog.close());
element("document-trash").addEventListener("click", async () => {
  closeMenus();
  if (!activeDocument || !activeProject?.owned) return;
  if (!window.confirm(`Move “${activeDocument.path}” to the recycle bin for 30 days? Its public links will be revoked.`)) return;
  const id = documentId;
  try {
    await api("/api/document", { method: "DELETE", body: { id: activeDocument.id, version: activeDocument.version } });
    if (id === documentId) {
      const url = new URL(committedUrl);
      url.searchParams.delete("document");
      url.hash = "";
      clearDocument(url, "replace");
    }
    documentNotice("Moved to the recycle bin.", "success");
    await refreshFiles();
  } catch (error) { documentNotice(`Could not delete the note: ${error.message}`, "error"); }
});

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
