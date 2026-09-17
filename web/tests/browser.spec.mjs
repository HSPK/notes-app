import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.resolve(webRoot, "..", "build");
const executable = process.env.NOTES_TEST_EXE
  ?? path.join(buildRoot, "rust", "debug", process.platform === "win32" ? "notes-core.exe" : "notes-core");
const initialText = "# Welcome\n\nA **local** notebook.\n\n"
  + "- [ ] A task\n\n| Name | Value |\n| --- | --- |\n| Notes | Local |\n\n"
  + "```rust\nfn main() {}\n```\n\n![Pixel](images/pixel.png)\n\n[Second](Second.md)\n";
let directory;
let root;
let ready;
let stop;
let child;
let launchUrl;
let diagnostics = "";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function chooseView(page, id) {
  await page.locator("#view-menu > summary").click();
  await page.locator(`#view-${id}`).click();
}

async function reloadDocument(page) {
  await page.locator("#more-menu > summary").click();
  await page.locator("#reload-document").click();
}

async function openFixture(page, name, content) {
  await fs.writeFile(path.join(root, name), content);
  const url = new URL(launchUrl);
  url.searchParams.set("file", name);
  await page.goto(url.href);
  await expect(page.locator("#document-title")).toHaveText(name);
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
}

async function metadataField(page) {
  const panel = page.locator("#rich-editor details");
  await expect(panel).toBeVisible();
  if (await panel.getAttribute("open") === null) await panel.locator("summary").click();
  return panel.locator("textarea");
}

test.beforeAll(async () => {
  await fs.mkdir(buildRoot, { recursive: true });
  directory = await fs.mkdtemp(path.join(buildRoot, "browser-fixture-"));
  root = path.join(directory, "notes");
  ready = path.join(directory, "ready.json");
  stop = path.join(directory, "stop");
  await fs.mkdir(path.join(root, "images"), { recursive: true });
  await fs.writeFile(path.join(root, "images", "pixel.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ));
  child = spawn(executable, [
    "--serve", root, "--port", "0", "--ready-file", ready, "--stop-file", stop,
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let launchError;
  child.on("error", (error) => { launchError = error; });
  child.stdout.on("data", (data) => { diagnostics += data; });
  child.stderr.on("data", (data) => { diagnostics += data; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Notes exited: ${diagnostics}`);
    try {
      launchUrl = JSON.parse(await fs.readFile(ready, "utf8")).url;
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  expect(launchUrl, `The native service did not initialize: ${diagnostics}`).toBeTruthy();
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    await fs.writeFile(stop, "");
    for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1) await delay(100);
    if (child.exitCode === null) {
      child.kill();
      throw new Error("The native service failed to stop gracefully.");
    }
  }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.notesDiagnostics = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      window.notesDiagnostics.push(`CSP: ${event.violatedDirective}`);
    });
    window.addEventListener("error", (event) => {
      window.notesDiagnostics.push(event.message);
    });
    window.addEventListener("unhandledrejection", (event) => {
      window.notesDiagnostics.push(String(event.reason));
    });
  });
  await fs.writeFile(path.join(root, "README.md"), initialText);
  await fs.writeFile(path.join(root, "Second.md"), "# Second\n\nAnother note.\n");
  await fs.writeFile(path.join(root, "Unsupported.md"), "# Source\n\n<div>Keep this HTML</div>\n");
  const url = new URL(launchUrl);
  url.searchParams.set("file", "README.md");
  await page.goto(url.href);
  await expect(page.locator("#document-title")).toHaveText("README.md");
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
});

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) {
    expect(await page.evaluate(() => window.notesDiagnostics)).toEqual([]);
  }
});

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
  await expect(image).toHaveAttribute("src", /\/assets\?path=images%2Fpixel\.png/i);
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0)).toBeTruthy();
  await expect(page.locator("#save-document")).toBeDisabled();
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(initialText);
  expect(page.url()).not.toContain("token=");
  expect(errors).toEqual([]);
  await page.screenshot({ path: path.join(buildRoot, "notes-editor.png"), fullPage: true });
});

test("inline edits save to disk and survive reopening in source mode", async ({ page }) => {
  const editor = page.locator(".ProseMirror[contenteditable=true]");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Written inline 中文");
  await expect(page.locator("#dirty-indicator")).toHaveText("Unsaved changes");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
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
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
});

test("source changes switch to inline editing without an automatic save", async ({ page }) => {
  await chooseView(page, "editor");
  const content = "# Changed in source\n\nA **bold** paragraph.\n";
  await page.locator("#editor").fill(content);
  await chooseView(page, "rich");
  await page.locator("#document-title").click();
  await expect(page.getByRole("heading", { name: "Changed in source", exact: true })).toBeVisible();
  await expect(page.locator(".ProseMirror")).toContainText("A bold paragraph.");
  await expect(page.locator("#dirty-indicator")).toHaveText("Unsaved changes");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(initialText);
  await page.locator("#save-document").click();
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(content);
});

test("external changes cause a conflict without losing editor text", async ({ page }) => {
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# My unsaved work\n");
  await fs.writeFile(path.join(root, "README.md"), "# Changed elsewhere\n");
  await page.locator("#save-document").click();
  await expect(page.locator("#conflict-message")).toBeVisible();
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
  await expect(page.locator("#document-title")).toHaveText("README.md");
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
    await page.locator("#save-document").click();
    await requestArrived;
    await page.locator("#editor").fill("# Newer unsaved work\n");
  } finally {
    releaseResponse();
  }
  await expect(page.locator("#save-label")).toHaveText("Save");
  await expect(page.locator("#editor")).toHaveValue("# Newer unsaved work\n");
  await expect(page.locator("#dirty-indicator")).toHaveText("Unsaved changes");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("# First snapshot\n");
});

test("unsupported raw HTML has an explicit safe Source fallback without changing the file", async ({ page }) => {
  await page.locator("#file-list").getByRole("button", { name: "Unsupported.md", exact: true }).click();
  await expect(page.locator("#document-title")).toHaveText("Unsupported.md");
  await expect(page.locator("#rich-warning")).toBeVisible();
  await expect(page.locator("#rich-warning")).toContainText("original text is kept");
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "editor");
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#editor")).toHaveValue("# Source\n\n<div>Keep this HTML</div>\n");
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
  expect(await fs.readFile(path.join(root, "Unsupported.md"), "utf8")).toBe("# Source\n\n<div>Keep this HTML</div>\n");
});

test("creating a note never overwrites an existing file", async ({ page }) => {
  await page.locator("#new-note").click();
  await page.locator("#new-note-path").fill("Second.md");
  await page.locator("#create-note").click();
  await expect(page.locator("#new-note-error")).toBeVisible();
  expect(await fs.readFile(path.join(root, "Second.md"), "utf8")).toBe("# Second\n\nAnother note.\n");
  await page.locator("#new-note-path").fill("New note.md");
  await page.locator("#create-note").click();
  await expect(page.locator("#document-title")).toHaveText("New note.md");
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  expect(await fs.readFile(path.join(root, "New note.md"), "utf8")).toBe("");
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
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
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
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
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
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
});

test("MkDocs metadata is separate from the formatted body and remains exact after a body edit", async ({ page }) => {
  const header = "\uFEFF---\r\n# Keep this comment\n"
    + "title: 'Metadata title'\r\ndescription: >-\n  A folded description.\r\n"
    + "tags: [one, two]\ncustom:\r\n  keep: true\r\n...\n\r\n";
  const source = `${header}# Real heading\n\nA **bold** paragraph.\r\n`;
  await openFixture(page, "Metadata.md", source);
  const live = page.locator(".ProseMirror");
  await expect(live.locator("h1")).toHaveText("Real heading");
  await expect(live).not.toContainText("Metadata title");
  await expect(live.locator("hr")).toHaveCount(0);
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
  await page.locator("#outline-tab").click();
  await expect(page.locator("#outline-list")).toHaveText("Real heading");
  await page.screenshot({ path: path.join(buildRoot, "metadata-frontmatter.png") });
  await live.locator("h1").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" updated");
  await expect(live.locator("h1")).toHaveText("Real heading updated");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
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
  await openFixture(page, "Header-only.md", source);
  const field = await metadataField(page);
  await field.fill((await field.inputValue()).replace("Metadata title", "Renamed title"));
  await expect(page.locator(".ProseMirror h1")).toHaveText("Real heading");
  await page.locator("#save-document").click();
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
  expect(await fs.readFile(path.join(root, "Header-only.md"), "utf8"))
    .toBe(source.replace("Metadata title", "Renamed title"));
});

test("body undo does not discard a metadata edit", async ({ page }) => {
  const source = "---\ntitle: 'Original title'\n---\n\n# Body\n\nText.\n";
  await openFixture(page, "Metadata-undo.md", source);
  const field = await metadataField(page);
  await field.fill((await field.inputValue()).replace("Original title", "Changed title"));
  await page.locator(".ProseMirror h1").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" addition");
  await expect(page.locator(".ProseMirror h1")).toHaveText("Body addition");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".ProseMirror h1")).toHaveText("Body");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
  expect(await fs.readFile(path.join(root, "Metadata-undo.md"), "utf8"))
    .toBe(source.replace("Original title", "Changed title"));
});

test("invalid YAML is reported without hiding the body or discarding source", async ({ page }) => {
  const header = "---\ntitle: [unfinished\n---\n\n";
  await openFixture(page, "Invalid-metadata.md", `${header}# Body\n\nText.\n`);
  const field = await metadataField(page);
  await expect(field).toHaveValue(/title: \[unfinished/);
  await expect(page.locator("#rich-editor [role=alert]")).toBeVisible();
  await expect(page.locator(".ProseMirror h1")).toHaveText("Body");
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
  expect((await fs.readFile(path.join(root, "Invalid-metadata.md"), "utf8")).startsWith(header)).toBeTruthy();
  await page.screenshot({ path: path.join(buildRoot, "metadata-validation.png") });
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
  await expect(page.locator("#format-panel")).toBeHidden();
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
  expect(await fs.readFile(path.join(root, "Scrolling.md"), "utf8")).toBe(short);
  await page.screenshot({ path: path.join(buildRoot, "scrollbar-live.png") });
  await chooseView(page, "editor");
  await page.locator("#editor").fill(short);
  await chooseView(page, "rich");
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBeTruthy();
  expect(await geometry()).toEqual(before);
  await expect(page.locator("#rich-editor > .os-scrollbar-vertical")).toHaveCount(1);
  await expect(page.locator("#dirty-indicator")).toHaveText("Saved");
});

test("file and outline scrolling never introduces a sidebar gutter", async ({ page }) => {
  await openFixture(page, "Sidebar-scroll.md", "# Short heading\n");
  const fileViewport = page.locator("#file-nav");
  const dimensions = () => fileViewport.evaluate((element) => ({
    width: element.clientWidth,
    gutter: element.offsetWidth - element.clientWidth,
    rowWidth: element.querySelector('[data-path="README.md"]').getBoundingClientRect().width,
  }));
  const before = await dimensions();
  const folder = path.join(root, "Many notes");
  await fs.mkdir(folder, { recursive: true });
  try {
    await Promise.all(Array.from({ length: 80 }, (_, index) =>
      fs.writeFile(path.join(folder, `Note ${String(index).padStart(2, "0")}.md`), "# Note\n"),
    ));
    await page.locator("#library-menu > summary").click();
    await page.locator("#refresh-files").click();
    await expect(page.locator("#file-list").getByRole("button", { name: "Many notes/Note 79.md", exact: true })).toBeAttached();
    await expect.poll(() => fileViewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBeTruthy();
    expect(await dimensions()).toEqual(before);
    expect(before.gutter).toBe(0);
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

test("source and metadata scrollbars do not change textarea width or consume a gutter", async ({ page }) => {
  const raw = "---\ntitle: Notes\n---\n\n# Body\n";
  await openFixture(page, "Textarea-scroll.md", raw);
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
  await expect(page.locator("#dirty-indicator")).toHaveText("Unsaved changes");
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
  await expect(page.locator("#dirty-indicator")).toHaveText("Unsaved changes");
});

test("file search has a line-only focus treatment and filenames have no square icons", async ({ page }) => {
  const input = page.locator("#file-filter");
  const box = await input.boundingBox();
  await input.click();
  expect(await input.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
  expect(await input.evaluate((element) => getComputedStyle(element).borderStyle)).toBe("none");
  expect(await input.boundingBox()).toEqual(box);
  const file = page.locator("#file-list").getByRole("button", { name: "README.md", exact: true });
  expect(await file.evaluate((element) => getComputedStyle(element, "::before").content)).toBe("none");
  await input.fill("README");
  await expect(file).toBeVisible();
  await expect(page.locator("#file-list .file-button")).toHaveCount(1);
  await page.screenshot({ path: path.join(buildRoot, "sidebar-search-focus.png") });
});
