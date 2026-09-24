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
