import { test, expect, fs, path, root, buildRoot, initialText, chooseView, openFixture } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

test("unsaved title marker stays visible for long titles and clears on undo and save", async ({ page }) => {
  await page.route("**/api/preferences", async route => {
    const response = await route.fetch();
    const preferences = await response.json();
    await route.fulfill({ response, json: {
      ...preferences, web: { ...preferences.web, autoSaveDelayMs: 10_000 },
    } });
  });
  const title = "A long document title ".repeat(8).trim();
  await openFixture(page, "Status.md", `---\ntitle: "${title}"\n---\n\n# Body\n`, title);
  await page.setViewportSize({ width: 960, height: 720 });
  await chooseView(page, "editor");
  const status = page.locator("#dirty-indicator");
  const marker = page.locator("#document-modified");
  const source = page.locator("#editor");
  const panes = await page.locator("#document-panes").boundingBox();
  await expect(status).toBeHidden();
  await expect(status).toHaveText("");
  await source.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("Unfinished");
  await expect(marker).toHaveText(" *");
  await expect(marker).toBeVisible();
  await expect(page).toHaveTitle(`${title} * — Notes`);
  await expect(status).toBeHidden();
  await expect(status).toHaveText("");
  expect(await page.locator("#document-panes").boundingBox()).toEqual(panes);
  expect(await page.locator("#document-name").evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  const markerBounds = await marker.boundingBox();
  const titleBounds = await page.locator("#document-title").boundingBox();
  expect(markerBounds.x + markerBounds.width).toBeLessThanOrEqual(titleBounds.x + titleBounds.width + 1);
  await page.screenshot({ path: path.join(buildRoot, "quiet-save-status-dirty.png") });
  await page.keyboard.press("Control+z");
  await expect(marker).toBeHidden();
  await expect(page).toHaveTitle(`${title} — Notes`);
  await page.keyboard.press("Control+Shift+z");
  await expect(marker).toBeVisible();

  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/api/document", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    await held;
    await route.continue();
  });
  try {
    await page.keyboard.press("Control+s");
    await expect(status).toHaveAttribute("data-state", "saving");
    await expect(status).toBeVisible();
    await expect(marker).toBeVisible();
  } finally { release(); }
  await expect(status).toHaveAttribute("data-state", "saved");
  await expect(status).toBeHidden();
  await expect(status).toHaveText("");
  await expect(marker).toBeHidden();
  await expect(page).toHaveTitle(`${title} — Notes`);
  expect(await fs.readFile(path.join(root, "Status.md"), "utf8")).toContain("Unfinished");
  await page.locator('[data-path="Second.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  await expect(marker).toBeHidden();
  await page.screenshot({ path: path.join(buildRoot, "quiet-save-status-clean.png") });
});

test("save failures keep the title marker and explicit error feedback", async ({ page }) => {
  await chooseView(page, "editor");
  await page.route("**/api/document", route => route.request().method() === "PUT"
    ? route.fulfill({ status: 500, json: { error: "Save unavailable for status fixture." } })
    : route.continue());
  await page.locator("#editor").fill("# Unsaved after failure\n");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#document-message")).toContainText("Could not save:");
  await expect(page.locator("#document-message")).toBeVisible();
  await expect(page.locator("#document-title")).toHaveText("README.md *");
  await expect(page).toHaveTitle("README.md * — Notes");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  await expect(page.locator("#dirty-indicator")).toBeHidden();
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(initialText);
});

test("collaborative title markers clear for all participants after saving", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { source: true, saveDelay: 10_000 });
  try {
    const [alice, bob] = library.pages;
    await alice.locator("#editor").focus();
    await alice.keyboard.press("Control+End");
    await alice.keyboard.insertText("\nShared unsaved text\n");
    await expect(bob.locator("#editor")).toHaveValue(/Shared unsaved text/);
    for (const page of library.pages) {
      await expect(page.locator("#document-title")).toHaveText("Shared *");
      await expect(page).toHaveTitle("Shared * — Notes");
      await expect(page.locator("#dirty-indicator")).toBeHidden();
    }
    await alice.keyboard.press("Control+s");
    for (const page of library.pages) {
      await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
      await expect(page.locator("#dirty-indicator")).toBeHidden();
      await expect(page.locator("#document-title")).toHaveText("Shared");
      await expect(page.locator("#document-modified")).toBeHidden();
      await expect(page).toHaveTitle("Shared — Notes");
    }
  } finally { await library.close(); }
});
