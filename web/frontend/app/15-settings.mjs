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
