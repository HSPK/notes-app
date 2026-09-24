import { test, expect, chooseView, userDocumentUrl, openFixture, fs, path, root } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";
import { pasteImage } from "./project-cases.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

test("an upload crossing a document move retains the image without inserting a stale relative path", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private", source: true });
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  try {
    const [page] = library.pages;
    const id = new URL(page.url()).searchParams.get("document");
    const source = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    await page.route("**/api/images?document=*", async route => { await paused; await route.continue(); });
    const requested = page.waitForRequest(request => request.url().includes("/api/images?"));
    await pasteImage(page, "#editor");
    await requested;
    const moved = await page.request.patch(new URL("/api/entry", library.url).href, {
      data: { id, destination: "Moved.md", updateLinks: false },
    });
    expect(moved.ok(), await moved.text()).toBe(true);
    release();
    await expect(page.locator("#document-message")).toContainText("document moved while uploading");
    expect(await fs.readFile(path.join(library.notes, "Moved.md"), "utf8")).toBe(source);
    expect(await fs.readdir(path.join(library.notes, "assets/images"))).toHaveLength(1);
    await expect(page.locator("#editor")).toHaveValue(source);
  } finally { release(); await library.close(); }
});

test("hydrating resource URL attributes does not rewrite portable Markdown or suppress text edits", async ({ page }) => {
  const original = "# Links\n\n[Second](Second.md)\n";
  await openFixture(page, "Identity-render.md", original);
  await page.locator(".ProseMirror a").evaluate((node) => {
    node.setAttribute("href", node.getAttribute("href"));
    node.setAttribute("title", "Resolved resource");
    node.dataset.noteUrl = "/Second.md";
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("#editor")).toHaveValue(original);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Identity-render.md"), "utf8")).toBe(original);
  await page.locator(".ProseMirror h1").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" edited");
  await expect(page.locator("#editor")).toHaveValue(/# Links edited[\s\S]*\[Second\]\(Second\.md\)/);
});

test("document UUID navigation, save and local asset URLs contain no mutable path queries", async ({ page }) => {
  const id = new URL(page.url()).searchParams.get("document");
  expect(id).toMatch(uuid);
  await expect(page.locator(".notes-inline-image img")).toHaveAttribute("src", /\/assets\?id=[a-f0-9-]+&document=[a-f0-9-]+/);
  const link = page.locator(".ProseMirror a").filter({hasText:"Second"});
  const destination = await link.getAttribute("href");
  expect(new URL(destination, page.url()).searchParams.get("document")).toMatch(uuid);
  const paths = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") || url.pathname === "/assets") {
      if (url.searchParams.has("path") || url.searchParams.has("file")) paths.push(request.url());
    }
  });
  await link.click({modifiers:["Control"]});
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  const second = new URL(page.url()).searchParams.get("document");
  expect(second).toMatch(uuid);
  expect(second).not.toBe(id);
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# UUID saved\n");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await page.reload();
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  expect(new URL(page.url()).searchParams.get("document")).toBe(second);
  await expect(page.locator(".ProseMirror")).toContainText("UUID saved");
  expect(paths).toEqual([]);
});

test("UUID bookmarks and public links stay valid after an owner renames the document", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private", source: true });
  const guest = await browser.newContext();
  try {
    const [owner] = library.pages;
    const bookmark = await userDocumentUrl(owner.context(), library.url, "Shared.md");
    const id = new URL(bookmark).searchParams.get("document");
    await owner.locator("#more-menu > summary").click();
    await owner.locator("#share-page").click();
    await owner.locator("#sharing-level").selectOption("publicRead");
    await owner.locator("#sharing-save").click();
    await expect(owner.locator("#sharing-public-url")).toHaveValue(/share=[a-f0-9]{64}/);
    const publicUrl = await owner.locator("#sharing-public-url").inputValue();
    await owner.locator("#sharing-cancel").click();
    const moved = await owner.request.patch(new URL("/api/entry", library.url).href, {
      data: {id, destination:"Renamed.md", updateLinks:false},
    });
    expect(moved.ok(), await moved.text()).toBe(true);
    await owner.goto(bookmark);
    await expect(owner.locator("#document-title")).toHaveText("Shared");
    await expect(owner.locator('[data-path="Renamed.md"]')).toBeVisible();
    expect(new URL(owner.url()).searchParams.get("document")).toBe(id);
    const page = await guest.newPage();
    await page.goto(publicUrl);
    await expect(page.locator(".ProseMirror")).toContainText("Alpha");
    await expect(page.locator("#dirty-indicator")).toHaveText("Read only");
    expect(new URL(page.url()).searchParams.has("document")).toBe(false);
    await library.restart();
    await owner.goto(bookmark);
    await expect(owner.locator("#document-title")).toHaveText("Shared");
    expect(new URL(owner.url()).searchParams.get("document")).toBe(id);
  } finally { await guest.close(); await library.close(); }
});
