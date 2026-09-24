const statusNotices = document.createElement("div");
statusNotices.className = "status-notices";
statusNotices.id = "status-notices";
const statusDetails = document.createElement("button");
statusDetails.id = "status-details";
statusDetails.type = "button";
statusDetails.textContent = "…";
statusDetails.title = "Show full status messages";
statusDetails.setAttribute("aria-label", "Show full status messages");
statusDetails.hidden = true;
const statusPanel = document.createElement("div");
const statusOrigins = new Map();
let automaticStatusPanel = false;
statusPanel.className = "status-panel";
statusPanel.setAttribute("popover", "auto");
statusPanel.setAttribute("aria-label", "Status messages");
document.body.append(statusPanel);
ui.dirty.after(statusNotices, statusDetails);
for (const node of new Set([
  ...document.querySelectorAll(".document-alerts > *"),
  ...document.querySelectorAll("dialog .notice"), ui.authError,
  ...document.querySelectorAll("[data-status-source]"),
  ui.documentMessage, ui.treeMessage, ui.treeLimit, element("git-message"), ui.previewStatus,
])) {
  node.classList.remove("visually-hidden");
  statusOrigins.set(node, node.closest("dialog, #auth-screen"));
  statusNotices.append(node);
}
document.querySelector(".document-alerts").remove();
element("git-message").textContent = "";
element("git-message").hidden = true;
function updateStatusDetails() {
  const messages = [...statusNotices.children].filter((node) => !node.hidden && node.textContent);
  statusDetails.hidden = messages.length === 0;
  for (const node of messages) node.title = node.textContent;
  const formErrors = messages.filter((node) => {
    const origin = statusOrigins.get(node);
    return node.classList.contains("is-error") && (origin?.open || origin === ui.authScreen && !origin.hidden);
  });
  if (formErrors.length) {
    automaticStatusPanel = true;
    statusPanel.setAttribute("role", "alert");
    renderStatusDetails(formErrors);
    if (!statusPanel.matches(":popover-open")) statusPanel.showPopover();
  } else if (automaticStatusPanel) {
    automaticStatusPanel = false;
    statusPanel.removeAttribute("role");
    if (statusPanel.matches(":popover-open")) statusPanel.hidePopover();
  } else if (statusPanel.matches(":popover-open")) renderStatusDetails(messages);
}
function renderStatusDetails(messages) {
  statusPanel.replaceChildren(...messages.map((node) => {
    const item = document.createElement("p");
    item.className = node.classList.contains("is-error") ? "is-error" : node.classList.contains("is-warning") ? "is-warning" : "";
    item.textContent = node.textContent;
    return item;
  }));
}
new MutationObserver(updateStatusDetails).observe(statusNotices, {
  childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class"],
});
statusDetails.addEventListener("click", () => {
  automaticStatusPanel = false;
  renderStatusDetails([...statusNotices.children].filter((node) => !node.hidden && node.textContent));
  statusPanel.togglePopover();
});
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("close", () => {
    for (const [node, origin] of statusOrigins) if (origin === dialog) notice(node, "");
  });
}
