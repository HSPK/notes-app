let collaboration = null;

function collaborationLocked() {
  return Boolean(documentParticipation?.preparing
    || collaboration && (!collaboration.initialized || collaboration.connecting || collaboration.applying));
}

function stopCollaboration() {
  const old = collaboration;
  if (old) void persistCurrentDraft().catch(console.error);
  collaboration = null;
  if (old) {
    old.closed = true;
    clearTimeout(old.retry);
    old.socket?.close();
    old.shared.destroy();
  }
  inlineEditor.setReadOnly(false);
  collaborationNotice("");
  renderCollaborators();
}

async function startCollaboration() {
  if (!activeDocument || collaboration) return;
  if ((authMode === "users" || publicView)
      && (!documentPermissions?.collaborative || !documentParticipation?.ready)) return;
  if (dirty() || pendingSave) {
    collaborationNotice("Save this draft before joining collaborative editing.", true);
    return;
  }
  const current = {
    id: documentId, resource: activeDocument.id, path: activeDocument.path, room: null, closed: false,
    connecting: true, connected: false, applying: false, composing: false,
    users: [], me: null, socket: null, retry: null, sequence: 0,
    pending: new Map(), localUpdates: new Map(), localSequence: 0, localModified: false,
    queue: [], processing: false, selection: null, recoveryRecord: null,
    cursorSignature: null, initialized: false, saving: false, failed: false,
  };
  current.shared = collaborativeModel(current);
  collaboration = current;
  cancelAutoSave();
  await recoverDocumentDraft();
  if (current !== collaboration) return;
  await connectCollaboration(current);
}

function collaborativeModel(current) {
  return createSharedText((update) => {
    const local = ++current.localSequence;
    current.localUpdates.set(local, update);
    current.localModified = true;
    queueDraftPersistence();
    if (!current.connected) return;
    sendCollaborativeUpdate(current, update, [local]);
  });
}

function sendCollaborativeUpdate(current, update, local = [...current.localUpdates.keys()]) {
  if (current.socket?.readyState !== WebSocket.OPEN) return;
  const sequence = ++current.sequence;
  const bytes = new Uint8Array(update.length + 4);
  new DataView(bytes.buffer).setUint32(0, sequence, true);
  bytes.set(update, 4);
  current.pending.set(sequence, local);
  current.socket.send(bytes);
}

async function connectCollaboration(current) {
  if (current !== collaboration || current.closed || current.socket?.readyState === WebSocket.OPEN) return;
  if (current.unmerged) {
    collaborationNotice("An unmerged local draft is kept. Copy it before reopening this note.", true);
    return;
  }
  clearTimeout(current.retry);
  current.connecting = !current.initialized;
  inlineEditor.setReadOnly(current.connecting);
  collaborationNotice("Connecting collaborative editing…");
  renderCollaborators();
  refreshControls();
  try {
    const joined = await api("/api/collaboration/join", {
      method: "POST", body: { document: current.resource, roomId: current.room, participant: documentParticipation?.participant ?? null },
    });
    if (current !== collaboration) return;
    current.room = joined.roomId;
    const url = new URL(publicView ? "/api/public/collaboration/socket" : "/api/collaboration/socket", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", joined.ticket);
    if (activeProject) url.searchParams.set("project", activeProject.id);
    if (publicView) url.searchParams.set("share", publicToken);
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    current.socket = socket;
    let snapshot = true;
    socket.onmessage = ({ data }) => {
      if (socket !== current.socket || current !== collaboration) return;
      current.queue.push({ data, snapshot: data instanceof ArrayBuffer && snapshot });
      if (data instanceof ArrayBuffer) snapshot = false;
      void drainCollaboration(current);
    };
    socket.onerror = () => collaborationNotice("Collaborative connection failed. Your local text is kept.", true);
    socket.onclose = () => {
      if (current !== collaboration || current.closed || socket !== current.socket) return;
      current.connected = false;
      current.connecting = false;
      current.saving = false;
      current.users = [];
      current.queue = [];
      inlineEditor.setReadOnly(!current.initialized);
      collaborationNotice(current.unmerged
        ? "An unmerged local draft is kept. Copy it before reopening this note."
        : "Collaboration disconnected. Local edits are kept; reconnecting…", true);
      renderCollaborators();
      refreshControls();
      if (!current.unmerged) current.retry = setTimeout(() => void connectCollaboration(current), 2000);
    };
  } catch (error) {
    if (current !== collaboration) return;
    current.connecting = false;
    if (error.status === 425) {
      current.retry = setTimeout(() => void connectCollaboration(current), 1000);
      return;
    }
    if (error.status === 403 || error.status === 401) current.writable = false;
    inlineEditor.setReadOnly(!current.initialized);
    collaborationNotice(`Could not join collaboration: ${error.message}`, true);
    renderCollaborators();
    refreshControls();
    if (publicView && error.status === 401) requestPublicPassword();
    if (current.recoveryRecord) showDraftRecovery(current.recoveryRecord);
  }
}

function collaborationChanged() {
  const current = collaboration;
  if (!current || current.applying || !current.initialized || !projectWritable()) return;
  try {
    current.shared.replace(ui.editor.value);
    if (current.unmerged) {
      current.unmerged = null;
      current.failed = false;
      void connectCollaboration(current);
    }
    current.selection = current.shared.relative(collaborativeSelection());
    publishCollaborativeCursor();
  } catch (error) {
    current.failed = true;
    current.unmerged = ui.editor.value;
    current.socket?.close();
    collaborationNotice(`${error.message} Your local text is kept.`, true);
  }
}

function saveCollaboration() {
  if (!projectWritable()) return;
  const current = collaboration;
  if (!current?.connected) {
    collaborationNotice("Not saved: collaboration is disconnected. Your local edits are kept.", true);
    return;
  }
  if (current.failed) return;
  current.saving = true;
  current.socket.send(JSON.stringify({ type: "save" }));
  refreshControls();
}

function collaborativeSaved(current, payload) {
  if (current !== collaboration || payload.path !== current.path) return;
  rememberResources(payload, activeProject?.id ?? "local");
  activeDocument = { ...createDocumentModel(payload), root: currentRoot };
  editorAnalysisDocument = null;
  current.saving = false;
  updateFileTitle(payload.path, payload.title);
  refreshControls();
  if (!dirty()) {
    cancelAutoSave();
    renderPreview(payload.html);
    previewStatus("Up to date");
  }
  if (payload.warning) documentNotice(payload.warning, "warning");
  queueDraftPersistence();
  finishLocalDraft();
}

async function displaySharedText(current, selection) {
  const next = current.shared.value;
  if (ui.editor.value !== next) {
    current.applying = true;
    inlineEditor.setReadOnly(true);
    const focus = document.activeElement;
    const inEditor = Boolean(focus?.closest("#rich-editor, .editor-pane"));
    try {
      ui.editor.value = next;
      editorRevision += 1;
      if (ui.panes.dataset.view === "rich") {
        if (!await inlineEditor.replaceSource(next)) {
          await inlineEditor.load(next, current.path);
        }
      }
      if (current !== collaboration) return;
      current.applying = false;
      inlineEditor.setReadOnly(false);
      refreshControls();
      const restored = current.shared.resolve(selection);
      if (restored && inEditor) {
        if (ui.panes.dataset.view === "rich") inlineEditor.select(restored.from, restored.to);
        else {
          ui.editor.setSelectionRange(restored.from, restored.to);
          ui.editor.focus({ preventScroll: true });
        }
      }
      schedulePreview();
    } finally {
      current.applying = false;
      if (current === collaboration) {
        inlineEditor.setReadOnly(false);
        refreshControls();
      }
    }
  }
  schedulePeerCursors();
}

async function drainCollaboration(current) {
  if (current.processing || current.composing || current.unmerged || current !== collaboration) return;
  current.processing = true;
  try {
    while (current.queue.length && !current.composing && current === collaboration) {
      const { data, snapshot } = current.queue.shift();
      if (data instanceof ArrayBuffer) {
        const selection = current.initialized ? current.shared.relative(collaborativeSelection()) : null;
        const update = new Uint8Array(data, 4);
        current.shared.apply(update);
        if (snapshot) {
          const reconnect = current.initialized;
          current.connecting = false;
          current.connected = true;
          current.initialized = true;
          current.pending.clear();
          current.cursorSignature = null;
          inlineEditor.setReadOnly(false);
          if ((reconnect || current.localUpdates.size) && current.writable !== false) {
            sendCollaborativeUpdate(current, current.shared.changesSince(update));
          }
          collaborationNotice(current.failed
            ? "This collaborative draft could not be saved. Copy your shared edits before reopening the note." : "", current.failed);
          renderCollaborators();
        }
        await displaySharedText(current, selection);
        current.selection = current.shared.relative(collaborativeSelection());
        publishCollaborativeCursor();
        refreshControls();
        finishLocalDraft();
      } else {
        const message = JSON.parse(data);
        if (message.type === "welcome") {
          current.me = message.me;
          current.users = message.users;
          current.failed = message.blocked;
          current.writable = message.writable;
          if (!message.writable && current.recoveryRecord) {
            const record = current.recoveryRecord;
            current.shared.destroy();
            current.shared = collaborativeModel(current);
            current.localUpdates.clear();
            current.localModified = false;
            current.recoveryRecord = null;
            showDraftRecovery(record);
          }
          collaborativeSaved(current, message.saved);
        } else if (message.type === "presence") {
          current.users = message.users;
          renderCollaborators();
        } else if (message.type === "reset") {
          await persistCurrentDraft().catch((error) => console.error("Could not preserve the draft before a document reset.", error));
          stopDocumentParticipation();
          if (documentPermissions) documentPermissions = { ...documentPermissions, writable: false, collaborative: false };
          current.closed = true;
          current.connected = false;
          current.writable = false;
          current.users = [];
          collaborationNotice(message.message, true);
          renderCollaborators();
          refreshControls();
        } else if (message.type === "ack") {
          for (const local of current.pending.get(message.sequence) ?? []) current.localUpdates.delete(local);
          current.pending.delete(message.sequence);
          queueDraftPersistence();
          finishLocalDraft();
        } else if (message.type === "saved") {
          collaborativeSaved(current, message.document);
        } else if (message.type === "error") {
          current.saving = false;
          current.failed = true;
          collaborationNotice(message.message, true);
        }
      }
    }
  } catch (error) {
    current.failed = true;
    collaborationNotice(`Collaboration could not apply an update: ${error.message}. Your local text is kept.`, true);
    current.socket?.close();
  } finally {
    current.processing = false;
  }
}

const collaborativeTarget = (target) => target?.closest(
  "#editor, .virtual-source-editor .cm-content, #rich-editor .ProseMirror, .notes-metadata-source",
);
document.addEventListener("compositionstart", (event) => {
  if (collaboration && collaborativeTarget(event.target)) collaboration.composing = true;
});
document.addEventListener("compositionend", (event) => {
  if (!collaboration || !collaborativeTarget(event.target)) return;
  const current = collaboration;
  setTimeout(() => {
    if (current !== collaboration) return;
    collaborationChanged();
    current.composing = false;
    void drainCollaboration(current);
  }, 0);
});
document.addEventListener("keydown", (event) => {
  const current = collaboration;
  if (!projectWritable() || !current?.initialized || current.composing || current.unmerged || !collaborativeTarget(event.target)
      || !(event.ctrlKey || event.metaKey) || event.altKey
      || !["z", "y"].includes(event.key.toLowerCase())) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const selection = current.shared.relative(collaborativeSelection());
  if (event.shiftKey || event.key.toLowerCase() === "y") current.shared.redo();
  else current.shared.undo();
  void displaySharedText(current, selection);
}, true);
window.addEventListener("pagehide", () => collaboration?.socket?.close());
