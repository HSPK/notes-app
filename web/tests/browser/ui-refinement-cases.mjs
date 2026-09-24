import { test, expect, fs, path, buildRoot } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

test("visual refinement walkthrough covers workspace controls at desktop and narrow sizes", async ({ browser }) => {
  const content = "---\ntitle: 设计与研究 · Design notes\ntags: [research, UI, collaboration]\nstatus: draft\n---\n\n"
    + "# Design notes\n\nA quiet workspace for ideas, decisions, and the next small step.\n\n"
    + "## Today\n\n- [ ] Review navigation and spacing\n- [x] Keep notes in plain Markdown\n\n"
    + "## Reference\n\n[[Other|Related note]] and inline math $x^2 + y^2$.\n\n"
    + "| Area | Goal |\n| --- | --- |\n| Typography | Clear hierarchy |\n| Layout | Consistent spacing |\n";
  const library = await collaborativeLibrary(browser, { content });
  const anonymous = await browser.newContext();
  const output = path.join(buildRoot, "ui-refinement", process.env.NOTES_UI_CAPTURE ?? "current");
  const geometry = [];
  try {
    await fs.mkdir(output, { recursive: true });
    const [page] = library.pages;
    const faults = [];
    page.on("pageerror", (error) => faults.push(error.message));
    await page.setViewportSize({ width: 1440, height: 960 });
    await fs.mkdir(path.join(library.notes, "Guides"), { recursive: true });
    await fs.mkdir(path.join(library.notes, "Planning"), { recursive: true });
    for (const [name, title] of [
      ["Guides/Start.md", "Getting started"],
      ["Guides/Research.md", "Research notes and longer descriptive document titles"],
      ["Planning/Weekly.md", "Weekly review"],
    ]) await fs.writeFile(path.join(library.notes, name), `---\ntitle: ${title}\ntags: [research]\n---\n\n# ${title}\n`);
    await page.locator("#refresh-files").click();
    await expect(page.locator('[data-path="Guides/Research.md"]')).toBeAttached();
    await expect(page.locator(".sidebar-footer, #library-menu, #library-name, #file-count, #root-path")).toHaveCount(0);
    await expect(page.locator(".library-actions #refresh-files")).toBeVisible();
    await page.keyboard.press("Escape");
    const capture = async (name) => {
      await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
      const measurement = await page.evaluate((name) => ({
        name, viewport: { width: innerWidth, height: innerHeight },
        bodyWidth: document.body.scrollWidth,
        panels: [...document.querySelectorAll("dialog[open], .popup[open] > .popup-panel")].map((node) => {
          const rect = node.getBoundingClientRect();
          return { id: node.id || node.parentElement.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }),
      }), name);
      geometry.push(measurement);
      expect(measurement.bodyWidth).toBeLessThanOrEqual(measurement.viewport.width);
      const inconsistent = await page.locator("button, summary, .popup-panel a").evaluateAll(nodes => nodes
        .filter(node => node.id !== "sidebar-scrim" && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
        .filter(node => {
          const style = getComputedStyle(node);
          return style.borderRadius !== "6px" || style.borderBottomWidth !== style.borderTopWidth || style.boxShadow !== "none";
        }).map(node => ({ id: node.id, class: node.className, text: node.textContent.slice(0, 40) })));
      expect(inconsistent, `${name}: inconsistent controls`).toEqual([]);
      for (const panel of measurement.panels) {
        expect(panel.x, `${name}: ${panel.id} left`).toBeGreaterThanOrEqual(0);
        expect(panel.y, `${name}: ${panel.id} top`).toBeGreaterThanOrEqual(0);
        expect(panel.x + panel.width, `${name}: ${panel.id} right`).toBeLessThanOrEqual(measurement.viewport.width);
        expect(panel.y + panel.height, `${name}: ${panel.id} bottom`).toBeLessThanOrEqual(measurement.viewport.height);
      }
      if (await page.locator("#settings-dialog").isVisible()) {
        const dialog = await page.locator("#settings-dialog").boundingBox();
        const save = await page.locator("#settings-save").boundingBox();
        expect(save.y + save.height).toBeLessThan(dialog.y + dialog.height - 8);
        await page.locator("#settings-save").click({ trial: true });
        await expect(page.locator("#settings-library-label")).toHaveText("Current project");
        await expect(page.locator("#settings-library-root")).toHaveText("notes");
      }
      if (await page.locator("#search-dialog").isVisible()) {
        const dialog = await page.locator("#search-dialog").boundingBox();
        const results = await page.locator(".search-layout").boundingBox();
        expect(results.y + results.height).toBeLessThanOrEqual(dialog.y + dialog.height - 18);
        for (const id of ["search-project", "search-field"]) {
          const label = await page.locator(`label[for="${id}"]`).boundingBox();
          const control = await page.locator(`#${id}`).boundingBox();
          expect(Math.abs(label.y + label.height / 2 - control.y - control.height / 2)).toBeLessThan(1);
        }
        for (const snippet of await page.locator(".search-snippet").all()) {
          expect((await snippet.boundingBox()).height).toBeLessThanOrEqual(54);
        }
      }
    };
    const openMore = async (id) => {
      await page.locator("#more-menu > summary").click();
      await page.locator(`#${id}`).click();
    };
    await capture("desktop-document");
    await page.locator(".notes-metadata summary").click();
    await capture("desktop-metadata");
    await page.locator(".notes-metadata summary").click();
    await page.locator("#more-menu > summary").click();
    await capture("desktop-menu");
    await page.keyboard.press("Escape");
    await page.locator("#settings-open").click();
    await page.locator('[data-settings-tab="library"]').click();
    await capture("desktop-settings");
    expect((await page.locator("#hidden-patterns").boundingBox()).height).toBeLessThan(170);
    await page.locator("#settings-cancel").click();
    await page.locator("#projects-open").click();
    await expect(page.locator('.project-open[data-project="default"]')).toHaveAttribute("aria-current", "true");
    await capture("desktop-projects");
    await page.locator("#projects-close").click();
    await openMore("share-page");
    await page.locator("#sharing-level").selectOption("publicRead");
    await capture("desktop-sharing");
    await page.locator("#sharing-cancel").click();
    await page.keyboard.press("Control+p");
    await page.locator("#search-query").fill("design");
    await expect(page.locator("#search-results")).toContainText("Design notes");
    await capture("desktop-search");
    await expect(page.locator(".search-snippet mark").first()).toBeVisible();
    expect(await page.locator(".search-snippet").first().textContent()).toContain("\n");
    await page.locator("#search-close").click();
    await openMore("history-open");
    await expect(page.locator("#history-list button")).toHaveCount(1);
    await expect(page.locator("#history-copy")).toBeEnabled();
    await capture("desktop-history");
    await page.locator("#history-close").click();
    await openMore("workspace-favorite");
    await expect(page.locator("#workspace-favorite")).toHaveText("Remove from favorites");
    await page.locator("#more-menu > summary").click();
    await capture("desktop-menu-favorite");
    await page.keyboard.press("Escape");
    await expect(page.locator("#document-tabs, #workspace-pin")).toHaveCount(0);
    await openMore("workspace-open");
    await expect(page.locator("#workspace-list")).toContainText("Design notes");
    await capture("desktop-workspace");
    await expect(page.locator(".workspace-item-name")).toHaveCSS("text-align", "left");
    const kind = await page.locator("#workspace-kind").boundingBox();
    const filter = await page.locator("#workspace-filter").boundingBox();
    expect(kind.y).toBe(filter.y);
    await page.locator("#workspace-close").click();
    await page.locator("#new-note").click();
    await page.locator("#new-note-template").selectOption("weekly");
    await capture("desktop-new-note");
    await page.locator("#cancel-new-note").click();
    await page.locator("#settings-open").click();
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.locator("#settings-theme").selectOption("dark");
    await page.locator("#settings-save").click();
    await page.keyboard.press("Control+p");
    await expect(page.locator("#search-results")).toContainText("Design notes");
    await capture("dark-search");
    await page.locator("#search-close").click();
    await page.locator("#projects-open").click();
    await capture("dark-projects");
    await page.locator("#projects-close").click();
    await page.setViewportSize({ width: 390, height: 680 });
    await expect(page.locator("body")).toHaveAttribute("data-sidebar", "closed");
    await capture("narrow-document");
    await page.locator("#more-menu > summary").click();
    await capture("narrow-menu");
    await page.keyboard.press("Escape");
    await openMore("share-page");
    await page.locator("#sharing-level").selectOption("publicRead");
    await capture("narrow-sharing");
    await page.locator("#sharing-cancel").click();
    await page.keyboard.press("Control+p");
    await expect(page.locator("#search-results")).toContainText("Design notes");
    await capture("narrow-search");
    const searchHeader = await page.locator("#search-title").boundingBox();
    await page.locator("#search-query").press("ArrowUp");
    await expect(page.locator("#search-results button").last()).toHaveAttribute("aria-selected", "true");
    await capture("narrow-search-last");
    expect(await page.locator("#search-title").boundingBox()).toEqual(searchHeader);
    await page.locator("#search-close").click();
    await page.locator("#settings-open").click();
    await page.locator('[data-settings-tab="library"]').click();
    await capture("narrow-settings");
    const tabs = await page.locator(".settings-tabs").boundingBox();
    const settingsContent = await page.locator(".settings-content").boundingBox();
    expect(tabs.y + tabs.height).toBeLessThanOrEqual(settingsContent.y);
    await page.locator('[data-settings-tab="accessibility"]').click();
    await expect(page.locator('[data-settings-panel="accessibility"]')).toBeVisible();
    await page.locator('[data-settings-tab="library"]').click();
    await page.locator("#settings-image-quality").scrollIntoViewIfNeeded();
    await capture("narrow-settings-bottom");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-dialog")).not.toBeVisible();
    await page.setViewportSize({ width: 780, height: 420 });
    await page.locator("#more-menu > summary").click();
    await capture("short-menu");
    await page.locator('#more-menu a').scrollIntoViewIfNeeded();
    await capture("short-menu-bottom");
    await page.locator("#focus-mode").click();
    await expect(page.locator("body")).toHaveAttribute("data-focus", "true");
    await openMore("focus-mode");
    await expect(page.locator("body")).toHaveAttribute("data-focus", "false");
    await page.keyboard.press("Escape");
    await page.locator("#settings-open").click();
    await capture("short-settings");
    await page.locator("#settings-cancel").click();
    await page.keyboard.press("Control+p");
    await expect(page.locator("#search-results")).toContainText("Design notes");
    await capture("short-search");
    await page.locator("#search-close").click();
    const login = await anonymous.newPage();
    await login.setViewportSize({ width: 390, height: 680 });
    await login.goto(library.url);
    await expect(login.locator("#auth-screen")).toBeVisible();
    await login.screenshot({ path: path.join(output, "narrow-login.png"), animations: "disabled" });
    await fs.writeFile(path.join(output, "geometry.json"), JSON.stringify(geometry, null, 2));
    expect(faults).toEqual([]);
  } finally { await anonymous.close(); await library.close(); }
});
