import { test, expect, fs, path, root, openFixture, chooseView } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

test("round-trip validation preserves canonical and noncanonical bodies through editing and undo", async ({ page }) => {
  for (const [index, body] of [
    "# Title\n\nPlain text.\n",
    "# Title\n\nPlain text.\n\n\n",
    "# Title\n\n```text\nliteral  \n\n```\n\n",
    "# Title\n\n<div>literal\n\ncontent</div>\n\n",
  ].entries()) {
    await openFixture(page, `Roundtrip${index}.md`, body);
    const heading = page.locator(".ProseMirror h1").first();
    await heading.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("X");
    await expect(heading).toHaveText("TitleX");
    if (body.includes("literal  ")) await expect(page.locator("#editor")).toHaveValue(/literal  \n/);
    if (body.includes("<div>")) await expect(page.locator("#editor")).toHaveValue(/<div>literal\n\ncontent<\/div>/);
    await page.keyboard.press("Control+z");
    await expect(heading).toHaveText("Title");
    await chooseView(page, "editor");
    await expect(page.locator("#editor")).toHaveValue(body);
  }
});

test("Live headings keep Rust-compatible anchors through typing and undo without duplicate source updates", async ({ page }) => {
  const content = "# Same\n\n# Same-2\n\n# Same\n\n## 你好 世界\n\nBody.\n";
  await openFixture(page, "Heading-anchors.md", content);
  const live = page.locator(".ProseMirror");
  const ids = () => live.locator("h1, h2").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(await ids()).toEqual(["same", "same-2", "same-3", "你好-世界"]);
  await live.locator("h1").first().click();
  await page.keyboard.press("End");
  await page.evaluate(() => {
    window.headingSourceUpdates = 0;
    document.getElementById("editor").addEventListener("input", () => { window.headingSourceUpdates += 1; });
  });
  await page.keyboard.insertText("X");
  await expect(live.locator("h1").first()).toHaveText("SameX");
  expect(await ids()).toEqual(["samex", "same-2", "same", "你好-世界"]);
  expect(await page.evaluate(() => window.headingSourceUpdates)).toBe(1);
  await page.keyboard.press("Control+z");
  await expect(live.locator("h1").first()).toHaveText("Same");
  expect(await ids()).toEqual(["same", "same-2", "same-3", "你好-世界"]);
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveCount(3);
  expect(await page.locator("#preview h1, #preview h2").evaluateAll((nodes) => nodes.map((node) => node.id)))
    .toEqual(["same", "same-2", "same-3", "你好-世界"]);
  await chooseView(page, "editor");
  await expect(page.locator("#editor")).toHaveValue(content);
});

test("hidden previews are materialized only on demand and keep the latest saved document", async ({ page }) => {
  await chooseView(page, "editor");
  await openFixture(page, "Deferred.md", `# Deferred preview\n\n${"A long paragraph.\n\n".repeat(120)}`);
  await chooseView(page, "editor");
  await expect(page.locator("#preview h1")).toHaveCount(0);
  let previewRequests = 0;
  page.on("request", (request) => { if (request.url().includes("/api/preview")) previewRequests += 1; });
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Deferred preview");
  expect(previewRequests).toBe(0);
  await page.locator("#preview").evaluate((node) => { node.scrollTop = 300; });
  await chooseView(page, "editor");
  await page.locator('[data-path="Second.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  await page.locator("#editor").fill("# Saved while hidden\n\nNew body.\n");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#preview h1")).toHaveText("Deferred preview");
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Saved while hidden");
  expect(await page.locator("#preview").evaluate((node) => node.scrollTop)).toBe(0);
  expect(previewRequests).toBe(0);
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# Unsaved preview\n");
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Unsaved preview");
  expect(previewRequests).toBe(1);
});

test("workspace opens from cached account data before a delayed refresh and surfaces failures", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  let release;
  try {
    const [page] = library.pages;
    await page.locator("#more-menu > summary").click();
    await page.locator("#workspace-favorite").click();
    await expect(page.locator("#workspace-favorite")).toHaveText("Remove from favorites");
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/workspace", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await gate;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Workspace temporarily unavailable." }) });
    });
    await page.locator("#more-menu > summary").click();
    await page.locator("#workspace-open").click();
    await expect(page.locator("#workspace-dialog")).toBeVisible();
    await expect(page.locator("#workspace-list")).toContainText("Shared");
    await page.locator("#workspace-filter").fill("Shared");
    await expect(page.locator(".workspace-item-name")).toHaveCount(1);
    release();
    await expect(page.locator("#document-message")).toContainText("Could not load your workspace");
    await expect(page.locator(".workspace-item-name")).toHaveCount(1);
  } finally { release?.(); await library.close(); }
});

test("document navigation resets Source scrolling before paint without a stale frame changing the next note", async ({ page }) => {
  await fs.writeFile(path.join(root, "Scroll-next.md"), `# Next note\n\n${"Line of source.\n".repeat(2000)}`);
  await openFixture(page, "Scroll-first.md", `# First note\n\n${"Line of source.\n".repeat(2000)}`);
  await chooseView(page, "editor");
  await page.locator("#refresh-files").click();
  const editor = page.locator("#editor");
  await editor.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => editor.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.locator('[data-path="Scroll-next.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Scroll-next.md");
  await expect.poll(() => editor.evaluate((node) => node.scrollTop)).toBe(0);
  await page.locator('[data-path="Scroll-first.md"]').click();
  await page.locator('[data-path="Second.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  await expect(editor).toHaveValue("# Second\n\nAnother note.\n");
  await expect.poll(() => editor.evaluate((node) => node.scrollTop)).toBe(0);
});
