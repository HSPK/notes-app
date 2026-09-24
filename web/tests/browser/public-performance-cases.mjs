import { test, expect, fs, path, buildRoot, userResourceId } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";
import { summarizeTimings } from "./performance-helpers.mjs";

test("public document benchmark separates session validation, retrieval and rendered readiness", async ({ browser }) => {
  test.skip(!process.env.NOTES_BENCH_PUBLIC, "Opt-in public-document startup measurement.");
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, sharing: "private" });
  const guest = await browser.newContext();
  const timings = {};
  const record = (name, value) => (timings[name] ??= []).push(value);
  try {
    await guest.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const root = document.getElementById("rich-editor");
        if (!root) return;
        const observer = new MutationObserver(() => {
          if (root.getAttribute("aria-busy") === "true"
              || root.querySelector(".ProseMirror")?.getAttribute("contenteditable") !== "false"
              || !document.getElementById("document-title")?.textContent.startsWith("Published ")) return;
          observer.disconnect();
          requestAnimationFrame(() => setTimeout(() => { window.publicBenchReady = performance.now(); }, 0));
        });
        observer.observe(root, { attributes: true, childList: true, subtree: true });
      });
    });
    const [owner] = library.pages;
    const paragraph = "## Reference\n\nA paragraph with **formatted text**, [a related note](Other.md), and `inline code`.\n\n";
    const canonical = process.env.NOTES_BENCH_CANONICAL === "1";
    const body = canonical ? paragraph.repeat(2700).trimEnd() + "\n" : paragraph.repeat(2700);
    const links = [];
    const runs = process.env.NOTES_BENCH_PROFILE ? 1 : 12;
    for (let index = 0; index < runs; index += 1) {
      const name = `Public${index}.md`;
      await fs.writeFile(path.join(library.notes, name), `---\ntitle: Published ${index}\n---\n\n# Published ${index}\n\n${body}`);
      const document = await userResourceId(owner.context(), library.url, name);
      const shared = await owner.request.post(new URL("/api/projects", library.url).href, {
        data: { action: "document", id: "default", document, permission: "publicRead" },
      });
      expect(shared.ok()).toBe(true);
      const token = (await shared.json()).publicLinks[name].token;
      links.push(new URL(`/share?share=${token}`, library.url).href);
    }
    const page = await guest.newPage();
    const profiler = process.env.NOTES_BENCH_PROFILE ? await guest.newCDPSession(page) : null;
    if (profiler) { await profiler.send("Profiler.enable"); await profiler.send("Profiler.start"); }
    let joins = 0;
    let sockets = 0;
    page.on("request", (request) => { if (request.url().includes("/collaboration/join")) joins += 1; });
    page.on("websocket", () => { sockets += 1; });
    for (let index = 0; index < links.length; index += 1) {
      for (const mode of ["cold", "warm"]) {
        await page.goto(links[index]);
        await page.waitForFunction(() => typeof window.publicBenchReady === "number");
        const result = await page.evaluate(() => ({
            readyMs: window.publicBenchReady,
            title: document.getElementById("document-title").textContent,
            resources: performance.getEntriesByType("resource")
              .filter((entry) => entry.name.includes("/api/public/session") || entry.name.includes("/api/public/document?"))
              .map((entry) => ({ name: new URL(entry.name).pathname, ms: entry.duration })),
        }));
        expect(result.title).toBe(`Published ${index}`);
        record(`${mode}PageReadyMs`, result.readyMs);
        expect(result.resources).toHaveLength(2);
        for (const resource of result.resources) {
          record(`${mode}${resource.name.endsWith("/session") ? "Session" : "Document"}Ms`, resource.ms);
        }
      }
    }
    expect(joins).toBe(0);
    expect(sockets).toBe(0);
    const summary = summarizeTimings(timings);
    const report = { bytesPerBody: Buffer.byteLength(body), canonical, joins, sockets, summary, timings };
    await fs.mkdir(path.join(buildRoot, "public-performance"), { recursive: true });
    if (profiler) {
      const { profile } = await profiler.send("Profiler.stop");
      await fs.writeFile(path.join(buildRoot, "public-performance", `${process.env.NOTES_BENCH_PUBLIC}.cpuprofile`), JSON.stringify(profile));
      await profiler.detach();
    }
    await fs.writeFile(path.join(buildRoot, "public-performance", `${process.env.NOTES_BENCH_PUBLIC}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ bytesPerBody: report.bytesPerBody, canonical, joins, sockets, ...summary }, null, 2));
  } finally { await guest.close(); await library.close(); }
});
