import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, fs, path, buildRoot } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

const execute = promisify(execFile);

test("project owners can configure confirmed scheduled commit and push without affecting other projects", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { source: true });
  const remote = await fs.mkdtemp(path.join(buildRoot, "git-sync-remote-"));
  try {
    const git = args => execute("git", ["-C", library.notes, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    await execute("git", ["init", "--bare", remote]);
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Sync Browser Test"]);
    await git(["config", "user.email", "sync-browser@example.invalid"]);
    await git(["add", "."]);
    await git(["commit", "-m", "Initial"]);
    await git(["remote", "add", "origin", remote]);
    await git(["push", "-u", "origin", "main"]);
    const [alice, bob] = library.pages;
    await alice.locator("#settings-open").click();
    await alice.locator('[data-settings-tab="git"]').click();
    const enabled = alice.locator("#settings-git-sync-enabled");
    const interval = alice.locator("#settings-git-sync-interval");
    await expect(enabled).toBeEnabled();
    await expect(enabled).not.toBeChecked();
    await expect(interval).toHaveValue("30");
    await enabled.check();
    await interval.fill("15");
    alice.once("dialog", dialog => dialog.dismiss());
    await alice.locator("#settings-save").click();
    await expect(alice.locator("#settings-error")).toContainText("not enabled");
    let state = await (await alice.request.get(new URL("/api/git/sync", library.url).href)).json();
    expect(state.enabled).toBe(false);
    alice.once("dialog", dialog => dialog.accept());
    await alice.locator("#settings-save").click();
    await expect(alice.locator("#settings-dialog")).toBeHidden();
    state = await (await alice.request.get(new URL("/api/git/sync", library.url).href)).json();
    expect(state.enabled).toBe(true);
    expect(state.intervalMinutes).toBe(15);
    expect(state.upstream).toBe("origin/main");
    await bob.locator("#settings-open").click();
    await bob.locator('[data-settings-tab="git"]').click();
    await expect(bob.locator("#settings-git-sync-enabled")).toBeDisabled();
    await expect(bob.locator("#settings-git-sync-summary")).toContainText("Only the project owner");
    const denied = await bob.request.put(new URL("/api/git/sync", library.url).href, {
      data: { enabled: false, intervalMinutes: 5 },
    });
    expect(denied.status()).toBe(403);
    await alice.locator("#settings-open").click();
    await alice.locator('[data-settings-tab="git"]').click();
    await expect(enabled).toBeEnabled();
    await expect(enabled).toBeChecked();
    await expect(interval).toHaveValue("15");
    await alice.screenshot({ path: path.join(buildRoot, "scheduled-git-settings.png") });
    await enabled.uncheck();
    await alice.locator("#settings-save").click();
    await expect(alice.locator("#settings-dialog")).toBeHidden();
    expect((await (await alice.request.get(new URL("/api/git/sync", library.url).href)).json()).enabled).toBe(false);
  } finally { await library.close(); await fs.rm(remote, { recursive: true, force: true }); }
});

test("automatic Git sync settings show backend failures without enabling an invalid repository", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private" });
  try {
    const [page] = library.pages;
    await page.locator("#settings-open").click();
    await page.locator('[data-settings-tab="git"]').click();
    await expect(page.locator("#settings-git-sync-enabled")).toBeEnabled();
    await page.locator("#settings-git-sync-enabled").check();
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-error")).toBeVisible();
    await expect(page.locator("#settings-dialog")).toBeVisible();
    const status = await (await page.request.get(new URL("/api/git/sync", library.url).href)).json();
    expect(status.enabled).toBe(false);
  } finally { await library.close(); }
});
