import { test, expect, fs, path, root, buildRoot, chooseView, metadataField } from "./fixture.mjs";

test("title-only creation keeps metadata exact and creation time stable through editing", async ({ page }) => {
  const title = '研究: "A/B"?';
  const filename = "研究- -A-B-.md";
  const before = Date.now();
  await page.locator("#new-note").click();
  await expect(page.locator("#new-note-path")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
  await expect(page.locator("#new-note-hint")).toHaveText(`File: ${filename}`);
  await page.screenshot({ path: path.join(buildRoot, "title-first-new-note.png") });
  await page.locator("#create-note").click();
  await expect(page.locator("#new-note-dialog")).toBeHidden();
  await expect(page.locator("#document-title")).toHaveText(title);
  await expect(page).toHaveTitle(`${title} — Notes`);
  await expect(page.locator("#document-modified")).toBeHidden();
  const createdSource = await fs.readFile(path.join(root, filename), "utf8");
  expect(createdSource).toContain(`title: ${JSON.stringify(title)}\n`);
  const created = createdSource.match(/^created: "([^"]+)"$/m)?.[1];
  expect(created).toBeDefined();
  expect(new Date(created).toISOString()).toBe(created);
  expect(Date.parse(created)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(created)).toBeLessThanOrEqual(Date.now());
  const metadata = await metadataField(page);
  const renamed = "Displayed document title";
  await metadata.fill((await metadata.inputValue()).replace(JSON.stringify(title), JSON.stringify(renamed)));
  await expect(page).toHaveTitle(`${renamed} * — Notes`);
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page).toHaveTitle(`${renamed} — Notes`);
  await chooseView(page, "editor");
  await page.locator("#editor").fill((await page.locator("#editor").inputValue())
    .replace(JSON.stringify(renamed), '"Source title"') + "# Body added later\n");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page).toHaveTitle("Source title — Notes");
  await page.reload();
  await expect(page).toHaveTitle("Source title — Notes");
  const saved = await fs.readFile(path.join(root, filename), "utf8");
  expect(saved).toContain(`created: "${created}"`);
  expect(saved).toContain("# Body added later");
});

test("template selection preserves a custom title and every template creates metadata", async ({ page }) => {
  for (const [kind, title, body] of [
    ["daily", "Custom daily title", "Priorities"],
    ["weekly", "Custom weekly title", "Highlights"],
    ["meeting", "Custom meeting title", "Attendees"],
  ]) {
    await page.locator("#new-note").click();
    await page.locator("#new-note-title").fill(title);
    await page.locator("#new-note-template").selectOption(kind);
    await expect(page.locator("#new-note-title")).toHaveValue(title);
    await page.locator("#create-note").click();
    await expect(page.locator("#document-title")).toHaveText(title);
    await expect(page).toHaveTitle(`${title} — Notes`);
    await expect(page.locator(".ProseMirror")).toContainText(body);
    const content = await fs.readFile(path.join(root, `${title}.md`), "utf8");
    expect(content).toContain(`title: "${title}"`);
    expect(content).toMatch(/^created: "\d{4}-\d{2}-\d{2}T[\d:.]+Z"$/m);
    expect(content).toMatch(/^date: \d{4}-\d{2}-\d{2}$/m);
    expect(content).toMatch(/^tags: \[[a-z]+\]$/m);
  }
});
