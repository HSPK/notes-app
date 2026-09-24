import { test, expect, fs, path, buildRoot } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";
import { measureClickFrame, summarizeTimings } from "./performance-helpers.mjs";

test("large history list benchmark measures snapshot capture and usable dialog latency", async ({ browser }) => {
  test.skip(!process.env.NOTES_BENCH_HISTORY_LIST, "Opt-in large-document history measurement.");
  const block = "## Topic\n\nA paragraph with **bold** and [link](Other.md).\n\n";
  const content = "---\ntitle: Large history\n---\n\n# Large history\n\n"
    + block.repeat(Math.floor(3.5 * 1024 * 1024 / block.length));
  const library = await collaborativeLibrary(browser, { content, participants: 1, source: true, sharing: "private" });
  const timings = {};
  const record = (name, value) => (timings[name] ??= []).push(value);
  try {
    const [page] = library.pages;
    await expect(page.locator("#document-title")).toHaveText("Large history");
    await expect(page.locator(".virtual-source-editor .cm-content")).toBeVisible();
    for (let run = 0; run < 20; run += 1) {
      await page.locator("#more-menu > summary").click();
      const result = await measureClickFrame(page, "#history-open", "#history-copy:not(:disabled)");
      record("historyDialogReadyMs", result.feedbackMs);
      for (const request of result.requests) {
        if (request.path === "/api/history") record("historyListMs", request.ms);
        if (request.path === "/api/history/content") record("historyContentMs", request.ms);
      }
      await expect(page.locator("#history-list button")).toHaveCount(1);
      await expect(page.locator("#history-diff")).toContainText("Large history");
      await page.locator("#history-close").click();
    }
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(content);
    const report = { bytes: Buffer.byteLength(content), summary: summarizeTimings(timings), timings };
    await fs.mkdir(path.join(buildRoot, "history-list-performance"), { recursive: true });
    await fs.writeFile(path.join(buildRoot, "history-list-performance", `${process.env.NOTES_BENCH_HISTORY_LIST}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ bytes: report.bytes, ...report.summary }, null, 2));
  } finally { await library.close(); }
});
