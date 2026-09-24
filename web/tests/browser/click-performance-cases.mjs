import { test, expect, fs, path, buildRoot, userResourceId } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";
import { addPermissionOverrides, measureClickFrame, summarizeTimings } from "./performance-helpers.mjs";

test("click latency benchmark separates UI feedback from document and workspace requests", async ({ browser }) => {
  test.skip(!process.env.NOTES_BENCH_CLICKS, "Opt-in performance measurement with isolated notes.");
  const library = await collaborativeLibrary(browser, { source: true });
  const timings = {};
  const record = (name, value) => (timings[name] ??= []).push(value);
  try {
    const [page] = library.pages;
    const aclEntries = Number(process.env.NOTES_BENCH_ACL ?? 0);
    await addPermissionOverrides(library, aclEntries);
    let joins = 0;
    let sockets = 0;
    page.on("request", (request) => { if (request.url().includes("/collaboration/join")) joins += 1; });
    page.on("websocket", () => { sockets += 1; });
    const profiler = process.env.NOTES_BENCH_PROFILE ? await page.context().newCDPSession(page) : null;
    if (profiler) { await profiler.send("Profiler.enable"); await profiler.send("Profiler.start"); }
    const paragraph = "## Measurement\n\nA paragraph with **formatted text**, [a local link](Other.md), and `inline code`.\n\n";
    const content = paragraph.repeat(2700);
    for (let index = 0; index < 20; index += 1) {
      await fs.writeFile(path.join(library.notes, `Bench${index}.md`), `---\ntitle: Bench ${index}\n---\n\n${content}`);
    }
    await page.locator("#refresh-files").click();
    await expect(page.locator('[data-path="Bench19.md"]')).toBeAttached();
    const clickFrame = (selector, readySelector) => measureClickFrame(page, selector, readySelector);
    for (let index = 0; index < 20; index += 1) {
      const id = await userResourceId(page.context(), library.url, `Bench${index}.md`);
      // Favorites can point to unopened files, so this also measures cold Rust metadata reads.
      const cold = await page.evaluate(async (id) => {
        const started = performance.now();
        const response = await fetch("/api/workspace", {
          method: "POST", headers: { "Content-Type": "application/json", "X-Notes-Project": "default" },
          body: JSON.stringify({ action: "favorite", project: "default", id, value: true }),
        });
        if (!response.ok) throw new Error(await response.text());
        await response.json();
        return performance.now() - started;
      }, id);
      record("coldFavoriteRequestMs", cold);
      const result = await clickFrame(`[data-path="Bench${index}.md"]`, `[data-path="Bench${index}.md"][aria-current="page"]`);
      record("documentClickFrameMs", result.feedbackMs);
      for (const request of result.requests) record(`${request.path}Ms`, request.ms);
      await expect(page.locator("#editor")).toBeEnabled();
      await page.locator("#more-menu > summary").click();
      const workspace = await clickFrame("#workspace-open", "#workspace-dialog[open]");
      record("workspaceClickFrameMs", workspace.feedbackMs);
      await page.locator("#workspace-close").click();
      const settings = await clickFrame("#settings-open", "#settings-dialog[open]");
      record("settingsClickFrameMs", settings.feedbackMs);
      await page.locator("#settings-cancel").click();
    }
    const summary = summarizeTimings(timings);
    expect(joins).toBe(0);
    expect(sockets).toBe(0);
    const report = { bytesPerNote: Buffer.byteLength(content), aclEntries, joins, sockets, summary, timings };
    await fs.mkdir(path.join(buildRoot, "click-performance"), { recursive: true });
    if (profiler) {
      const { profile } = await profiler.send("Profiler.stop");
      await fs.writeFile(path.join(buildRoot, "click-performance", `${process.env.NOTES_BENCH_CLICKS}.cpuprofile`), JSON.stringify(profile));
      await profiler.detach();
    }
    await fs.writeFile(path.join(buildRoot, "click-performance", `${process.env.NOTES_BENCH_CLICKS}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ bytesPerNote: report.bytesPerNote, aclEntries, joins, sockets, ...summary }, null, 2));
  } finally { await library.close(); }
});
