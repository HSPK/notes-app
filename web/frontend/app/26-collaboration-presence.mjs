const collaborationUi = {
  people: element("collaboration-people"),
  join: element("collaboration-join"),
  message: element("collaboration-message"),
  cursors: element("collaboration-cursors"),
};
const peerColors = 12;
let cursorFrame = null;

function collaborationNotice(message, error = false) {
  notice(collaborationUi.message, message, error ? "warning" : "");
}

function renderCollaborators() {
  const current = collaboration;
  const preparing = Boolean(documentParticipation?.preparing);
  collaborationUi.join.hidden = !activeDocument || !current && !preparing && (authMode === "users" || publicView);
  collaborationUi.join.disabled = Boolean(current?.connecting);
  collaborationUi.join.title = current?.connected ? "Leave collaborative editing after saving" : "Join this note's collaborative session";
  setText(collaborationUi.join, current?.connected ? "Sharing" : current ? "Reconnect" : preparing ? "Preparing" : "Collaborate");
  collaborationUi.people.replaceChildren();
  const users = current?.users ?? [];
  const limit = compactLayout.matches ? 2 : 5;
  for (const user of users.slice(0, limit)) {
    const avatar = document.createElement("span");
    avatar.className = `collaboration-avatar peer-color-${user.color % peerColors}`;
    avatar.dataset.peer = user.id;
    avatar.setAttribute("role", "img");
    avatar.setAttribute("aria-label", `${user.name}${user.id === current.me?.id ? " (you)" : ""}`);
    avatar.title = `${user.name}${user.id === current.me?.id ? " (you)" : ""} · ${user.cursor?.mode ?? "online"}`;
    avatar.textContent = user.name.slice(0, 2).toUpperCase();
    collaborationUi.people.append(avatar);
  }
  if (users.length > limit) {
    const more = document.createElement("span");
    more.className = "collaboration-avatar";
    more.textContent = `+${users.length - limit}`;
    more.title = users.slice(limit).map((user) => user.name).join(", ");
    collaborationUi.people.append(more);
  }
  schedulePeerCursors();
}

function collaborativeSelection() {
  const mode = ui.panes.dataset.view;
  if (mode === "rich") return inlineEditor.getSelection();
  if (mode === "editor" || mode === "split") return ui.editor.getSelection();
  return null;
}

function drawPeerCursors() {
  cursorFrame = null;
  const current = collaboration;
  const mode = ui.panes.dataset.view;
  const fragment = document.createDocumentFragment();
  if (current?.connected && mode !== "preview") {
    const viewport = mode === "rich"
      ? element("rich-editor").getBoundingClientRect() : ui.editor.viewportRect();
    for (const user of current.users) {
      if (user.id === current.me?.id || !user.cursor) continue;
      const selection = current.shared.resolve(user.cursor);
      if (!selection) continue;
      const rect = mode === "rich" ? inlineEditor.cursorRect(selection.to) : ui.editor.cursorRect(selection.to);
      if (!rect || rect.top < viewport.top || rect.bottom > viewport.bottom
          || rect.left < viewport.left || rect.left > viewport.right) continue;
      const cursor = document.createElement("span");
      cursor.className = `collaboration-caret peer-color-${user.color % peerColors}`;
      cursor.dataset.peer = user.id;
      cursor.setAttribute("aria-hidden", "true");
      cursor.style.left = `${rect.left}px`;
      cursor.style.top = `${rect.top}px`;
      cursor.style.height = `${Math.max(14, rect.bottom - rect.top)}px`;
      const name = document.createElement("span");
      name.className = "collaboration-caret-name";
      name.textContent = user.name;
      cursor.append(name);
      fragment.append(cursor);
    }
  }
  collaborationUi.cursors.replaceChildren(fragment);
}

function schedulePeerCursors() {
  if (cursorFrame === null) cursorFrame = requestAnimationFrame(drawPeerCursors);
}

function publishCollaborativeCursor() {
  const current = collaboration;
  if (!current?.connected || current.socket?.readyState !== WebSocket.OPEN || current.applying || current.composing) return;
  current.selection = current.shared.relative(collaborativeSelection());
  const cursor = current.selection ? { ...current.selection, mode: ui.panes.dataset.view } : null;
  const signature = JSON.stringify(cursor);
  if (signature === current.cursorSignature) return;
  current.cursorSignature = signature;
  current.socket.send(JSON.stringify({ type: "cursor", cursor }));
}

document.addEventListener("selectionchange", () => {
  publishCollaborativeCursor();
  schedulePeerCursors();
});
document.addEventListener("scroll", schedulePeerCursors, true);
window.addEventListener("resize", renderCollaborators);
collaborationUi.join.addEventListener("click", () => {
  if (documentParticipation?.preparing && !collaboration) {
    stopDocumentParticipation();
    collaborationNotice("Automatic collaboration paused for this document. Reopen it to watch for editors.");
    renderCollaborators();
    refreshControls();
    return;
  }
  if (collaboration?.connected) {
    if (dirty() || collaboration.pending.size || collaboration.saving) {
      collaborationNotice("Save all shared changes before leaving collaboration.", true);
      saveCollaboration();
      return;
    }
    stopDocumentParticipation();
    stopCollaboration();
    refreshControls();
  } else if (collaboration) void connectCollaboration(collaboration);
  else void startCollaboration();
});
