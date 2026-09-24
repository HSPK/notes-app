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
