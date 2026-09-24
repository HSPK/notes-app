import { test, expect, fs, path, root, openFixture, chooseView } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

test("wiki links render and autocomplete without changing code literals or aliases", async ({ page }) => {
  const content = "# Wiki\n\n[[Second|Other note]]\n\n`[[Literal]]`\n\n";
  await openFixture(page, "Wiki.md", content);
  await expect(page.locator(".ProseMirror .notes-wiki-link")).toHaveText("Other note");
  await expect(page.locator(".ProseMirror code")).toHaveText("[[Literal]]");
  await page.locator(".ProseMirror").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("[[Sec");
  await expect(page.locator("#notes-wiki-menu")).toBeVisible();
  await page.locator("#notes-wiki-menu").getByRole("option", { name: /Second.md/ }).click();
  await expect(page.locator(".ProseMirror .notes-wiki-link")).toHaveCount(2);
  await page.keyboard.insertText(" linked");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  const saved = await fs.readFile(path.join(root, "Wiki.md"), "utf8");
  expect(saved).toContain("[[Second|Other note]]");
  expect(saved).toContain("[[/Second.md");
  expect(saved).toContain("`[[Literal]]`");
  await chooseView(page, "preview");
  await expect(page.locator('#preview a').filter({ hasText: "Other note" })).toHaveAttribute("href", /\/\?document=[a-f0-9-]+/);
  await chooseView(page, "rich");
  await page.locator(".notes-wiki-link").first().click({ modifiers: ["Control"] });
  await expect(page.locator("#document-title")).toHaveText("Second.md");
});

test("public link passwords gate anonymous editing and the owner can manage all links", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  const guest = await browser.newContext();
  try {
    const [owner] = library.pages;
    await owner.locator("#more-menu > summary").click();
    await owner.locator("#share-page").click();
    await owner.locator("#sharing-level").selectOption("publicRead");
    await owner.locator("#sharing-password").fill("a private share password");
    await owner.locator("#sharing-save").click();
    await expect(owner.locator("#sharing-public-url")).toHaveValue(/share=[a-f0-9]{64}/);
    const url = await owner.locator("#sharing-public-url").inputValue();
    const page = await guest.newPage();
    await page.goto(url);
    await expect(page.locator("#public-password-dialog")).toBeVisible();
    await expect(page.locator("#document-panes")).toBeHidden();
    await page.locator("#public-password").fill("incorrect password");
    await page.locator("#public-password-submit").click();
    await expect(page.locator("#public-password-error")).toContainText("incorrect");
    await page.locator("#public-password").fill("a private share password");
    await page.locator("#public-password-submit").click();
    await expect(page.locator("#public-password-dialog")).toBeHidden();
    await expect(page.locator(".ProseMirror")).toContainText("Alpha");
    await expect(page.locator("#dirty-indicator")).toHaveText("Read only");
    await page.reload();
    await expect(page.locator("#public-password-dialog")).toBeHidden();
    await expect(page.locator(".ProseMirror")).toContainText("Alpha");
    await owner.locator("#sharing-cancel").click();
    await owner.locator("#more-menu > summary").click();
    await owner.locator("#shares-open").click();
    await expect(owner.locator("#shares-list")).toContainText("Shared.md");
    await expect(owner.locator("#shares-list")).toContainText("Password protected");
    owner.once("dialog", (dialog) => dialog.accept());
    await owner.locator("#shares-list").getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(owner.locator("#shares-list")).not.toContainText("Shared.md");
    await expect(page.locator("#collaboration-message")).toContainText("revoked");
  } finally { await guest.close(); await library.close(); }
});
