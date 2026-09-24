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
