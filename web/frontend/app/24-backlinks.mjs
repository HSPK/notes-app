element("backlinks-open").addEventListener("click", async () => {
  if (!activeDocument || publicView) return;
  closeMenus();
  const id = documentId;
  const project = activeProject?.id;
  element("backlinks-list").replaceChildren();
  element("backlinks-dialog").showModal();
  notice(element("backlinks-message"), "Finding references…");
  try {
    const references = await api(`/api/backlinks?document=${encodeURIComponent(activeDocument.id)}`);
    if (id !== documentId || project !== activeProject?.id) return;
    element("backlinks-list").replaceChildren(...references.map((reference) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = reference.title ?? reference.path;
      button.title = reference.path;
      button.addEventListener("click", () => {
        element("backlinks-dialog").close();
        void navigateTo(reference.id);
      });
      return button;
    }));
    notice(element("backlinks-message"), references.length ? "" : "No accessible notes link to this document.");
  } catch (error) { notice(element("backlinks-message"), error.message, "error"); }
});
element("backlinks-close").addEventListener("click", () => element("backlinks-dialog").close());
