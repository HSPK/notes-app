let attachmentEntries = [];
let attachmentScanTruncated = false;
async function loadAttachments() {
  notice(element("attachments-message"), "Checking Markdown references…");
  try {
    const result = await api("/api/attachments");
    attachmentEntries = result.files;
    attachmentScanTruncated = result.truncated;
    renderAttachments();
    notice(element("attachments-message"), result.truncated ? "The scan was limited. Recycling is disabled until the complete project can be checked." : "", result.truncated ? "warning" : "");
  } catch (error) { notice(element("attachments-message"), error.message, "error"); }
}
function renderAttachments() {
  const entries = attachmentEntries.filter((entry) => !element("attachments-unused").checked || !entry.referenced);
  element("attachments-list").replaceChildren(...entries.map((entry) => {
    const row = document.createElement("div");
    const select = document.createElement("input");
    select.type = "checkbox";
    select.dataset.path = entry.path;
    select.disabled = entry.referenced || entry.size > 16 * 1024 * 1024 || attachmentScanTruncated;
    select.setAttribute("aria-label", `Select ${entry.path}`);
    const name = document.createElement("span");
    name.className = "workspace-item-name";
    name.textContent = entry.path;
    const details = document.createElement("small");
    details.textContent = `${formatByteCount(entry.size)} · ${entry.referenced ? "Referenced by Markdown" : "No saved Markdown reference"}`;
    name.append(details);
    row.append(select, name);
    return row;
  }));
  element("attachments-recycle").disabled = attachmentScanTruncated;
}
element("attachments-open").addEventListener("click", () => { closeMenus(); element("attachments-dialog").showModal(); void loadAttachments(); });
element("attachments-close").addEventListener("click", () => element("attachments-dialog").close());
element("attachments-unused").addEventListener("change", renderAttachments);
element("attachments-refresh").addEventListener("click", () => void loadAttachments());
element("attachments-recycle").addEventListener("click", async () => {
  const paths = new Set([...element("attachments-list").querySelectorAll("input:checked")].map((input) => input.dataset.path));
  const files = attachmentEntries.filter((entry) => paths.has(entry.path)).map(({ id, stamp }) => ({ id, stamp }));
  if (!files.length) { notice(element("attachments-message"), "Select attachments to recycle."); return; }
  if (!window.confirm(`Recycle ${files.length} selected attachments? Other programs or offline drafts may still reference them. They remain recoverable for 30 days.`)) return;
  element("attachments-recycle").disabled = true;
  try {
    await api("/api/attachments", { method: "POST", body: { files } });
    await loadAttachments();
    documentNotice("Selected attachments moved to the recycle bin.", "success");
  } catch (error) { notice(element("attachments-message"), error.message, "error"); }
  finally { element("attachments-recycle").disabled = attachmentScanTruncated; }
});
