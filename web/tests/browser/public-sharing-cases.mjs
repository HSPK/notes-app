import { test, expect, fs, path, buildRoot, chooseView, userDocumentUrl } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";
import { pasteImage } from "./project-cases.mjs";

async function tryReadOnlySocketWrite(page) {
  return page.evaluate(async () => {
    const share = new URL(location.href).searchParams.get("share");
    const session = await (await fetch("/api/public/session", {
      method: "POST", headers: { "X-Notes-Share": share },
    })).json();
    const response = await fetch("/api/public/collaboration/join", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Notes-Share": share },
      body: JSON.stringify({ document: session.id }),
    });
    return { status: response.status, ...(await response.json()) };
  });
}

test("public document links default to read-only, allow opt-in anonymous collaboration and revoke live guests", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  const guest = await browser.newContext();
  const secondGuest = await browser.newContext();
  try {
    const [owner] = library.pages;
    await owner.locator("#more-menu > summary").click();
    await owner.locator("#share-page").click();
    await expect(owner.locator("#sharing-level")).toHaveValue("inherit");
    await owner.locator("#sharing-level").selectOption("publicRead");
    await expect(owner.locator("#sharing-public-edit")).not.toBeChecked();
    await owner.locator("#sharing-save").click();
    await expect(owner.locator("#sharing-public-url")).toHaveValue(/\/share\?share=[a-f0-9]{64}$/);
    const url = await owner.locator("#sharing-public-url").inputValue();
    const page = await guest.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator("#collaboration-join")).toBeHidden();
    await expect(page.locator(".ProseMirror")).toContainText("Alpha");
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    await expect(page.locator("#dirty-indicator")).toHaveText("Read only");
    for (const selector of ["#sidebar", "#sidebar-toggle", "#settings-open", "#projects-open", "#share-page"]) {
      await expect(page.locator(selector)).toBeHidden();
    }
    await expect(page.locator(".collaboration-avatar")).toHaveCount(0);
    expect((await guest.cookies()).filter((cookie) => cookie.name.startsWith("notes_user_session"))).toHaveLength(0);
    expect((await guest.request.get(new URL("/api/projects", url).href)).status()).toBe(401);
    expect((await tryReadOnlySocketWrite(page)).status).toBe(403);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).not.toContain("Rejected anonymous change");
    await chooseView(page, "editor");
    await expect(page.locator("#editor")).toHaveJSProperty("readOnly", true);
    await owner.locator("#sharing-public-edit").check();
    await owner.locator("#sharing-save").click();
    await expect(owner.locator("#sharing-public-url")).toHaveValue(url);
    await expect(page.locator("#collaboration-join")).toHaveText("Sharing");
    await expect(page.locator("#editor")).toHaveJSProperty("readOnly", false);
    await page.locator("#editor").focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("\nAnonymous edit 中文\n");
    await expect(owner.locator(".ProseMirror")).toContainText("Anonymous edit 中文");
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    const other = await secondGuest.newPage();
    await other.goto(url);
    await expect(other.locator("#collaboration-join")).toHaveText("Sharing");
    await expect(other.getByRole("img", { name: /^Guest [a-f0-9]+ \(you\)$/ })).toBeVisible();
    await expect(owner.locator(".collaboration-avatar")).toHaveCount(4);
    const names = await owner.locator(".collaboration-avatar").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    expect(new Set(names.filter((name) => name.startsWith("Guest "))).size).toBe(2);
    await pasteImage(page, "#editor");
    await expect(page.locator("#editor")).toHaveValue(/!\[Image\]\(assets\/images\/image-/);
    await expect(other.locator(".notes-inline-image img")).toHaveCount(1);
    await expect.poll(() => other.locator(".notes-inline-image img").evaluate((image) => image.naturalWidth)).toBe(16);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await page.screenshot({ path: path.join(buildRoot, "public-document-sharing.png") });
    await owner.locator("#sharing-public-edit").uncheck();
    await owner.locator("#sharing-save").click();
    await expect(page.locator("#editor")).toHaveJSProperty("readOnly", true);
    await expect(other.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    owner.once("dialog", (dialog) => dialog.accept());
    await owner.locator("#sharing-reset-link").click();
    await expect(owner.locator("#sharing-public-url")).not.toHaveValue(url);
    const replacement = await owner.locator("#sharing-public-url").inputValue();
    await expect(page.locator("#collaboration-message")).toContainText("revoked");
    await page.reload();
    await expect(page.locator("#connection-message")).toContainText("revoked");
    await expect(page.locator("#auth-screen")).toBeHidden();
    await page.goto(replacement);
    await expect(page.locator(".ProseMirror")).toContainText("Anonymous edit 中文");
    await expect(page.locator("#dirty-indicator")).toHaveText("Read only");
    await owner.locator("#sharing-level").selectOption("private");
    await owner.locator("#sharing-save").click();
    await expect(owner.locator("#sharing-dialog")).toBeHidden();
    await expect(page.locator("#collaboration-message")).toContainText("revoked");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toContain("Anonymous edit 中文");
    expect(errors).toEqual([]);
  } finally {
    await guest.close();
    await secondGuest.close();
    await library.close();
  }
});

test("a document can be private or read-only inside an editable shared project", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [owner, member] = library.pages;
    await owner.locator("#more-menu > summary").click();
    await owner.locator("#share-page").click();
    await owner.locator("#sharing-level").selectOption("read");
    await owner.locator("#sharing-save").click();
    await expect(member.locator("#dirty-indicator")).toHaveText("Read only");
    await member.reload();
    await expect(member.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    await owner.locator("#more-menu > summary").click();
    await owner.locator("#share-page").click();
    await owner.locator("#sharing-level").selectOption("private");
    await owner.locator("#sharing-save").click();
    await expect(member.locator("#collaboration-message")).toContainText(/private|permission/i);
    await member.goto(await userDocumentUrl(member.context(), library.url, "Other.md"));
    await expect(member.locator(".ProseMirror")).toContainText("Other");
    await expect(member.locator('[data-path="Shared.md"]')).toHaveCount(0);
    await expect(member.locator("#git-tab")).toBeHidden();
    await owner.locator("#more-menu > summary").click();
    await owner.locator("#share-page").click();
    await owner.locator("#sharing-level").selectOption("inherit");
    await owner.locator("#sharing-save").click();
    await expect(owner.locator("#sharing-dialog")).toBeHidden();
    await member.goto(await userDocumentUrl(member.context(), library.url, "Shared.md"));
    await expect(member.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
    await expect(member.locator("#git-tab")).toBeVisible();
  } finally { await library.close(); }
});
