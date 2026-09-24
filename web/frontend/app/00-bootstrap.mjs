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
