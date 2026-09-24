import { test, expect, fs, path, buildRoot, chooseView, userDocumentUrl, userResourceId } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

async function projectApi(page, library, body) {
  const response = await page.request.post(new URL("/api/projects", library.url).href, { data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

export async function pasteImage(page, selector) {
  if (selector === ".ProseMirror") await expect(page.locator(selector)).toHaveAttribute("contenteditable", "true");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 12;
    const context = canvas.getContext("2d");
    context.fillStyle = "#267d9f";
    context.fillRect(0, 0, 16, 12);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
  await page.locator(selector).focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+v");
}

test("users create private projects and share a single page without exposing sibling notes or Git", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [alice, bob] = library.pages;
    await alice.locator("#projects-open").click();
    await alice.locator("#project-name").fill("Personal notebook");
    await alice.locator("#project-create").click();
    await expect(alice.locator("#projects-dialog")).toBeHidden();
    await expect(alice.locator("#projects-open")).toHaveText("Personal notebook");
    const id = new URL(alice.url()).searchParams.get("project");
    for (const [name, content] of [["Shared.md", "# Project-specific content\n"], ["Secret.md", "# Private sibling\n"]]) {
      const created = await alice.request.post(new URL("/api/document", library.url).href, {
        headers: { "X-Notes-Project": id }, data: { path: name, content },
      });
      expect(created.status(), await created.text()).toBe(201);
    }
    const document = await userResourceId(alice.context(), library.url, "Shared.md", "document", id);
    await alice.goto(await userDocumentUrl(alice.context(), library.url, "Shared.md", id));
    await expect(alice.locator(".ProseMirror")).toContainText("Project-specific content");
    await bob.locator("#projects-open").click();
    await expect(bob.locator("#projects-list")).not.toContainText("Personal notebook");
    await bob.locator("#projects-close").click();
    await alice.locator("#more-menu > summary").click();
    await alice.locator("#share-page").click();
    await alice.locator("#sharing-level").selectOption("read");
    await alice.locator("#sharing-save").click();
    await expect(alice.locator("#sharing-dialog")).toBeHidden();
    await bob.locator("#projects-open").click();
    await bob.locator(".project-open").filter({ hasText: "Personal notebook" }).click();
    await expect(bob.locator("#file-list")).toContainText("Shared.md");
    await expect(bob.locator("#file-list")).not.toContainText("Secret.md");
    await bob.locator('[data-path="Shared.md"]').click();
    await expect(bob.locator("#dirty-indicator")).toHaveText("Read only");
    await expect(bob.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    await expect(bob.locator("#git-tab")).toBeHidden();
    await expect(bob.locator("#new-note")).toBeDisabled();
    await bob.reload();
    await expect(bob.locator("#projects-open")).toHaveText("Personal notebook");
    await expect(bob.locator("#dirty-indicator")).toHaveText("Read only");
    await projectApi(alice, library, { action: "share", id, document, shared: "edit" });
    await expect(bob.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
    await bob.locator(".ProseMirror").click();
    await bob.keyboard.press("Control+End");
    await bob.keyboard.insertText(" Bob editing this page");
    await expect(alice.locator(".ProseMirror")).toContainText("Bob editing this page");
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await projectApi(alice, library, { action: "share", id, document, shared: "private" });
    await expect(bob.locator("#collaboration-message")).toContainText(/private|shared|permission/i);
    const denied = await bob.request.get(new URL(`/api/document?id=${document}&project=${id}`, library.url).href);
    expect(denied.status()).toBe(403);
    await alice.locator("#projects-open").click();
    await alice.locator('.project-open[data-project="default"]').click();
    await alice.locator('[data-path="Shared.md"]').click();
    await expect(alice.locator(".ProseMirror")).not.toContainText("Project-specific content");
    await expect(alice.locator(".ProseMirror")).toContainText("Alpha");
  } finally { await library.close(); }
});

test("clipboard images use the configured project directory in Live and Source, including page-only editors", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [alice, bob] = library.pages;
    const document = new URL(alice.url()).searchParams.get("document");
    await alice.locator("#settings-open").click();
    await alice.locator('[data-settings-tab="library"]').click();
    await alice.locator("#settings-image-directory").fill("media/pasted");
    await alice.locator("#settings-save").click();
    await expect(alice.locator("#settings-dialog")).toBeHidden();
    await projectApi(alice, library, { action: "share", id: "default", shared: "private" });
    await projectApi(alice, library, { action: "share", id: "default", document, shared: "edit" });
    await bob.reload();
    await expect(bob.locator("#collaboration-join")).toHaveText("Sharing");
    await pasteImage(bob, ".ProseMirror");
    await expect(bob.locator("#document-message")).toHaveText("Image inserted.");
    const image = alice.locator(".notes-inline-image img");
    await expect(image).toHaveCount(1);
    await expect.poll(() => image.evaluate((node) => node.naturalWidth)).toBe(16);
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    const content = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    expect(content).toMatch(/!\[Image\]\(media\/pasted\/image-[a-f0-9]+\.png\)/);
    expect(content).toContain("Alpha");
    expect(content).toContain("# Shared\n");
    expect(content.indexOf("![Image]")).toBeGreaterThan(content.indexOf("Beta"));
    await chooseView(bob, "editor");
    await pasteImage(bob, "#editor");
    await expect(bob.locator("#editor")).toHaveValue(/!\[Image\][\s\S]*!\[Image\]/);
    await expect(alice.locator(".notes-inline-image img")).toHaveCount(2);
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    const saved = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    expect(saved).toContain("# Shared\n");
    expect(saved.indexOf("![Image]")).toBeGreaterThan(saved.indexOf("Beta"));
    expect((await fs.readdir(path.join(library.notes, "media/pasted"))).filter((name) => name.endsWith(".png"))).toHaveLength(2);
    await projectApi(alice, library, { action: "share", id: "default", document, shared: "read" });
    await expect(bob.locator("#dirty-indicator")).toHaveText("Read only");
    await alice.screenshot({ path: path.join(buildRoot, "projects-image-sharing.png") });
  } finally { await library.close(); }
});

test("loading and warnings occupy the fixed status area without shifting editor or sidebar", async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/document?id=*", async (route) => {
    await pending;
    await route.continue();
  });
  const before = await page.locator("#document-panes").boundingBox();
  const sidebar = await page.locator("#file-nav").boundingBox();
  try {
    await page.locator('[data-path="Second.md"]').click();
    await expect(page.locator("#loading-message")).toContainText("Opening");
    expect(await page.locator("#loading-message").evaluate((node) => Boolean(node.closest(".status-bar")))).toBe(true);
    expect(await page.locator("#document-panes").boundingBox()).toEqual(before);
    expect(await page.locator("#file-nav").boundingBox()).toEqual(sidebar);
    await expect(page.locator(".document-alerts")).toHaveCount(0);
    await page.locator("#status-details").click();
    await expect(page.locator(".status-panel")).toContainText("Opening");
    await page.keyboard.press("Escape");
  } finally { release(); }
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  await page.route("**/api/git", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable for status layout test" }),
  }));
  await page.locator("#git-tab").click();
  await expect(page.locator("#git-message")).toContainText("Unavailable for status layout test");
  expect(await page.locator("#git-message").evaluate((node) => Boolean(node.closest(".status-bar")))).toBe(true);
});
