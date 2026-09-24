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
