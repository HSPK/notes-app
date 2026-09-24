const gitSyncUi = {
  enabled: element("settings-git-sync-enabled"),
  interval: element("settings-git-sync-interval"),
  summary: element("settings-git-sync-summary"),
};
const gitSyncNotice = document.createElement("p");
gitSyncNotice.className = "notice";
gitSyncNotice.id = "git-sync-message";
gitSyncNotice.setAttribute("role", "status");
gitSyncNotice.hidden = true;
statusNotices.append(gitSyncNotice);
let gitSyncSettings = null;
let gitSyncProject = null;
let gitSyncLoading = false;
let gitSyncTimer = null;
let gitSyncGeneration = 0;

function validateGitSync(value) {
  if (!value || typeof value.enabled !== "boolean" || !Number.isInteger(value.intervalMinutes)
      || value.intervalMinutes < 1 || value.intervalMinutes > 1440 || typeof value.running !== "boolean"
      || ["branch", "upstream", "error"].some(key => value[key] !== null && typeof value[key] !== "string")
      || ["nextRunAt", "lastRunAt", "lastSuccessAt"].some(key => value[key] !== null && !Number.isSafeInteger(value[key]))) {
    throw new ApiError("The service returned invalid automatic Git sync settings.");
  }
  return value;
}

function showGitSyncStatus(value) {
  const time = seconds => new Date(seconds * 1000).toLocaleString();
  const summary = !value.enabled ? "Automatic sync is off."
    : `${value.branch} → ${value.upstream}. ${value.running ? "Syncing…" : value.nextRunAt ? `Next: ${time(value.nextRunAt)}.` : "Waiting for scheduler."}`
      + (value.lastSuccessAt ? ` Last success: ${time(value.lastSuccessAt)}.` : "");
  setText(gitSyncUi.summary, summary);
  notice(gitSyncNotice, value.enabled && value.error ? `Automatic Git sync failed: ${value.error}` : value.running ? "Committing and pushing project changes…" : "", value.error ? "error" : "");
}

function populateGitSyncSettings() {
  gitSyncGeneration += 1;
  gitSyncSettings = null;
  gitSyncProject = activeProject?.id ?? null;
  gitSyncUi.enabled.checked = false;
  gitSyncUi.interval.value = "30";
  gitSyncUi.enabled.disabled = true;
  gitSyncUi.interval.disabled = true;
  setText(gitSyncUi.summary, activeProject?.owned ? "Loading automatic sync settings…" : "Only the project owner can configure automatic Git sync.");
  if (activeProject?.owned) void refreshGitSync(true);
}

async function refreshGitSync(populate = false) {
  if (!activeProject?.owned || publicView || connectionState !== "ready") return;
  if (gitSyncLoading && !populate) return;
  const generation = gitSyncGeneration;
  const project = activeProject.id;
  gitSyncLoading = true;
  try {
    const value = validateGitSync(await api("/api/git/sync"));
    if (generation !== gitSyncGeneration || project !== activeProject?.id) return;
    showGitSyncStatus(value);
    if (populate && ui.settingsDialog.open) {
      gitSyncSettings = value;
      gitSyncProject = project;
      gitSyncUi.enabled.checked = value.enabled;
      gitSyncUi.interval.value = String(value.intervalMinutes);
      gitSyncUi.enabled.disabled = false;
      gitSyncUi.interval.disabled = false;
    }
  } catch (error) {
    if (generation === gitSyncGeneration && project === activeProject?.id) {
      notice(gitSyncNotice, `Automatic Git sync status unavailable: ${error.message}`, "error");
    }
  } finally {
    gitSyncLoading = false;
    clearTimeout(gitSyncTimer);
    if (activeProject?.owned) gitSyncTimer = setTimeout(() => {
      if (document.visibilityState !== "hidden") void refreshGitSync();
    }, 30_000);
  }
}

async function saveGitSyncSettings() {
  if (!activeProject?.owned) return;
  if (gitSyncProject !== activeProject.id) {
    throw new ApiError("The project changed. Reopen Settings before saving.");
  }
  if (!gitSyncSettings && gitSyncUi.enabled.disabled) return;
  const enabled = gitSyncUi.enabled.checked;
  const intervalMinutes = Number(gitSyncUi.interval.value);
  if (enabled === gitSyncSettings.enabled && intervalMinutes === gitSyncSettings.intervalMinutes) return;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    throw new ApiError("Choose a Git sync interval from 1 to 1440 minutes.");
  }
  if (enabled && !window.confirm("Enable automatic commit and push for this project? All saved, non-ignored files and deletions, including changes by other users, will be committed and pushed to this branch's upstream without further confirmation.")) {
    throw new ApiError("Automatic Git sync was not enabled.");
  }
  const value = validateGitSync(await api("/api/git/sync", {
    method: "PUT", body: { enabled, intervalMinutes, confirm: enabled },
  }));
  gitSyncSettings = value;
  showGitSyncStatus(value);
}

function resetGitSyncStatus() {
  gitSyncGeneration += 1;
  gitSyncSettings = null;
  gitSyncProject = null;
  clearTimeout(gitSyncTimer);
  notice(gitSyncNotice, "");
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshGitSync();
});
