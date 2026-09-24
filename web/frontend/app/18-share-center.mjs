async function openShareCenter() {
  closeMenus();
  const dialog = element("shares-dialog");
  if (!dialog.open) dialog.showModal();
  notice(element("shares-message"), "Loading public links…");
  try {
    const links = await api("/api/shares");
    element("shares-list").replaceChildren(...links.map((link) => {
      const row = document.createElement("div");
      const name = document.createElement("span");
      name.className = "workspace-item-name";
      name.textContent = `${link.projectName} / ${link.path}`;
      const details = document.createElement("small");
      details.textContent = `${link.access === "edit" ? "Anonymous editing" : "Read only"} · ${link.passwordRequired ? "Password protected" : "No password"} · ${
        link.expiresAt ? `${link.expiresAt <= Date.now() ? "Expired" : "Expires"} ${new Date(link.expiresAt).toLocaleString()}` : "No expiration"}`;
      name.append(details);
      const manage = document.createElement("button");
      manage.type = "button";
      manage.textContent = "Manage";
      manage.addEventListener("click", async () => {
        try {
          await loadProjects();
          const project = projects.find((project) => project.id === link.project);
          if (!project?.owned) throw new Error("This project is no longer available.");
          dialog.close();
          openSharing(project, link.path, link.document);
        } catch (error) { notice(element("shares-message"), error.message, "error"); }
      });
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(publicShareUrl(link.token)); documentNotice("Public link copied.", "success"); }
        catch (error) { notice(element("shares-message"), error.message, "error"); }
      });
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        if (!window.confirm(`Revoke the public link for ${link.path}? Signed-in user permissions will be retained.`)) return;
        revoke.disabled = true;
        try {
          const updated = await api("/api/projects", { method: "POST", body: {
            action: "revokePublic", id: link.project, document: link.document,
          } });
          if (activeProject?.id === updated.id) activeProject = updated;
          await loadProjects();
          if (dialog.open) await openShareCenter();
        } catch (error) { notice(element("shares-message"), error.message, "error"); revoke.disabled = false; }
      });
      row.append(name, manage, copy, revoke);
      return row;
    }));
    notice(element("shares-message"), links.length ? "" : "You have no public document links.");
  } catch (error) { notice(element("shares-message"), error.message, "error"); }
}
element("shares-open").addEventListener("click", () => void openShareCenter());
element("shares-close").addEventListener("click", () => element("shares-dialog").close());
