import { test, expect, fs, path, root } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

test("daily templates create tagged notes and dropped images respect compression settings", async ({ page }) => {
  await page.locator("#new-note").click();
  await page.locator("#new-note-template").selectOption("daily");
  const title = await page.locator("#new-note-title").inputValue();
  expect(title).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const name = `${title}.md`;
  await page.locator("#create-note").click();
  await expect(page.locator(".ProseMirror")).toContainText("Priorities");
  expect(await fs.readFile(path.join(root, name), "utf8")).toContain("tags: [journal]");
  await page.locator("#settings-open").click();
  await page.locator('[data-settings-tab="library"]').click();
  await page.locator("#settings-image-compression").selectOption("jpeg");
  await page.locator("#settings-image-max-edge").selectOption("1024");
  await page.locator("#settings-save").click();
  const transfer = await page.evaluateHandle(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 1024;
    canvas.getContext("2d").fillRect(0, 0, 2048, 1024);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "drop.png", { type: "image/png" }));
    return transfer;
  });
  const body = page.locator(".ProseMirror");
  const bounds = await body.boundingBox();
  await body.dispatchEvent("drop", { dataTransfer: transfer, clientX: bounds.x + 20, clientY: bounds.y + 20 });
  await expect(page.locator(".notes-inline-image img")).toHaveCount(1);
  const image = page.locator(".notes-inline-image img");
  await expect(image).toHaveAttribute("src", /\/assets\?id=[a-f0-9-]+&document=[a-f0-9-]+/);
  const asset = await page.request.get(new URL(await image.getAttribute("src"), page.url()).href);
  expect(asset.ok()).toBe(true);
  expect(asset.headers()["content-type"]).toMatch(/^image\/jpeg/);
  await expect.poll(() => image.evaluate((node) => [node.naturalWidth, node.naturalHeight])).toEqual([1024, 512]);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, name), "utf8")).toContain(".jpg)");
});

test("attachment cleanup only recycles confirmed unreferenced files and can restore them", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [owner, member] = library.pages;
    const base64 = await owner.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await fs.writeFile(path.join(library.notes, "orphan.png"), Buffer.from(base64, "base64"));
    await fs.writeFile(path.join(library.notes, "used.png"), Buffer.from(base64, "base64"));
    await fs.writeFile(path.join(library.notes, "Other.md"), "# Other\n\n![Used](used.png)\n");
    await member.close({ runBeforeUnload: false });
    await owner.locator("#collaboration-join").click();
    await expect(owner.locator("#collaboration-join")).toHaveText("Collaborate");
    await owner.locator("#more-menu > summary").click();
    await owner.locator("#attachments-open").click();
    await expect(owner.locator("#attachments-list")).toContainText("orphan.png");
    await expect(owner.locator("#attachments-list")).not.toContainText("used.png");
    await owner.getByRole("checkbox", { name: "Select orphan.png", exact: true }).check();
    owner.once("dialog", (dialog) => dialog.accept());
    await owner.locator("#attachments-recycle").click();
    await expect(owner.locator("#attachments-list")).not.toContainText("orphan.png");
    expect(await fs.stat(path.join(library.notes, "orphan.png")).then(() => true, () => false)).toBe(false);
    expect(await fs.stat(path.join(library.notes, "used.png")).then(() => true, () => false)).toBe(true);
    await owner.locator("#attachments-close").click();
    await owner.locator("#more-menu > summary").click();
    await owner.locator("#trash-open").click();
    await owner.getByRole("button", { name: "Restore orphan.png", exact: true }).click();
    await expect(owner.locator("#trash-list")).not.toContainText("orphan.png");
    expect(await fs.readFile(path.join(library.notes, "orphan.png"))).toEqual(Buffer.from(base64, "base64"));
  } finally { await library.close(); }
});
