import { test, expect, buildRoot, path } from "./fixture.mjs";

const gitRoute = /\/api\/git(?:\/diff)?(?:\?|$)/;
const status = (files = [], extra = {}) => ({
  available: true, repository: true, branch: "main", oid: "abc123",
  upstream: "origin/main", ahead: 0, behind: 0, clean: files.length === 0,
  files, message: null, ...extra,
});
const fileIds = new Map();
const file = (path, indexStatus = ".", worktreeStatus = "M") => {
  if (!fileIds.has(path)) fileIds.set(path, `01961e0b-9831-7000-8000-${(fileIds.size + 1).toString(16).padStart(12, "0")}`);
  return { id: fileIds.get(path), kind: "document", path, originalPath: null, indexStatus, worktreeStatus };
};

test("Git sidebar renders status, line diff and confirmed write actions", async ({ page }) => {
  const actions = [];
  let staged = false;
  let clean = false;
  await page.route(gitRoute, async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname === "/api/git/diff") {
      await route.fulfill({ json: { path: "README.md", staged: false, text: "@@ -1 +1 @@\n-old\n+new\n" } });
      return;
    }
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      actions.push(body.action);
      if (body.action === "stage") staged = true;
      if (body.action === "unstage") staged = false;
      if (body.action === "commit") { staged = false; clean = true; }
      if (body.action === "push") expect(body.confirm).toBe(true);
    }
    await route.fulfill({ json: status(clean ? [] : [
      file("README.md", staged ? "M" : ".", staged ? "." : "M"),
    ], { ahead: clean ? 1 : 0 }) });
  });
  await page.locator("#git-tab").click();
  await expect(page.locator("#git-branch")).toHaveText("main");
  await page.locator("[data-git-diff-path='README.md']").click();
  await expect(page.locator("#git-diff-dialog")).toBeVisible();
  await expect(page.locator("#git-diff-content .is-added")).toContainText("+new");
  await page.locator("#git-diff-close").click();
  await page.getByRole("button", { name: "Stage README.md", exact: true }).click();
  await expect(page.getByRole("list", { name: "Staged changes" })).toContainText("README.md");
  await page.getByRole("button", { name: "Unstage README.md", exact: true }).click();
  await expect(page.getByRole("list", { name: "Changes", exact: true })).toContainText("README.md");
  await page.getByRole("button", { name: "Stage README.md", exact: true }).click();
  await page.locator("#git-commit-message").fill("Update README");
  await page.locator("#git-commit").click();
  await expect(page.locator("#git-message")).toHaveText("Working tree clean.");
  await expect(page.locator("#git-empty")).toBeVisible();
  await expect(page.locator("#git-ahead")).toHaveText("1");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#git-push").click();
  expect(actions).toEqual(["stage", "unstage", "stage", "commit"]);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#git-push").click();
  await expect.poll(() => actions).toEqual(["stage", "unstage", "stage", "commit", "push"]);
});

test("Git groups retain focus and drafts, show errors and open the matching diff", async ({ page }) => {
  const files = [file("docs/weekly/Research.md", "M", "M"), file("New.md", "?", "?")];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(gitRoute, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/git/diff") {
      await route.fulfill({ json: {
        text: url.searchParams.get("staged") === "true" ? "+Staged content" : "+Working content",
      } });
    } else if (request.method() === "POST") {
      await held;
      await route.fulfill({ status: 400, json: { error: "Git identity is not configured." } });
    } else {
      await route.fulfill({ json: status(files) });
    }
  });
  await page.locator("#git-tab").click();
  const changes = page.getByRole("list", { name: "Changes", exact: true });
  const staged = page.getByRole("list", { name: "Staged changes", exact: true });
  await expect(changes.locator("li")).toHaveCount(2);
  await expect(staged.locator("li")).toHaveCount(1);
  for (const [list, expected] of [[staged, "+Staged content"], [changes, "+Working content"]]) {
    await list.locator("[data-git-diff-path='docs/weekly/Research.md']").click();
    await expect(page.locator("#git-diff-content")).toContainText(expected);
    await page.locator("#git-diff-close").click();
  }
  await page.locator("#git-commit-message").fill("Keep this draft");
  const original = await staged.locator("li").elementHandle();
  await page.locator("#git-refresh").click();
  await expect(page.locator("#git-panel")).toHaveAttribute("aria-busy", "false");
  expect(await original.evaluate((node) => node.isConnected)).toBe(true);
  await expect(page.locator("#git-commit-message")).toHaveValue("Keep this draft");
  try {
    await page.locator("#git-commit").click();
    await expect(page.locator("#git-refresh")).toBeDisabled();
    await expect(page.locator("#git-push")).toBeDisabled();
    await expect(page.locator("#git-commit")).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.locator("#git-message")).toContainText("Git identity is not configured.");
  await expect(page.locator("#git-message")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#git-commit-message")).toHaveValue("Keep this draft");
});

test("Git layout fits narrow sidebars and has a continuous Notes divider", async ({ page }) => {
  const files = [
    file("docs/weekly/LLM/20260918.md", "?", "?"),
    file("research/experiments/very-long-folder-name/training-observations-and-follow-up.md"),
    file("README.md", "M", "."),
    file("archive/previous-notes.md", ".", "D"),
    ...Array.from({ length: 18 }, (_, index) => file(`notes/Note-${index}.md`)),
  ];
  await page.route(gitRoute, (route) => route.fulfill({
    json: status(files, { branch: "feature/document-editor-refinement", ahead: 2, behind: 1 }),
  }));
  await page.locator("#git-tab").click();
  await expect(page.locator(".git-group")).toHaveCount(2);
  await page.locator("#git-commit-message").fill("Refine the research notes");
  await page.locator("#document-title").click();
  const seam = () => page.evaluate(() => {
    const sidebar = document.querySelector("#sidebar").getBoundingClientRect();
    const divider = document.querySelector("#sidebar-resizer");
    const bounds = divider.getBoundingClientRect();
    const main = document.querySelector(".document-area").getBoundingClientRect();
    return {
      before: bounds.left - sidebar.right,
      after: main.left - bounds.right,
      width: bounds.width,
      background: getComputedStyle(divider).backgroundColor,
      border: getComputedStyle(document.documentElement).getPropertyValue("--border").trim(),
    };
  });
  const regular = await seam();
  expect(regular.before).toBe(0);
  expect(regular.after).toBe(0);
  expect(regular.width).toBe(1);
  expect(regular.background).not.toBe("rgba(0, 0, 0, 0)");
  for (const theme of ["light", "dark"]) {
    await page.route("**/api/appearance", (route) => route.fulfill({
      json: { theme, latinFont: "sans-serif", cjkFont: "sans-serif" },
    }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.screenshot({ path: path.join(buildRoot, `git-redesign-${theme}.png`) });
  }
  await page.locator("#sidebar-resizer").focus();
  for (let index = 0; index < 5; index += 1) await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#sidebar-resizer")).toHaveAttribute("aria-valuenow", "210");
  expect((await seam()).before).toBe(0);
  const sizes = await page.locator("#git-scroll").evaluate((element) => ({
    client: element.clientWidth, scroll: element.scrollWidth,
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
  expect(await page.locator("#git-file-list").evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).paddingLeft))).toBeGreaterThanOrEqual(12);
  const form = await page.locator("#git-commit-form").boundingBox();
  const sidebar = await page.locator("#sidebar").boundingBox();
  expect(form.x).toBeGreaterThanOrEqual(sidebar.x);
  expect(form.x + form.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
  await page.screenshot({ path: path.join(buildRoot, "git-redesign-narrow.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#sidebar-toggle").click();
  await expect(page.locator("#git-panel")).toBeVisible();
  await page.screenshot({ path: path.join(buildRoot, "git-redesign-mobile.png") });
});

test("Git unavailable state keeps repository actions disabled", async ({ page }) => {
  await page.route(gitRoute, (route) => route.fulfill({
    json: status([], { repository: false, message: "The notes folder is not a Git repository." }),
  }));
  await page.locator("#git-tab").click();
  await expect(page.locator("#git-message")).toContainText("not a Git repository");
  await expect(page.locator("#git-commit-form")).toBeHidden();
  await expect(page.locator("#git-pull")).toBeDisabled();
  await expect(page.locator("#git-push")).toBeDisabled();
  await expect(page.locator("#git-empty")).toBeHidden();
});

test("Git hover and restored focus stay soft without a changed-file notice", async ({ page }) => {
  let fail = false;
  await page.route(gitRoute, (route) => {
    if (new URL(route.request().url()).pathname === "/api/git/diff") {
      return route.fulfill({ json: { text: "@@ -1 +1 @@\n-old\n+new\n" } });
    }
    return fail
      ? route.fulfill({ status: 503, json: { error: "Git is temporarily unavailable." } })
      : route.fulfill({ json: status([file("README.md")]) });
  });
  await page.locator("#git-tab").click();
  await expect(page.locator("#git-message")).toBeHidden();
  await expect(page.getByText("1 changed file.", { exact: true })).toHaveCount(0);
  const summary = page.locator(".git-group > summary");
  const row = page.locator(".git-file-list li");
  const open = row.locator(".git-file-open");
  const focusStyle = () => open.evaluate((node) => ({
    outline: getComputedStyle(node).outlineStyle,
    marker: getComputedStyle(node).boxShadow,
  }));
  for (const theme of ["light", "dark"]) {
    await page.route("**/api/appearance", (route) => route.fulfill({
      json: { theme, latinFont: "sans-serif", cjkFont: "sans-serif" },
    }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await summary.hover();
    expect(await summary.evaluate((node) =>
      parseFloat(getComputedStyle(node).borderRadius))).toBe(6);
    await page.screenshot({ path: path.join(buildRoot, `git-hover-${theme}.png`) });
    await open.hover();
    expect(await open.evaluate((node) =>
      parseFloat(getComputedStyle(node).borderRadius))).toBe(6);
    await open.click();
    await expect(page.locator("#git-diff-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#git-diff-dialog")).toBeHidden();
    await expect(open).toBeFocused();
    expect((await focusStyle()).outline).toBe("none");
    await page.screenshot({ path: path.join(buildRoot, `git-escape-${theme}.png`) });
  }
  await summary.focus();
  await page.keyboard.press("Tab");
  await expect(open).toBeFocused();
  expect((await focusStyle()).marker).toBe("none");
  expect(await open.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await page.keyboard.press("Enter");
  await expect(page.locator("#git-diff-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  expect((await focusStyle()).outline).toBe("none");
  fail = true;
  await page.locator("#git-refresh").click();
  await expect(page.locator("#git-message")).toBeVisible();
  await expect(page.locator("#git-message")).toContainText("Git is temporarily unavailable.");
  fail = false;
  await page.locator("#git-refresh").click();
  await expect(page.locator("#git-message")).toBeHidden();
});
