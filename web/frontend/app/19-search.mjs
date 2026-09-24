const searchDialog = element("search-dialog");
let searchTimer = null;
let searchController = null;
let searchGeneration = 0;
let searchTags = [];
let searchResults = [];
let searchSelection = 0;

async function openWorkspaceSearch({ tags = [] } = {}) {
  if (authMode !== "users") {
    documentNotice("Library search requires a signed-in account.", "warning");
    return;
  }
  closeMenus();
  searchTags = [...tags];
  element("search-query").value = "";
  element("search-project").replaceChildren(new Option("All projects", ""), ...projects.map((project) => new Option(project.name, project.id)));
  element("search-project").value = activeProject?.id ?? "";
  renderSearchTags([]);
  if (!searchDialog.open) searchDialog.showModal();
  element("search-query").focus();
  await runWorkspaceSearch(0, true);
}

function renderSearchTags(facets) {
  element("search-selected-tags").replaceChildren(...searchTags.map((tag) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${tag} ×`;
    button.setAttribute("aria-label", `Remove tag filter ${tag}`);
    button.addEventListener("click", () => { searchTags = searchTags.filter((value) => value !== tag); void runWorkspaceSearch(); });
    return button;
  }));
  element("search-tags").replaceChildren(...facets.map(({ tag, count }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${tag} · ${count}`;
    const selected = searchTags.some((value) => value.toLowerCase() === tag.toLowerCase());
    button.setAttribute("aria-pressed", String(selected));
    button.addEventListener("click", () => {
      const active = searchTags.some((value) => value.toLowerCase() === tag.toLowerCase());
      searchTags = active ? searchTags.filter((value) => value.toLowerCase() !== tag.toLowerCase()) : [...searchTags, tag];
      void runWorkspaceSearch();
    });
    return button;
  }));
}

function highlightedSnippet(value, query) {
  const fragment = document.createDocumentFragment();
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))];
  if (!terms.length) { fragment.append(value); return fragment; }
  const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
  let from = 0;
  for (const match of value.matchAll(pattern)) {
    fragment.append(value.slice(from, match.index));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    fragment.append(mark);
    from = match.index + match[0].length;
  }
  fragment.append(value.slice(from));
  return fragment;
}

function renderSearchResults(results, labels) {
  searchResults = results;
  searchSelection = Math.min(searchSelection, Math.max(0, results.length - 1));
  element("search-results").replaceChildren(...results.map((result, index) => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.index = String(index);
    button.setAttribute("aria-selected", String(index === searchSelection));
    const title = document.createElement("strong");
    title.textContent = result.title;
    const location = document.createElement("small");
    location.textContent = `${labels.get(result.project) ?? result.project} / ${result.path}`;
    const snippet = document.createElement("span");
    snippet.className = "search-snippet";
    snippet.append(highlightedSnippet(result.snippet, element("search-query").value));
    button.append(title, location, snippet);
    button.addEventListener("click", () => void openSearchResult(index));
    row.append(button);
    return row;
  }));
  element("search-empty").hidden = results.length > 0;
}

async function runWorkspaceSearch(cursor = 0, refresh = false) {
  clearTimeout(searchTimer);
  searchController?.abort();
  if (!searchDialog.open) return;
  const controller = new AbortController();
  searchController = controller;
  const generation = ++searchGeneration;
  const query = element("search-query").value;
  notice(element("search-message"), "Searching notes…");
  try {
    const result = await api("/api/search", { method: "POST", signal: controller.signal, body: {
      query, project: element("search-project").value || null, field: element("search-field").value,
      tags: searchTags, cursor, refresh,
    } });
    if (generation !== searchGeneration || !searchDialog.open) return;
    if (!Array.isArray(result.results) || !Array.isArray(result.tags) || !Array.isArray(result.projects)) {
      throw new ApiError("The search response is incomplete.");
    }
    renderSearchTags(result.tags);
    renderSearchResults(result.results, new Map(result.projects.map((project) => [project.id, project.name])));
    const message = result.warnings?.join("\n") || (result.indexing ? "Indexing notes; results are updating…"
      : result.truncated ? "Showing a limited set of results. Narrow the query or tags." : "");
    notice(element("search-message"), message, result.warnings?.length ? "warning" : "");
    if (result.indexing) searchTimer = setTimeout(() => void runWorkspaceSearch(result.cursor), 350);
  } catch (error) {
    if (!aborted(error) && generation === searchGeneration) notice(element("search-message"), error.message, "error");
  }
}

async function openSearchResult(index) {
  const result = searchResults[index];
  if (!result) return;
  searchDialog.close();
  if (activeProject?.id !== result.project) {
    await loadProjects();
    const url = new URL(window.location.href);
    url.searchParams.set("project", result.project);
    url.searchParams.set("document", result.id);
    url.hash = "";
    await switchProject(result.project, { url });
    return;
  }
  if (!await navigateTo(result.id)) return;
  if (activeDocument?.version !== result.version) return;
  if (ui.panes.dataset.view === "rich") {
    if (element("rich-editor").getAttribute("aria-busy") === "true") pendingHeading = result.offset;
    else inlineEditor.jumpTo(result.offset);
  } else if (ui.panes.dataset.view !== "preview") {
    ui.editor.focus();
    ui.editor.setSelectionRange(result.offset, result.offset);
  }
}

element("workspace-search-open").addEventListener("click", () => void openWorkspaceSearch());
element("search-close").addEventListener("click", () => searchDialog.close());
searchDialog.addEventListener("close", () => { clearTimeout(searchTimer); searchController?.abort(); searchGeneration += 1; });
element("search-query").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchController?.abort();
  searchGeneration += 1;
  notice(element("search-message"), "Searching notes…");
  searchTimer = setTimeout(() => void runWorkspaceSearch(), 200);
});
for (const id of ["search-project", "search-field"]) element(id).addEventListener("change", () => void runWorkspaceSearch());
element("search-form").addEventListener("submit", (event) => { event.preventDefault(); void openSearchResult(searchSelection); });
element("search-query").addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key) || !searchResults.length) return;
  event.preventDefault();
  searchSelection = (searchSelection + (event.key === "ArrowDown" ? 1 : -1) + searchResults.length) % searchResults.length;
  for (const button of element("search-results").querySelectorAll("button")) {
    button.setAttribute("aria-selected", String(Number(button.dataset.index) === searchSelection));
  }
  element("search-results").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "p" && authMode === "users") {
    event.preventDefault();
    void openWorkspaceSearch();
  }
});
