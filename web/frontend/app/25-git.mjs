const gitUi = {
  tab: element("git-tab"),
  panel: element("git-panel"),
  branch: element("git-branch"),
  sync: element("git-sync-state"),
  ahead: element("git-ahead"),
  behind: element("git-behind"),
  refresh: element("git-refresh"),
  message: element("git-message"),
  files: element("git-file-list"),
  empty: element("git-empty"),
  pull: element("git-pull"),
  push: element("git-push"),
  commitForm: element("git-commit-form"),
  commitMessage: element("git-commit-message"),
  commit: element("git-commit"),
  stagedCount: element("git-staged-count"),
  commitHint: element("git-commit-hint"),
  diffDialog: element("git-diff-dialog"),
  diffTitle: element("git-diff-title"),
  diffPath: element("git-diff-path"),
  diffContent: element("git-diff-content"),
  diffClose: element("git-diff-close"),
  diffWorking: element("git-diff-working"),
  diffStaged: element("git-diff-staged"),
};

attachScrollbars(element("git-scroll-frame"), element("git-scroll"), { horizontal: false });
let gitStatus = null;
let gitLoading = false;
let gitRefreshTimer = null;
let gitDiffPath = null;
let gitDiffStaged = false;
let gitDiffSequence = 0;
let gitFilesSignature = null;
const collapsedGitGroups = new Set();

function validateGitStatus(value) {
  if (!value || typeof value.available !== "boolean" || typeof value.repository !== "boolean"
      || typeof value.clean !== "boolean" || !Array.isArray(value.files)
      || value.files.some((file) => typeof file?.path !== "string"
        || typeof file.indexStatus !== "string" || typeof file.worktreeStatus !== "string")) {
    throw new ApiError("The service returned incomplete Git status.");
  }
  return value;
}

function gitMessage(text, state = "") {
  notice(gitUi.message, text, state);
  gitUi.message.dataset.state = state;
}

function gitCount(element, count) {
  setText(element, String(count));
  element.hidden = !count;
}

function isGitStaged(file) {
  return ![".", "?", "U"].includes(file.indexStatus) && file.worktreeStatus !== "U";
}

function gitIcon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(svg.namespaceURI, "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function gitFileRow(file, staged) {
  const code = staged ? file.indexStatus : file.worktreeStatus;
  const description = {
    "?": "Untracked", M: "Modified", A: "Added", D: "Deleted",
    R: "Renamed", C: "Copied", U: "Conflict", T: "Type changed",
  }[code] ?? code;
  const item = document.createElement("li");
  item.dataset.path = file.path;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "git-file-open";
  open.dataset.gitDiffPath = file.path;
  open.dataset.staged = String(staged);
  open.title = `${file.path}${file.originalPath ? ` (from ${file.originalPath})` : ""}`;
  open.setAttribute("aria-label", `${file.path}, ${description}, ${staged ? "staged" : "working tree"} diff`);
  const state = document.createElement("span");
  state.className = "git-file-state";
  state.dataset.status = code;
  state.textContent = code;
  state.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "git-file-label";
  const name = document.createElement("span");
  name.className = "git-file-name";
  name.textContent = file.path.split("/").at(-1);
  const path = document.createElement("span");
  path.className = "git-file-path";
  path.textContent = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/")) : description;
  label.append(name, path);
  open.append(state, label);
  item.append(open, gitActionButton(staged ? "Unstage" : "Stage", staged ? "unstage" : "stage", file.path));
  return item;
}

function gitGroup(label, files, staged) {
  const group = document.createElement("details");
  group.className = "git-group";
  group.dataset.group = staged ? "staged" : "working";
  group.open = !collapsedGitGroups.has(group.dataset.group);
  const summary = document.createElement("summary");
  const name = document.createElement("span");
  name.textContent = label;
  const count = document.createElement("span");
  count.className = "git-count";
  count.textContent = String(files.length);
  summary.append(name, count);
  const list = document.createElement("ul");
  list.className = "git-file-list";
  list.setAttribute("aria-label", label);
  list.append(...files.map((file) => gitFileRow(file, staged)));
  group.append(summary, list);
  group.addEventListener("toggle", () => {
    if (!group.isConnected) return;
    if (group.open) collapsedGitGroups.delete(group.dataset.group);
    else collapsedGitGroups.add(group.dataset.group);
  });
  return group;
}

function renderGitStatus(status) {
  gitStatus = status;
  setText(gitUi.branch, status.repository
    ? status.branch === "(detached)" ? "Detached HEAD" : status.branch || "Unborn branch"
    : "Source control");
  gitUi.branch.title = gitUi.branch.textContent;
  setText(gitUi.sync, status.upstream ?? (status.repository ? "No upstream configured" : "Local version history"));
  gitUi.sync.title = gitUi.sync.textContent;
  gitCount(gitUi.ahead, status.ahead);
  gitCount(gitUi.behind, status.behind);
  gitMessage(status.message ?? (status.clean ? "Working tree clean." : ""));
  gitUi.empty.hidden = !status.repository || status.files.length > 0 || !status.clean;
  gitUi.commitForm.hidden = !status.repository;
  const signature = JSON.stringify(status.files);
  if (signature !== gitFilesSignature) {
    const staged = status.files.filter(isGitStaged);
    const working = status.files.filter((file) => file.worktreeStatus !== ".");
    const fragment = document.createDocumentFragment();
    if (staged.length) fragment.append(gitGroup("Staged changes", staged, true));
    if (working.length) fragment.append(gitGroup("Changes", working, false));
    gitUi.files.replaceChildren(fragment);
    gitFilesSignature = signature;
  }
  refreshGitControls();
}

function gitActionButton(label, action, path) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "git-file-action";
  button.setAttribute("aria-label", `${label} ${path}`);
  button.title = `${label} ${path}`;
  button.append(gitIcon(action === "stage" ? "M10 4v12M4 10h12" : "M4 10h12"));
  button.dataset.gitAction = action;
  button.dataset.path = path;
  button.disabled = gitLoading;
  return button;
}

function refreshGitControls() {
  const staged = gitStatus?.files.filter(isGitStaged).length ?? 0;
  const unavailable = gitLoading || connectionState !== "ready" || !gitStatus?.repository || !projectOwns();
  gitUi.panel.setAttribute("aria-busy", String(gitLoading));
  gitUi.refresh.disabled = gitLoading || connectionState !== "ready";
  gitUi.pull.disabled = unavailable || !gitStatus?.clean || !gitStatus?.upstream;
  gitUi.push.disabled = unavailable || !gitStatus?.upstream;
  gitUi.commit.disabled = unavailable || !staged || !gitUi.commitMessage.value.trim();
  gitCount(gitUi.stagedCount, staged);
  setText(gitUi.commitHint, staged
    ? `${staged} staged ${staged === 1 ? "file" : "files"} · commits stay local until pushed.`
    : "Stage changes before committing.");
  for (const button of gitUi.files.querySelectorAll("[data-git-action]")) {
    button.disabled = unavailable;
  }
}

function scheduleGitRefresh() {
  window.clearTimeout(gitRefreshTimer);
  gitRefreshTimer = null;
  if (!webPreferences.gitRefreshSeconds || gitUi.panel.hidden || connectionState !== "ready"
      || document.visibilityState === "hidden") return;
  gitRefreshTimer = window.setTimeout(() => void refreshGit(), webPreferences.gitRefreshSeconds * 1000);
}

async function refreshGit() {
  window.clearTimeout(gitRefreshTimer);
  gitRefreshTimer = null;
  if (connectionState !== "ready" || gitLoading || !projectHasGit()) return;
  const generation = projectGeneration;
  gitLoading = true;
  gitMessage("Refreshing Git status…");
  refreshGitControls();
  let next = null;
  try {
    next = validateGitStatus(await api("/api/git"));
    if (generation !== projectGeneration) next = null;
  } catch (error) {
    gitMessage(`Git status failed: ${error.message}`, "error");
    if (error.network) connectionFailure(error);
  } finally {
    gitLoading = false;
    if (next) renderGitStatus(next);
    else refreshGitControls();
    scheduleGitRefresh();
  }
}

async function runGitAction(body) {
  if (!projectOwns()) return;
  if (gitLoading || connectionState !== "ready") return;
  if (body.action === "pull" && (pendingSave || dirty())) {
    gitMessage("Save your current note before pulling.", "error");
    return;
  }
  gitLoading = true;
  gitMessage(`${{ stage: "Staging", unstage: "Unstaging", commit: "Committing", pull: "Pulling", push: "Pushing" }[body.action]}…`);
  refreshGitControls();
  let next = null;
  try {
    next = validateGitStatus(await api("/api/git", { method: "POST", body }));
    if (body.action === "commit") gitUi.commitMessage.value = "";
    void refreshFiles();
  } catch (error) {
    gitMessage(`Git ${body.action} failed: ${error.message}`, "error");
    if (error.network) connectionFailure(error);
  } finally {
    gitLoading = false;
    if (next) renderGitStatus(next);
    else refreshGitControls();
    scheduleGitRefresh();
  }
}

function renderGitDiff(text) {
  const lines = text.split("\n");
  const limit = Math.min(lines.length, 20_000);
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < limit; index += 1) {
    const line = document.createElement("span");
    const value = lines[index];
    line.className = value.startsWith("+") && !value.startsWith("+++")
      ? "is-added" : value.startsWith("-") && !value.startsWith("---")
        ? "is-removed" : value.startsWith("@@") ? "is-hunk" : "";
    line.textContent = value || " ";
    fragment.append(line);
  }
  if (lines.length > limit) {
    const omitted = document.createElement("span");
    omitted.textContent = `\n… ${lines.length - limit} more lines are not displayed.\n`;
    fragment.append(omitted);
  }
  gitUi.diffContent.replaceChildren(fragment);
}

async function openGitDiff(path, staged = webPreferences.gitDefaultDiff === "staged") {
  const sequence = ++gitDiffSequence;
  gitDiffPath = path;
  gitDiffStaged = staged;
  setText(gitUi.diffTitle, staged ? "Staged diff" : "Working tree diff");
  setText(gitUi.diffPath, path);
  gitUi.diffWorking.setAttribute("aria-pressed", String(!staged));
  gitUi.diffStaged.setAttribute("aria-pressed", String(staged));
  gitUi.diffContent.textContent = "Loading diff…";
  if (!gitUi.diffDialog.open) gitUi.diffDialog.showModal();
  try {
    const resource = resourceLocations.get(resourceLocation(activeProject?.id ?? "local", path));
    if (!resource) throw new ApiError("Refresh Git status before opening this resource.");
    const query = new URLSearchParams({ id: resource.id, staged: String(staged) });
    const result = await api(`/api/git/diff?${query}`);
    if (sequence !== gitDiffSequence) return;
    renderGitDiff(result.text || "No textual diff for this file.");
  } catch (error) {
    if (sequence === gitDiffSequence) {
      gitUi.diffContent.textContent = `Could not load diff: ${error.message}`;
    }
  }
}

gitUi.refresh.addEventListener("click", () => void refreshGit());
gitUi.commitMessage.addEventListener("input", refreshGitControls);
gitUi.commitForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = gitUi.commitMessage.value.trim();
  if (message && !gitUi.commit.disabled) void runGitAction({ action: "commit", message });
});
gitUi.files.addEventListener("click", (event) => {
  const action = event.target.closest("[data-git-action]");
  if (action) {
    const resource = resourceLocations.get(resourceLocation(activeProject?.id ?? "local", action.dataset.path));
    if (!resource) { documentNotice("Refresh Git status before changing this resource.", "error"); return; }
    void runGitAction({ action: action.dataset.gitAction, ids: [resource.id] });
    return;
  }
  const open = event.target.closest("[data-git-diff-path]");
  if (open) void openGitDiff(open.dataset.gitDiffPath, open.dataset.staged === "true");
});
gitUi.pull.addEventListener("click", () => {
  if (window.confirm("Pull from the configured upstream using fast-forward only?")) {
    void runGitAction({ action: "pull", confirm: true });
  }
});
gitUi.push.addEventListener("click", () => {
  if (window.confirm("Push committed changes to the configured upstream?")) {
    void runGitAction({ action: "push", confirm: true });
  }
});
gitUi.diffWorking.addEventListener("click", () => void openGitDiff(gitDiffPath, false));
gitUi.diffStaged.addEventListener("click", () => void openGitDiff(gitDiffPath, true));
gitUi.diffClose.addEventListener("click", () => gitUi.diffDialog.close());
gitUi.diffDialog.addEventListener("close", () => {
  gitDiffSequence += 1;
  gitDiffPath = null;
  gitUi.diffContent.replaceChildren();
});
