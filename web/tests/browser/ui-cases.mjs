import {
  test, expect, fs, path, root, buildRoot, initialText, chooseView, openFixture, metadataField,
} from "./fixture.mjs";

test("slash commands insert blocks without a permanent formatting toolbar", async ({ page }) => {
  await openFixture(page, "Slash.md", "");
  const editor = page.locator(".ProseMirror[contenteditable=true]");
  await editor.focus();
  await editor.press("/");
  const menu = page.locator("#notes-slash-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option")).toHaveCount(10);
  await menu.getByRole("option", { name: /Heading 2/ }).click();
  await editor.pressSequentially("Slash heading");
  await expect(editor.getByRole("heading", { level: 2, name: "Slash heading" })).toBeVisible();
  await chooseView(page, "editor");
  await expect(page.locator("#view-label")).toHaveText("Source");
  await expect(page.locator("#editor")).toHaveValue(/^## Slash heading\n?$/);
});

test("sidebar and page width controls resize and persist across reloads", async ({ page }) => {
  const sidebar = page.locator("#sidebar");
  const resizer = page.locator("#sidebar-resizer");
  const initialSidebar = await sidebar.boundingBox();
  const handle = await resizer.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 120);
  await page.mouse.down();
  await page.mouse.move(handle.x + 72, handle.y + 120, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBeGreaterThan(initialSidebar.width + 50);

  const initialPageWidth = (await page.locator(".notes-live-page").boundingBox()).width;
  await page.locator("#layout-menu > summary").click();
  await page.getByRole("button", { name: /Wide/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-page-width", "wide");
  await expect.poll(async () => (await page.locator(".notes-live-page").boundingBox()).width)
    .toBeGreaterThan(initialPageWidth + 100);

  const resizedWidth = (await sidebar.boundingBox()).width;
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-page-width", "wide");
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBeCloseTo(resizedWidth, 0);
});

test("global command panel filters and runs document commands", async ({ page }) => {
  await expect(page.locator("#command-palette-open")).toBeHidden();
  await page.keyboard.press("Control+k");
  const dialog = page.locator("#command-dialog");
  await expect(dialog).toBeVisible();
  await page.locator("#command-query").fill("compare");
  await expect(page.locator("#command-list [role=option]")).toHaveCount(1);
  await page.locator("#command-query").press("Enter");
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "split");
  await expect(page.locator("#view-label")).toHaveText("Compare");

  await page.keyboard.press("Control+k");
  await page.locator("#command-query").fill("focused");
  await page.locator("#command-query").press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-page-width", "focused");
});

test("expanded browser and shared settings apply and persist across reloads", async ({ page }) => {
  await page.locator("#settings-open").click();
  const settingsBounds = await page.locator("#settings-dialog").boundingBox();
  expect(settingsBounds.width).toBeGreaterThanOrEqual(700);
  const tabsBounds = await page.locator(".settings-tabs").boundingBox();
  const contentBounds = await page.locator(".settings-content").boundingBox();
  expect(tabsBounds.x + tabsBounds.width).toBeLessThanOrEqual(contentBounds.x + 1);
  await page.screenshot({ path: path.join(buildRoot, "settings-redesign.png") });
  await page.locator("#settings-search").fill("shortcut");
  await expect(page.getByRole("tab", { name: "Library" })).toBeHidden();
  await page.locator("#settings-search").fill("");
  await page.getByRole("tab", { name: "Editor" }).click();
  await page.locator("#settings-auto-save").selectOption("2000");
  await page.locator("#settings-default-view").selectOption("source");
  await page.locator("#settings-line-wrap").uncheck();
  await page.locator("#settings-spellcheck").uncheck();
  await page.getByRole("tab", { name: "Appearance" }).click();
  await page.locator("#settings-theme").selectOption("dark");
  await page.locator("#settings-latin-font").fill("Arial");
  await page.locator("#settings-cjk-font").fill("SimSun");
  await page.locator("#settings-font-size").fill("19");
  await page.locator("#settings-line-height").fill("190");
  await page.locator("#settings-density").selectOption("compact");
  await page.getByRole("tab", { name: "Library" }).click();
  await page.locator("#hidden-patterns").fill("Second.md");
  await page.locator("#settings-tree-refresh").selectOption("30");
  await page.getByRole("tab", { name: "Layout" }).click();
  await page.locator("#settings-page-width").selectOption("wide");
  await page.locator("#settings-sidebar-width").fill("320");
  await page.locator("#settings-default-sidebar").selectOption("git");
  await page.locator("#settings-sidebar-open").check();
  await page.locator("#settings-dialog").getByRole("tab", { name: "Git" }).click();
  await page.locator("#settings-git-refresh").selectOption("5");
  await page.locator("#settings-git-untracked").uncheck();
  await page.locator("#settings-git-diff").selectOption("staged");
  await page.getByRole("tab", { name: "Performance" }).click();
  await page.locator("#settings-large-threshold").selectOption("1024");
  await page.locator("#settings-preview-delay").selectOption("500");
  await page.locator("#settings-outline-delay").selectOption("150");
  await page.getByRole("tab", { name: "Accessibility" }).click();
  await page.locator("#settings-reduced-motion").check();
  await page.locator("#settings-high-contrast").check();
  await page.locator("#settings-strong-focus").uncheck();
  await page.getByRole("tab", { name: "Shortcuts" }).click();
  await page.locator("#settings-command-shortcut").selectOption("primary-shift-p");
  await page.locator("#settings-dialog button[type=submit]").click();

  await expect(page.locator('button[data-path="Second.md"]')).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-page-width", "wide");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");
  await expect(page.locator("#editor")).toHaveAttribute("wrap", "off");
  expect(await page.locator("html").evaluate((element) =>
    element.style.getPropertyValue("--document-size"))).toBe("19px");
  await expect.poll(async () => (await page.locator("#sidebar").boundingBox()).width).toBeCloseTo(320, 0);
  await page.keyboard.press("Control+k");
  await expect(page.locator("#command-dialog")).toBeHidden();
  await page.keyboard.press("Control+Shift+p");
  await expect(page.locator("#command-dialog")).toBeVisible();
  await page.locator("#command-close").click();

  await page.reload();
  await expect(page.locator('button[data-path="Second.md"]')).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-page-width", "wide");
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "editor");
  await expect(page.locator("#view-label")).toHaveText("Source");
  await expect(page.locator("#git-tab")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+Shift+p");
  await expect(page.locator("#command-dialog")).toBeVisible();
});

test("recursive index hide rules apply immediately and survive refresh without hiding other notes", async ({ page }) => {
  const entries = ["index.md", "Glob-docs/index.md", "Glob-docs/topic/index.md", "Glob-docs/topic/keep.md"];
  const setRule = async (rule) => {
    await page.locator("#settings-open").click();
    await page.locator('[data-settings-tab="library"]').click();
    await page.locator("#hidden-patterns").fill(rule);
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-dialog")).toBeHidden();
  };
  try {
    await fs.mkdir(path.join(root, "Glob-docs/topic"), { recursive: true });
    await Promise.all(entries.map((name) => fs.writeFile(path.join(root, name), `# ${name}\n`)));
    await page.locator("#refresh-files").click();
    for (const name of entries) await expect(page.locator(`button[data-path="${name}"]`)).toHaveCount(1);
    await setRule("*/index.md");
    await expect(page.locator('button[data-path="Glob-docs/index.md"]')).toHaveCount(0);
    await expect(page.locator('button[data-path="index.md"]')).toHaveCount(1);
    await expect(page.locator('button[data-path="Glob-docs/topic/index.md"]')).toHaveCount(1);
    await setRule("**/index.md");
    for (const name of entries.slice(0, 3)) await expect(page.locator(`button[data-path="${name}"]`)).toHaveCount(0);
    await expect(page.locator('button[data-path="Glob-docs/topic/keep.md"]')).toHaveCount(1);
    await page.reload();
    await expect(page.locator("#document-title")).toHaveText("README.md");
    await expect(page.locator('button[data-path="Glob-docs/topic/keep.md"]')).toHaveCount(1);
    for (const name of entries.slice(0, 3)) await expect(page.locator(`button[data-path="${name}"]`)).toHaveCount(0);
    await page.locator("#settings-open").click();
    await page.locator('[data-settings-tab="library"]').click();
    await expect(page.locator("#hidden-patterns")).toHaveValue("**/index.md");
    await page.locator("#settings-cancel").click();
    await setRule("");
    for (const name of entries) await expect(page.locator(`button[data-path="${name}"]`)).toHaveCount(1);
  } finally {
    await fs.rm(path.join(root, "index.md"), { force: true });
    await fs.rm(path.join(root, "Glob-docs"), { recursive: true, force: true });
  }
});

test("writing surface has compact chrome in light, dark and hidden-sidebar frames", async ({ page }) => {
  const content = "# A quieter place to write\n\n"
    + "Keep your thoughts in plain Markdown. The page stays readable while you work, "
    + "and the paragraph under your cursor keeps its **formatting as you edit**.\n\n"
    + "## From an idea to a note\n\n"
    + "A little space makes room for a clearer thought. There are no cards around the document, "
    + "no permanent formatting ribbon, and nothing to publish before you start.\n\n"
    + "> Write first. Shape the details when they matter.\n\n"
    + "## A small example\n\n"
    + "```rust\nfn main() {\n    let message = \"Notes stay on this computer\";\n    println!(\"{message}\");\n}\n```\n\n"
    + "## Next steps\n\n- [x] Keep the original Markdown\n- [ ] Follow the next idea\n";
  await fs.writeFile(path.join(root, "README.md"), content);
  await page.reload();
  await expect(page.locator(".ProseMirror")).toContainText("A quieter place to write");
  await expect(page.locator("#format-toggle, #format-panel")).toHaveCount(0);
  const header = await page.locator(".document-header").boundingBox();
  expect(header.height).toBeLessThanOrEqual(55);
  const heading = await page.getByRole("heading", { name: "A quieter place to write", exact: true }).boundingBox();
  const paragraph = await page.locator(".ProseMirror p").first().boundingBox();
  expect(heading.y - header.height).toBeLessThanOrEqual(80);
  expect(paragraph.y - (heading.y + heading.height)).toBeLessThanOrEqual(45);
  await page.locator("#outline-tab").click();
  await page.screenshot({ path: path.join(buildRoot, "design-light-outline.png") });
  await page.locator(".ProseMirror p").first().click({ position: { x: 90, y: 18 } });
  await expect(page.locator(".ProseMirror strong")).toHaveText("formatting as you edit");
  await expect(page.locator(".ProseMirror")).not.toContainText("**");
  await page.screenshot({ path: path.join(buildRoot, "design-live-editing.png") });
  await page.locator("#document-title").click();
  await page.locator("#sidebar-toggle").click();
  await page.screenshot({ path: path.join(buildRoot, "design-light-hidden.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator("#sidebar-toggle").click();
  await page.screenshot({ path: path.join(buildRoot, "design-dark-outline.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 620, height: 850 });
  await expect(page.locator("#sidebar")).toBeHidden();
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  await page.locator("#sidebar-toggle").click();
  await expect(page.locator("#sidebar")).toBeVisible();
  await page.locator("#sidebar-scrim").click({ position: { x: 500, y: 100 } });
  await expect(page.locator("#sidebar")).toBeHidden();
});

test("body scrollbars overlay content without changing the writing width or source", async ({ page }) => {
  const short = "# Scroll test\n\nA short document.\n";
  const long = "# Scroll test\n\n" + "A longer paragraph for native scrolling and overlay sizing.\n\n".repeat(90);
  await openFixture(page, "Scrolling.md", short);
  const viewport = page.locator("[data-editor-scroller]");
  const geometry = () => viewport.evaluate((element) => {
    const page = element.querySelector(".notes-live-page").getBoundingClientRect();
    return { width: element.clientWidth, gutter: element.offsetWidth - element.clientWidth, pageWidth: page.width, pageLeft: page.left };
  });
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBeTruthy();
  const before = await geometry();
  expect(before.gutter).toBe(0);
  await chooseView(page, "editor");
  await page.locator("#editor").fill(long);
  await chooseView(page, "rich");
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBeTruthy();
  expect(await geometry()).toEqual(before);
  const scrollbar = page.locator("#rich-editor > .os-scrollbar-vertical");
  const handle = scrollbar.locator(".os-scrollbar-handle");
  await viewport.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => scrollbar.evaluate((element) => Number(getComputedStyle(element).opacity))).toBeGreaterThan(.5);
  expect(await handle.evaluate((element) => Number.parseFloat(getComputedStyle(element).width))).toBeLessThanOrEqual(6);
  expect(await geometry()).toEqual(before);
  await expect.poll(() => scrollbar.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(0);
  const bounds = await viewport.boundingBox();
  await page.mouse.move(bounds.x + bounds.width - 5, bounds.y + 100);
  await expect.poll(() => scrollbar.evaluate((element) => Number(getComputedStyle(element).opacity))).toBeGreaterThan(.5);
  const thumb = await handle.boundingBox();
  const oldPosition = await viewport.evaluate((element) => element.scrollTop);
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 + 80, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(oldPosition);
  await expect(page.locator("#editor")).toHaveValue(long);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Scrolling.md"), "utf8")).toBe(long);
  await page.screenshot({ path: path.join(buildRoot, "scrollbar-live.png") });
  await chooseView(page, "editor");
  await page.locator("#editor").fill(short);
  await chooseView(page, "rich");
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBeTruthy();
  expect(await geometry()).toEqual(before);
  await expect(page.locator("#rich-editor > .os-scrollbar-vertical")).toHaveCount(1);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Scrolling.md"), "utf8")).toBe(short);
});

test("unchanged and title-only library refreshes retain existing rows", async ({ page }) => {
  const refresh = async () => {
    const response = page.waitForResponse((item) => item.url().includes("/api/tree"));
    await page.locator("#refresh-files").click();
    await (await response).finished();
    await expect(page.locator("#file-nav")).toHaveAttribute("aria-busy", "false");
  };
  const original = await page.locator('[data-path="README.md"]').elementHandle();
  await refresh();
  expect(await page.evaluate(
    (node) => document.querySelector('[data-path="README.md"]') === node,
    original,
  )).toBe(true);
  await fs.writeFile(
    path.join(root, "README.md"),
    `---\ntitle: Zulu refreshed title\n---\n\n${initialText}`,
  );
  await refresh();
  await expect(page.locator('[data-path="README.md"] .file-name')).toHaveText("Zulu refreshed title");
  expect(await page.evaluate(
    (node) => document.querySelector('[data-path="README.md"]') === node,
    original,
  )).toBe(true);
  const paths = await page.locator("#file-list button[data-path]").evaluateAll(
    (buttons) => buttons.map((button) => button.dataset.path),
  );
  expect(paths.indexOf("README.md")).toBeGreaterThan(paths.indexOf("Second.md"));

  await fs.writeFile(path.join(root, "Structural-change.md"), "# Structural change\n");
  await refresh();
  await expect(page.locator('[data-path="Structural-change.md"]')).toBeVisible();
  expect(await page.evaluate(
    (node) => document.querySelector('[data-path="README.md"]') === node,
    original,
  )).toBe(false);
  await fs.rm(path.join(root, "Structural-change.md"));
  await refresh();
});

test("file selection stays singular across navigation and filtering", async ({ page }) => {
  const readme = page.locator('[data-path="README.md"]');
  const second = page.locator('[data-path="Second.md"]');
  await expect(readme).toHaveAttribute("aria-current", "page");
  await second.click();
  await expect(second).toHaveAttribute("aria-current", "page");
  await expect(readme).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator('#file-list [aria-current="page"]')).toHaveCount(1);

  const filter = page.locator("#file-filter");
  await filter.fill("README");
  await expect(page.locator('#file-list [aria-current="page"]')).toHaveCount(0);
  await filter.fill("");
  await expect(page.locator('[data-path="Second.md"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator('#file-list [aria-current="page"]')).toHaveCount(1);
});

test("file and outline scrolling never introduces a sidebar gutter", async ({ page }) => {
  await openFixture(page, "Sidebar-scroll.md", "# Short heading\n");
  const fileViewport = page.locator("#file-nav");
  const dimensions = () => fileViewport.evaluate((element) => ({
    width: element.clientWidth,
    gutter: element.offsetWidth - element.clientWidth,
    rowWidth: element.querySelector('[data-path="README.md"]').getBoundingClientRect().width,
    rightGap: element.getBoundingClientRect().right
      - element.querySelector('[data-path="README.md"]').getBoundingClientRect().right,
  }));
  const before = await dimensions();
  const folder = path.join(root, "Many notes");
  await fs.mkdir(folder, { recursive: true });
  try {
    await Promise.all(Array.from({ length: 80 }, (_, index) =>
      fs.writeFile(path.join(folder, `Note ${String(index).padStart(2, "0")}.md`), "# Note\n"),
    ));
    await page.locator("#refresh-files").click();
    await expect(page.locator("#file-list").getByRole("button", { name: "Many notes/Note 79.md", exact: true })).toBeAttached();
    await expect.poll(() => fileViewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBeTruthy();
    expect(await dimensions()).toEqual(before);
    expect(before.gutter).toBe(0);
    const scrollbarWidth = await page.locator("#files-scroll-frame > .os-scrollbar-vertical")
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(before.rightGap).toBeGreaterThanOrEqual(scrollbarWidth + 6);
    expect(before.rightGap).toBeLessThanOrEqual(scrollbarWidth + 16);
    await fileViewport.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => fileViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await chooseView(page, "editor");
    await page.locator("#editor").fill(Array.from({ length: 75 }, (_, index) => `## Heading ${index}\n\nText.\n`).join("\n"));
    await chooseView(page, "rich");
    await page.locator("#outline-tab").click();
    const outline = page.locator("#outline-scroll");
    await expect.poll(() => outline.evaluate((element) => element.scrollHeight > element.clientHeight)).toBeTruthy();
    expect(await outline.evaluate((element) => element.offsetWidth - element.clientWidth)).toBe(0);
    const width = await outline.evaluate((element) => element.clientWidth);
    await outline.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => outline.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await outline.evaluate((element) => element.clientWidth)).toBe(width);
    await page.locator("#outline-list").getByRole("button", { name: "Heading 74", exact: true }).click();
    await expect(page.locator(".ProseMirror h2").last()).toBeInViewport();
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test("outline labels update in place until the heading count changes", async ({ page }) => {
  await chooseView(page, "editor");
  await page.locator("#outline-tab").click();
  const first = page.locator("#outline-list button").first();
  await expect(first).toHaveText("Welcome");
  const original = await first.elementHandle();

  await page.locator("#editor").fill("# Renamed\n\nA local notebook.\n");
  await expect(first).toHaveText("Renamed");
  expect(await page.evaluate(
    (node) => document.querySelector("#outline-list button") === node,
    original,
  )).toBe(true);

  await page.locator("#editor").fill("# Renamed\n\n## Added\n");
  await expect(page.locator("#outline-list button")).toHaveCount(2);
  expect(await page.evaluate(
    (node) => document.querySelector("#outline-list button") === node,
    original,
  )).toBe(false);
});

test("hidden outline analysis refreshes when the Outline tab opens", async ({ page }) => {
  await chooseView(page, "editor");
  await expect(page.locator("#outline-panel")).toBeHidden();
  await page.locator("#editor").fill("# Deferred outline\n\nBody.\n");
  await page.locator("#outline-tab").click();
  await expect(page.locator("#outline-list button").first()).toHaveText("Deferred outline");
});

test("source and metadata scrollbars do not change textarea width or consume a gutter", async ({ page }) => {
  const raw = "---\ntitle: Notes\n---\n\n# Body\n";
  await openFixture(page, "Textarea-scroll.md", raw, "Notes");
  const metadata = await metadataField(page);
  const metadataWidth = await metadata.evaluate((element) => element.clientWidth);
  await metadata.fill("title: Notes\n" + Array.from({ length: 60 }, (_, index) => `field${index}: value`).join("\n"));
  expect(await metadata.evaluate((element) => element.clientWidth)).toBe(metadataWidth);
  expect(await metadata.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.offsetWidth - element.clientWidth
      - Number.parseFloat(style.borderLeftWidth) - Number.parseFloat(style.borderRightWidth);
  })).toBe(0);
  await chooseView(page, "editor");
  const source = page.locator("#editor");
  const width = await source.evaluate((element) => element.clientWidth);
  await source.fill("# Source\n\n" + "Another line of source.\n".repeat(150));
  expect(await source.evaluate((element) => element.clientWidth)).toBe(width);
  expect(await source.evaluate((element) => element.offsetWidth - element.clientWidth)).toBe(0);
  await source.evaluate((element) => { element.scrollTop = 0; element.setSelectionRange(0, 0); });
  await source.press("Control+End");
  await expect.poll(() => source.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await chooseView(page, "preview");
  const preview = page.locator("#preview");
  await expect(preview).toContainText("Another line of source.");
  expect(await preview.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingLeft))).toBeGreaterThanOrEqual(35);
  await expect.poll(() => preview.evaluate((element) => element.scrollHeight > element.clientHeight)).toBeTruthy();
  expect(await preview.evaluate((element) => element.offsetWidth - element.clientWidth)).toBe(0);
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const bar = page.locator(".preview-pane > .os-scrollbar-vertical");
  await expect.poll(() => bar.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(1);
});

test("horizontal code scrolling overlays rather than increasing the code block height", async ({ page }) => {
  await openFixture(page, "Code-scroll.md", "# Code\n\n```js\nshort\n```\n\nAfter the code.\n");
  const block = page.locator(".notes-code-block");
  const code = block.locator("pre code");
  const viewport = block.locator("pre");
  const before = await block.boundingBox();
  await code.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("x".repeat(240));
  await expect.poll(() => viewport.evaluate((element) => element.scrollWidth > element.clientWidth)).toBeTruthy();
  expect((await block.boundingBox()).height).toBe(before.height);
  expect(await viewport.evaluate((element) => element.offsetHeight - element.clientHeight)).toBe(0);
  await viewport.evaluate((element) => { element.scrollLeft = 0; });
  await viewport.hover();
  await page.mouse.wheel(250, 0);
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(page.locator("#editor")).toHaveValue("# Code\n\n```js\nshort" + "x".repeat(240) + "\n```\n\nAfter the code.\n");
});

test("native appearance updates override the OS theme without replacing unsaved editor state", async ({ page }) => {
  let preferences = { theme: "light", latinFont: "Georgia", cjkFont: "Microsoft YaHei" };
  await page.route("**/api/appearance", (route) => route.fulfill({ json: preferences }));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const brightness = () => page.locator(".document-area").evaluate((element) => {
    const channels = getComputedStyle(element).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number);
    return channels.reduce((sum, value) => sum + value, 0) / 3;
  });
  await expect.poll(brightness).toBeGreaterThan(235);
  await page.locator(".ProseMirror h1").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" unsaved");
  const source = await page.locator("#editor").inputValue();
  await page.evaluate(() => {
    window.notesSelectionAnchor = document.getSelection().anchorNode;
    window.notesSelectionOffset = document.getSelection().anchorOffset;
  });
  let documentReloads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/document" && request.method() === "GET") documentReloads += 1;
  });
  preferences = { theme: "dark", latinFont: "Arial", cjkFont: "SimSun" };
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(brightness).toBeLessThan(80);
  await expect(page.locator("#editor")).toHaveValue(source);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  expect(await page.evaluate(() =>
    document.getSelection().anchorNode === window.notesSelectionAnchor
      && document.getSelection().anchorOffset === window.notesSelectionOffset,
  )).toBeTruthy();
  expect(documentReloads).toBe(0);
  preferences = { ...preferences, theme: "system" };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(brightness).toBeGreaterThan(235);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(brightness).toBeLessThan(80);
  await expect(page.locator("#editor")).toHaveValue(source);
});

test("appearance retrieval errors retain the last theme and the current draft", async ({ page }) => {
  await page.route("**/api/appearance", (route) => route.fulfill({
    status: 503, json: { error: "Appearance is temporarily unavailable." },
  }));
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# Keep my draft\n");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText(/appearance.*unavailable/i).first()).toBeVisible();
  await expect(page.locator("#editor")).toHaveValue("# Keep my draft\n");
  await expect(page.locator("#connection-label")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
});

test("file search uses a rounded focus surface without bars and filenames have no square icons", async ({ page }) => {
  const input = page.locator("#file-filter");
  const box = await input.boundingBox();
  await input.click();
  expect(await input.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
  expect(await input.evaluate((element) => getComputedStyle(element).borderStyle)).toBe("none");
  expect(await page.locator(".search-field").evaluate(element => ({
    before: getComputedStyle(element, "::before").content,
    radius: getComputedStyle(element).borderRadius,
    background: getComputedStyle(element).backgroundColor,
  }))).toMatchObject({ before: "none", radius: "6px" });
  expect(await input.boundingBox()).toEqual(box);
  const file = page.locator("#file-list").getByRole("button", { name: "README.md", exact: true });
  expect(await file.evaluate((element) => getComputedStyle(element, "::before").content)).toBe("none");
  expect(await file.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderRadius))).toBeGreaterThanOrEqual(5);
  const resting = await file.evaluate((element) => getComputedStyle(element).backgroundColor);
  await file.hover();
  expect(await file.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(resting);
  await input.evaluate((element) => {
    for (const value of ["R", "RE", "REA", "READ", "README"]) {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await expect(file).toBeVisible();
  await expect(page.locator("#file-list .file-button")).toHaveCount(1);
  await page.screenshot({ path: path.join(buildRoot, "sidebar-search-focus.png") });
});
