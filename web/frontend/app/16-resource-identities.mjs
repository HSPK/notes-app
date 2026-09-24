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
