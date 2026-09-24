import { test, expect, fs, path, root, buildRoot, initialText, chooseView, reloadDocument, openFixture, metadataField } from "./fixture.mjs";

test("opens a rendered editable page without changing the Markdown", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const editor = page.locator(".ProseMirror[contenteditable=true]");
  await expect(editor).toBeVisible();
  const heading = editor.getByRole("heading", { name: "Welcome", exact: true });
  await expect(heading).toBeVisible();
  await expect(editor.locator("table")).toBeVisible();
  await expect(editor.locator("pre")).toContainText("fn main()");
  const task = editor.locator("li").filter({ hasText: /A task/ });
  const checkbox = task.locator('input[type="checkbox"]');
  await expect(task).toContainText("A task");
  const boxBounds = await checkbox.boundingBox();
  const textBounds = await task.boundingBox();
  expect(boxBounds.y).toBeGreaterThanOrEqual(textBounds.y);
  expect(boxBounds.y - textBounds.y).toBeLessThan(20);
  expect(textBounds.height).toBeLessThan(55);
  const proseStyle = await editor.locator("p").filter({ hasText: /A local notebook/ }).evaluate((element) => ({
    size: Number.parseFloat(getComputedStyle(element).fontSize),
    family: getComputedStyle(element).fontFamily,
  }));
  expect(proseStyle.size).toBeGreaterThanOrEqual(16);
  expect(proseStyle.family).not.toMatch(/monospace/i);
  const image = editor.getByRole("img", { name: "Pixel" });
  await expect(image).toHaveAttribute("src", /\/assets\?id=[a-f0-9-]+&document=[a-f0-9-]+/i);
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0)).toBeTruthy();
  await expect(page.locator("#save-document")).toHaveCount(0);
  await expect(page.locator("#command-palette-open")).toBeHidden();
  await expect(page.locator("#connection-label")).toBeHidden();
  await expect(page.locator("#view-label")).toHaveText("Live");
  await expect(page.locator("#git-tab")).toBeVisible();
  await expect(page.getByText(/Change the folder in the desktop app/)).toHaveCount(0);
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(initialText);
  expect(page.url()).not.toContain("token=");
  expect(errors).toEqual([]);
  await page.screenshot({ path: path.join(buildRoot, "notes-editor.png"), fullPage: true });
});

test("inline edits save to disk and survive reopening in source mode", async ({ page }) => {
  const editor = page.locator(".ProseMirror[contenteditable=true]");
  await editor.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    element.focus();
  });
  await editor.press("Enter");
  await editor.pressSequentially("Written inline 中文");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#document-message")).toBeHidden();
  const saved = await fs.readFile(path.join(root, "README.md"), "utf8");
  expect(saved).toContain("Written inline 中文");
  expect(saved).toContain("images/pixel.png");
  expect(saved).not.toContain("/assets?path");
  await page.reload();
  await editor.focus();
  await page.keyboard.press("Control+End");
  await expect(page.locator(".ProseMirror")).toContainText("Written inline 中文");
  await chooseView(page, "editor");
  await expect(page.locator("#editor")).toHaveValue(saved.replace(/\r\n/g, "\n"));
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
});

test("source changes switch to inline editing and auto-save after one second idle", async ({ page }) => {
  await chooseView(page, "editor");
  const content = "# Changed in source\n\nA **bold** paragraph.\n";
  await page.locator("#editor").fill(content);
  await chooseView(page, "rich");
  await page.locator("#document-title").click();
  await expect(page.getByRole("heading", { name: "Changed in source", exact: true })).toBeVisible();
  await expect(page.locator(".ProseMirror")).toContainText("A bold paragraph.");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(initialText);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(content);
  await expect(page.locator("#document-message")).toBeHidden();
});

test("large Source documents use the virtual editor and save exact Unicode text", async ({ page }) => {
  const content = "# Virtual source\n\n"
    + Array.from({ length: 2_000 }, (_, index) =>
      `Line ${index} ${"with enough Markdown text for virtualization. ".repeat(10)}\n`).join("");
  await fs.writeFile(path.join(root, "Virtual-source.md"), content);
  await chooseView(page, "editor");
  await page.locator("#refresh-files").click();
  await page.locator('[data-path="Virtual-source.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Virtual-source.md");
  await expect(page.locator("#editor")).toBeHidden();
  const editor = page.locator(".virtual-source-editor .cm-content");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("aria-label", "Markdown source");
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("Written virtually 中文");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Virtual-source.md"), "utf8"))
    .toBe(`${content}Written virtually 中文`);
  await expect.poll(() =>
    page.locator(".virtual-source-editor .cm-scroller")
      .evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await chooseView(page, "split");
  await expect(editor).toBeVisible();
  await expect(page.locator("#preview h1")).toHaveText("Virtual source");
  await page.keyboard.press("Control+/");
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  await page.keyboard.press("Control+/");
  await expect(editor).toBeVisible();
});

test("cached editor analysis refreshes after edits and saved baselines", async ({ page }) => {
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# Analysis\n\nThird line");
  await expect(page.locator("#editor-stats")).toHaveText("3 words");
  await expect(page.locator("#editor-stats")).toHaveAttribute("title", /^3 lines ·/);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await page.locator("#refresh-files").click();
  await expect(page.locator("#file-nav")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#editor-stats")).toHaveText("3 words");
  await expect(page.locator("#editor-stats")).toHaveAttribute("title", /^3 lines ·/);
});

test("Read reuses a current preview and refreshes it after source edits", async ({ page }) => {
  await chooseView(page, "editor");
  let previewRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/preview")) previewRequests += 1;
  });
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Welcome");
  const originalHeading = await page.locator("#preview h1").elementHandle();
  expect(previewRequests).toBe(0);

  await chooseView(page, "editor");
  await expect(page.locator(".preview-pane")).toBeHidden();
  await chooseView(page, "preview");
  expect(await page.evaluate(
    (node) => document.querySelector("#preview h1") === node,
    originalHeading,
  )).toBe(true);
  expect(previewRequests).toBe(0);

  await chooseView(page, "editor");
  await page.locator("#editor").fill("# Updated preview\n\nChanged body.\n");
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Updated preview");
  expect(previewRequests).toBe(1);

  await chooseView(page, "editor");
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Updated preview");
  expect(previewRequests).toBe(1);
});

test("Read outline jumps target scoped and escaped heading IDs", async ({ page }) => {
  const source = `${"Paragraph before the headings.\n\n".repeat(120)}# editor\n\n## 123 start\n`;
  await openFixture(page, "Preview-headings.md", source);
  await chooseView(page, "preview");
  const preview = page.locator("#preview");
  await page.locator("#outline-tab").click();
  await preview.evaluate((element) => { element.scrollTop = 0; });
  await page.locator("#outline-list").getByRole("button", { name: "editor", exact: true }).click();
  await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await preview.evaluate((element) => { element.scrollTop = 0; });
  await page.locator("#outline-list").getByRole("button", { name: "123 start", exact: true }).click();
  await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("Read links retain internal and external navigation behavior", async ({ page }) => {
  const origin = new URL(page.url()).origin;
  const source = "# Links\n\n"
    + "[Internal](Second.md)\n"
    + "[Anchor](#links)\n"
    + "[External](https://example.com/path)\n"
    + "[Email](mailto:user@example.com)\n"
    + `[Same origin](${origin}/plain)\n`;
  await openFixture(page, "Preview-links.md", source);
  await chooseView(page, "preview");
  const link = (name) => page.locator("#preview").getByRole("link", { name, exact: true });
  await expect(link("Internal")).not.toHaveAttribute("target");
  await expect(link("Anchor")).not.toHaveAttribute("target");
  await expect(link("Same origin")).not.toHaveAttribute("target");
  for (const name of ["External", "Email"]) {
    await expect(link(name)).toHaveAttribute("target", "_blank");
    await expect(link(name)).toHaveAttribute("rel", "noopener noreferrer");
  }
});

test("external changes cause a conflict without losing editor text", async ({ page }) => {
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# My unsaved work\n");
  await fs.writeFile(path.join(root, "README.md"), "# Changed elsewhere\n");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#conflict-message")).toBeVisible();
  await expect(page.locator("#dirty-indicator")).toBeVisible();
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "conflict");
  await expect(page.locator("#document-title")).toHaveText("README.md *");
  await expect(page.locator("#editor")).toHaveValue("# My unsaved work\n");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("# Changed elsewhere\n");
  page.once("dialog", (dialog) => dialog.dismiss());
  await reloadDocument(page);
  await expect(page.locator("#editor")).toHaveValue("# My unsaved work\n");
});

test("cancelled navigation retains unsaved text", async ({ page }) => {
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# Keep me\n");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#file-list").getByRole("button", { name: "Second.md", exact: true }).click();
  await expect(page.locator("#document-title")).toHaveText("README.md *");
  await expect(page.locator("#editor")).toHaveValue("# Keep me\n");
});

test("a completed save does not erase typing that happened during the request", async ({ page }) => {
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# First snapshot\n");
  let releaseResponse;
  const heldResponse = new Promise((resolve) => { releaseResponse = resolve; });
  let receivedRequest;
  const requestArrived = new Promise((resolve) => { receivedRequest = resolve; });
  await page.route("**/api/document", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    receivedRequest();
    await heldResponse;
    await route.fulfill({ response });
  });
  try {
    await page.keyboard.press("Control+s");
    await requestArrived;
    await page.locator("#editor").fill("# Newer unsaved work\n");
  } finally {
    releaseResponse();
  }
  await expect(page.locator("#editor")).toHaveValue("# Newer unsaved work\n");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("# First snapshot\n");
});

test("raw HTML remains inert and editable without executing", async ({ page }) => {
  await page.locator("#file-list").getByRole("button", { name: "Unsupported.md", exact: true }).click();
  await expect(page.locator("#document-title")).toHaveText("Unsupported.md");
  await expect(page.locator("#rich-warning")).toBeHidden();
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
  await expect(page.locator('.ProseMirror [data-type="html"]')).toContainText("<div>");
  await expect(page.locator(".ProseMirror div:not(.ProseMirror)")).toHaveCount(0);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Unsupported.md"), "utf8")).toBe("# Source\n\n<div>Keep this HTML</div>\n");
});

test("creating a note never overwrites an existing file", async ({ page }) => {
  await page.locator("#new-note").click();
  await page.locator("#new-note-title").fill("Second");
  await page.locator("#create-note").click();
  await expect(page.locator("#new-note-error")).toBeVisible();
  expect(await fs.readFile(path.join(root, "Second.md"), "utf8")).toBe("# Second\n\nAnother note.\n");
  await page.locator("#new-note-title").fill("New note");
  await page.locator("#create-note").click();
  await expect(page.locator("#document-title")).toHaveText("New note");
  await expect(page).toHaveTitle("New note — Notes");
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  expect(await fs.readFile(path.join(root, "New note.md"), "utf8")).toMatch(
    /^---\ntitle: "New note"\ncreated: "\d{4}-\d{2}-\d{2}T[\d:.]+Z"\n---\n\n$/,
  );
});

test("metadata titles and folder actions support rename and drag moves", async ({ page }) => {
  await fs.mkdir(path.join(root, "Guides"));
  await fs.mkdir(path.join(root, "Empty"));
  await fs.writeFile(path.join(root, "Guides", "index.md"), "---\ntitle: Handbook\n---\n# Index\n");
  await fs.writeFile(path.join(root, "Guides", "intro.md"), "---\ntitle: Getting started\n---\n# Intro\n");
  await page.reload();

  const guides = page.locator('details.directory[data-path="Guides"] > summary');
  await expect(guides).toContainText("Handbook");
  await expect(page.locator('details.directory[data-path="Empty"] > summary')).toBeVisible();
  await expect(page.locator('button[data-path="Guides/intro.md"]')).toHaveText("Getting started");

  await guides.hover();
  await guides.getByRole("button", { name: "New folder in Handbook" }).click();
  await page.locator("#new-folder-path").fill("Guides/Child");
  await page.locator("#create-folder").click();
  await expect(page.locator('details.directory[data-path="Guides/Child"] > summary')).toBeVisible();

  await guides.hover();
  await guides.getByRole("button", { name: "New note in Handbook" }).click();
  await page.locator("#new-note-title").fill("Draft");
  await expect(page.locator("#new-note-hint")).toHaveText("File: Guides/Draft.md");
  await page.locator("#create-note").click();
  await expect(page.locator("#document-title")).toHaveText("Draft");
  await expect(page).toHaveTitle("Draft — Notes");

  const draft = page.locator('button[data-path="Guides/Draft.md"]');
  await draft.click({ button: "right" });
  await page.locator("#file-details").click();
  await expect(page.locator("#details-path")).toHaveText("Guides/Draft.md");
  await page.locator("#close-details").click();

  await draft.click({ button: "right" });
  await page.locator("#file-rename").click();
  await page.locator("#rename-path").fill("Renamed.md");
  await page.locator("#confirm-rename").click();
  await expect(page.locator("#document-title")).toHaveText("Draft");
  expect(await fs.stat(path.join(root, "Guides", "Renamed.md"))).toBeTruthy();

  const renamed = page.locator('button[data-path="Guides/Renamed.md"]');
  const child = page.locator('details.directory[data-path="Guides/Child"] > summary');
  await renamed.dragTo(child);
  await expect(page.locator("#document-title")).toHaveText("Draft");
  expect(await fs.stat(path.join(root, "Guides", "Child", "Renamed.md"))).toBeTruthy();

  await page.locator('button[data-path="Guides/intro.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Getting started");
  await expect(page).toHaveTitle("Getting started — Notes");
});

test("live typing retains heading and emphasis formatting instead of expanding Markdown", async ({ page }) => {
  const editor = page.locator(".ProseMirror");
  const heading = editor.getByRole("heading", { name: "Welcome", exact: true });
  const appearance = await heading.evaluate((element) => ({
    size: getComputedStyle(element).fontSize,
    weight: getComputedStyle(element).fontWeight,
  }));
  await heading.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" edited");
  await expect(editor.locator("h1")).toHaveText("Welcome edited");
  expect(await editor.locator("h1").evaluate((element) => ({
    size: getComputedStyle(element).fontSize,
    weight: getComputedStyle(element).fontWeight,
  }))).toEqual(appearance);
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
  await expect(page.locator("#editor")).toBeHidden();
  await expect(editor).not.toContainText("# Welcome");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#editor")).toHaveValue(initialText);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await editor.locator("strong").click();
  await page.keyboard.insertText("new");
  await expect(editor.locator("strong")).toContainText("new");
  await expect(editor).not.toContainText("**");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(initialText);
});

test("the sidebar can hide and outline navigation does not change the note", async ({ page }) => {
  await page.locator("#outline-tab").click();
  await page.locator("#outline-list").getByRole("button", { name: "Welcome", exact: true }).click();
  await expect(page.locator(".ProseMirror h1")).toHaveText("Welcome");
  await expect(page.locator(".ProseMirror")).not.toContainText("# Welcome");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await page.locator("#sidebar-toggle").click();
  await expect(page.locator("#sidebar")).toBeHidden();
  await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Control+Shift+l");
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Control+/");
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#outline-list")).toContainText("Welcome");
  await page.locator("#editor").fill("# Updated outline\n\nA paragraph.\n");
  await expect(page.locator("#outline-list")).toContainText("Updated outline");
  await page.locator("#editor").fill(initialText);
  await page.keyboard.press("Control+/");
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
});

test("MkDocs metadata is separate from the formatted body and remains exact after a body edit", async ({ page }) => {
  const header = "\uFEFF---\r\n# Keep this comment\n"
    + "title: 'Metadata title'\r\ndescription: >-\n  A folded description.\r\n"
    + "tags: [one, two]\ncustom:\r\n  keep: true\r\n...\n\r\n";
  const source = `${header}# Real heading\n\nA **bold** paragraph.\r\n`;
  await openFixture(page, "Metadata.md", source, "Metadata title");
  const live = page.locator(".ProseMirror");
  await expect(live.locator("h1")).toHaveText("Real heading");
  await expect(live).not.toContainText("Metadata title");
  await expect(live.locator("hr")).toHaveCount(0);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator(".notes-metadata summary")).toHaveText("Metadata");
  await expect(page.locator(".notes-metadata-summary,.notes-metadata-description,.notes-metadata-hint,.notes-metadata-editor-heading")).toHaveCount(0);
  await page.locator("#outline-tab").click();
  await expect(page.locator("#outline-list")).toHaveText("Real heading");
  await page.screenshot({ path: path.join(buildRoot, "metadata-frontmatter.png") });
  await live.locator("h1").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" updated");
  await expect(live.locator("h1")).toHaveText("Real heading updated");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect((await fs.readFile(path.join(root, "Metadata.md"), "utf8")).startsWith(header)).toBeTruthy();
  const field = await metadataField(page);
  await expect(field).toHaveValue(/# Keep this comment[\s\S]*custom:\n {2}keep: true/);
  await page.screenshot({ path: path.join(buildRoot, "metadata-frontmatter-expanded.png") });
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Real heading updated");
  await expect(page.locator("#preview")).not.toContainText("Metadata title");
});

test("editing YAML alone preserves the complete body's original spelling and newlines", async ({ page }) => {
  const source = "---\r\ntitle: 'Metadata title'\n# Preserved\n"
    + "tags:\r\n  - one\r\n  - two\n---\r\n\r\n"
    + "# Real heading\n\nKeep _this spelling_.\r\n\r\nAnother paragraph.\n";
  await openFixture(page, "Header-only.md", source, "Metadata title");
  const field = await metadataField(page);
  await field.fill((await field.inputValue()).replace("Metadata title", "Renamed title"));
  await expect(page.locator("#document-title")).toHaveText("Renamed title *");
  await expect(page).toHaveTitle("Renamed title * — Notes");
  await expect(page.locator(".ProseMirror h1")).toHaveText("Real heading");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator('button[data-path="Header-only.md"]')).toHaveText("Renamed title");
  expect(await fs.readFile(path.join(root, "Header-only.md"), "utf8"))
    .toBe(source.replace("Metadata title", "Renamed title"));
});

test("body undo does not discard a metadata edit", async ({ page }) => {
  const source = "---\ntitle: 'Original title'\n---\n\n# Body\n\nText.\n";
  await openFixture(page, "Metadata-undo.md", source, "Original title");
  const field = await metadataField(page);
  await field.fill((await field.inputValue()).replace("Original title", "Changed title"));
  await page.locator(".ProseMirror h1").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" addition");
  await expect(page.locator(".ProseMirror h1")).toHaveText("Body addition");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".ProseMirror h1")).toHaveText("Body");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Metadata-undo.md"), "utf8"))
    .toBe(source.replace("Original title", "Changed title"));
});

test("invalid YAML is reported without hiding the body or discarding source", async ({ page }) => {
  const header = "---\ntitle: [unfinished\n---\n\n";
  await openFixture(page, "Invalid-metadata.md", `${header}# Body\n\nText.\n`);
  const field = await metadataField(page);
  await expect(field).toHaveValue(/title: \[unfinished/);
  await expect(page.locator(".status-bar #metadata-message")).toBeVisible();
  await expect(page.locator("#metadata-message")).toContainText("Invalid YAML");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".ProseMirror h1")).toHaveText("Body");
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
  expect((await fs.readFile(path.join(root, "Invalid-metadata.md"), "utf8")).startsWith(header)).toBeTruthy();
  await page.screenshot({ path: path.join(buildRoot, "metadata-validation.png") });
});

test("math, empty table cells and list headings open safely in Live mode", async ({ page }) => {
  const source = "---\ntitle: 技术笔记\n---\n\n"
    + "# Techniques\n\n$$L(x)=x^2$$\n\n$$L(x)=x^2$$\n\n## 实验观察\n"
    + "- First item with $\\Vert f(o_g)-o_s\\Vert$\n"
    + "- Second item with $\\Vert f(o_g)-o_s\\Vert$\n"
    + "Evaluation\n- Down stream tasks\n\t- \n"
    + "Train Metrics\n- Reconstruction\n\n"
    + "| Model | L1 | L2 |\n| --- | --- | --- |\n| Test |  |  |\n";
  await openFixture(page, "Technical.md", source, "技术笔记");
  await expect(page.locator("#rich-warning")).toBeHidden();
  const editor = page.locator(".ProseMirror[contenteditable=true]");
  await expect(editor).toBeVisible();
  await expect(editor.locator('[data-type="math_block"]')).toHaveCount(2);
  await expect(editor.locator('[data-type="math_block"] .katex')).toHaveCount(2);
  await expect(editor.locator('[data-type="math_inline"]')).toHaveCount(2);
  await expect(editor.locator('[data-type="math_inline"] .katex')).toHaveCount(2);
  const inlineMath = editor.locator('[data-type="math_inline"]').first();
  await inlineMath.locator(".notes-math-output").click();
  const inlineSource = inlineMath.getByLabel("Inline TeX source");
  await expect(inlineSource).toBeVisible();
  await inlineSource.fill("x^3 + y");
  await expect(inlineMath.locator("annotation")).toHaveText("x^3 + y");
  await expect(inlineMath).toHaveAttribute("data-value", "x^3 + y");
  await page.keyboard.press("Control+z");
  await expect(inlineMath).toHaveAttribute("data-value", "\\Vert f(o_g)-o_s\\Vert");
  await expect(inlineMath.locator("annotation")).toHaveText("\\Vert f(o_g)-o_s\\Vert");
  await page.keyboard.press("Control+Shift+z");
  await expect(inlineMath).toHaveAttribute("data-value", "x^3 + y");
  await expect(inlineMath.locator("annotation")).toHaveText("x^3 + y");
  const blockMath = editor.locator('[data-type="math_block"]').first();
  await blockMath.locator(".notes-math-output").click();
  const blockSource = blockMath.getByLabel("Display TeX source");
  await expect(blockSource).toBeVisible();
  await blockSource.fill("L(x)=x^3");
  await expect(blockMath.locator("annotation")).toHaveText("L(x)=x^3");
  await expect(blockMath).toHaveAttribute("data-value", "L(x)=x^3");
  await editor.locator("h1").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" updated");
  await chooseView(page, "editor");
  await expect(page.locator("#editor")).not.toHaveValue(/<br \/>/);
  await expect(page.locator("#editor")).toHaveValue(/\$x\^3 \+ y\$/);
  await expect(page.locator("#editor")).toHaveValue(/\$\$\s*L\(x\)=x\^3\s*\$\$/);
});

test("empty and marked formulas support direct editing and composition", async ({ page }) => {
  const source = "# Formula edges\n\n**Before $x$ after**\n\nEmpty inline: $ $\n\n$$$$\n\nEnd.\n";
  await openFixture(page, "Formula-edges.md", source);
  const editor = page.locator(".ProseMirror[contenteditable=true]");
  await expect(editor.locator("strong [data-type=math_inline]")).toHaveCount(1);
  const inlineMath = editor.locator('[data-type="math_inline"]').nth(1);
  await inlineMath.locator(".notes-math-output").click();
  await inlineMath.getByLabel("Inline TeX source").fill("y");
  await expect(inlineMath.locator("annotation")).toHaveText("y");
  await editor.locator("h1").click();
  await expect(inlineMath).not.toHaveClass(/is-editing/);
  await expect(inlineMath.getByLabel("Inline TeX source")).toBeHidden();

  const blockMath = editor.locator('[data-type="math_block"]');
  await blockMath.locator(".notes-math-output").click();
  const blockSource = blockMath.getByLabel("Display TeX source");
  await blockSource.fill("变量");
  const cdp = await page.context().newCDPSession(page);
  await blockSource.press("End");
  await cdp.send("Input.imeSetComposition", {
    text: "测试", selectionStart: 2, selectionEnd: 2,
  });
  await cdp.send("Input.insertText", { text: "测试" });
  await expect(blockMath.locator("annotation")).toHaveText("变量测试");
  await chooseView(page, "editor");
  await expect(page.locator("#editor")).toHaveValue(/\*\*Before \$x\$ after\*\*/);
  await expect(page.locator("#editor")).toHaveValue(/Empty inline: \$y\$/);
  await expect(page.locator("#editor")).toHaveValue(/\$\$\s*变量测试\s*\$\$/);
});

test("list and table edits retain their rendered structures", async ({ page }) => {
  const live = page.locator(".ProseMirror");
  await live.locator("li p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" updated");
  await expect(live.locator("li")).toContainText("A task updated");
  await live.locator("td").first().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" edited");
  await expect(live.locator("td").first()).toHaveText("Notes edited");
  await expect(live.locator("table")).toBeVisible();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
});
