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
