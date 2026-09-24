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
