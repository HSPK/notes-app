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
