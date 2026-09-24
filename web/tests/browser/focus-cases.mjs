import { test, expect, buildRoot, path, chooseView, openFixture, metadataField } from "./fixture.mjs";

async function expectQuietFocus(page, target, feedback = "surface") {
  const before = await target.boundingBox();
  await page.keyboard.press("Tab");
  await target.focus();
  await expect(target).toBeFocused();
  const style = await target.evaluate((node) => ({
    outline: getComputedStyle(node).outlineStyle,
    shadow: getComputedStyle(node).boxShadow,
    background: getComputedStyle(node).backgroundColor,
    radius: getComputedStyle(node).borderRadius,
    top: getComputedStyle(node).borderTopWidth,
    bottom: getComputedStyle(node).borderBottomWidth,
  }));
  expect(style.outline).toBe("none");
  if (feedback === "ring") {
    expect(style.shadow).toMatch(/0px 0px 0px [12]px inset/);
  } else {
    expect(style.shadow).toBe("none");
    if (feedback === "surface") {
      expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(style.radius).toBe("6px");
      expect(style.bottom).toBe(style.top);
    }
  }
  const after = await target.boundingBox();
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
}

test("keyboard focus uses shared rounded surfaces across menus, lists and settings without highlight bars", async ({ page }) => {
  for (const theme of ["light", "dark"]) {
    await page.route("**/api/appearance", (route) => route.fulfill({
      json: { theme, latinFont: "sans-serif", cjkFont: "sans-serif" },
    }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const strength of ["true", "false"]) {
      await page.locator("html").evaluate((node, value) => {
        node.dataset.strongFocus = value;
      }, strength);
      for (const selector of [
        "#sidebar-toggle", "#settings-open", "#view-menu > summary",
        "#files-tab", "#refresh-files", "#file-list .file-button",
      ]) {
        await expectQuietFocus(page, page.locator(selector).first());
      }
    }
    await page.locator("#outline-tab").click();
    const heading = page.locator("#outline-list button").first();
    await expectQuietFocus(page, heading);
    const bounds = await heading.boundingBox();
    const panel = await page.locator("#outline-scroll").boundingBox();
    expect(bounds.x).toBeGreaterThan(panel.x);
    expect(bounds.x + bounds.width).toBeLessThan(panel.x + panel.width);
    expect(await heading.evaluate((node) =>
      parseFloat(getComputedStyle(node).borderRadius))).toBeGreaterThan(0);
    await page.locator("#settings-open").click();
    await expectQuietFocus(page, page.locator("#settings-search"), "ring");
    await expectQuietFocus(page, page.locator("#hidden-patterns"), "ring");
    await page.locator("#settings-dialog").getByRole("tab", { name: "Layout", exact: true }).click();
    await expectQuietFocus(page, page.locator("#settings-page-width"), "ring");
    await page.screenshot({ path: path.join(buildRoot, `focus-settings-${theme}.png`) });
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-dialog")).toBeHidden();
    await expectQuietFocus(page, page.locator("#settings-open"));
    await page.locator("#files-tab").click();
  }
});

test("writing surfaces stay frameless and forced colors retain keyboard focus", async ({ page }) => {
  await openFixture(page, "Focus.md", "---\ntitle: Focus\n---\n\n# Focus\n\n$x$ and text.\n", "Focus");
  const metadata = await metadataField(page);
  await expectQuietFocus(page, metadata, "ring");
  const prose = page.locator(".ProseMirror");
  await expectQuietFocus(page, prose, "none");
  const math = page.locator(".notes-math-output");
  await expectQuietFocus(page, math, "ring");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Inline TeX source")).toBeVisible();
  await chooseView(page, "editor");
  await expectQuietFocus(page, page.locator("#editor"), "none");
  await chooseView(page, "preview");
  await expectQuietFocus(page, page.locator("#preview"), "none");
  await page.emulateMedia({ forcedColors: "active" });
  await page.keyboard.press("Tab");
  await page.locator("#settings-open").focus();
  const forced = await page.locator("#settings-open").evaluate((node) => ({
    style: getComputedStyle(node).outlineStyle,
    width: getComputedStyle(node).outlineWidth,
    offset: getComputedStyle(node).outlineOffset,
  }));
  expect(forced).toEqual({ style: "solid", width: "1px", offset: "-1px" });
});

test("Ctrl-click block selection adds no line below text or code and still opens links", async ({ page }) => {
  const content = "# Heading\n\nA paragraph to select.\n\n```js\nconst selected = true;\n```\n\n[Second](Second.md)\n";
  await openFixture(page, "Ctrl-click.md", content);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((node, theme) => { node.dataset.theme = theme; }, theme);
    for (const selector of [".ProseMirror h1", ".ProseMirror > p:first-of-type", ".ProseMirror pre"]) {
      const block = page.locator(selector);
      await block.click({ modifiers: ["Control"], position: { x: 20, y: 12 } });
      const selected = page.locator(".ProseMirror-selectednode");
      await expect(selected).toHaveCount(1);
      expect(await selected.evaluate((node) => ({
        outline: getComputedStyle(node).outlineStyle,
        shadow: getComputedStyle(node).boxShadow,
      }))).toEqual({ outline: "none", shadow: "none" });
      await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    }
  }
  await expect(page.locator("#editor")).toHaveValue(content);
  await page.emulateMedia({ forcedColors: "active" });
  expect(await page.locator(".ProseMirror-selectednode").evaluate((node) =>
    getComputedStyle(node).outlineStyle)).toBe("solid");
  await page.emulateMedia({ forcedColors: "none" });
  await page.getByRole("link", { name: "Second", exact: true }).click({ modifiers: ["Control"] });
  await expect(page.locator("#document-title")).toHaveText("Second.md");
});
