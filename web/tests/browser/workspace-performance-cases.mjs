import { test, expect, fs, path, buildRoot, delay, userResourceId } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";
import { addPermissionOverrides, measureClickFrame, summarizeTimings } from "./performance-helpers.mjs";
import { createHash } from "node:crypto";

test("workspace write benchmark distinguishes unchanged actions from real recent-note changes", async ({ browser }) => {
  test.skip(!process.env.NOTES_BENCH_WORKSPACE_WRITES, "Opt-in workspace write measurement.");
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, sharing: "private" });
  const timings = {};
  const changes = {};
  try {
    const [page] = library.pages;
    const sharedId = await userResourceId(page.context(), library.url, "Shared.md");
    const otherId = await userResourceId(page.context(), library.url, "Other.md");
    const post = async (action) => {
      const start = performance.now();
      const response = await page.request.post(new URL("/api/workspace", library.url).href, {
        data: { project: "default", id: sharedId, ...action },
      });
      expect(response.ok()).toBe(true);
      return { result: await response.json(), elapsed: performance.now() - start };
    };
    let previous = (await post({ action: "visit" })).result;
    for (const kind of ["repeatVisit", "repeatFavorite", "changedVisit"]) {
      if (kind === "repeatFavorite") previous = (await post({ action: "favorite", value: true })).result;
      timings[kind] = [];
      changes[kind] = { revisions: 0, states: 0 };
      for (let index = 0; index < 80; index += 1) {
        const action = kind === "repeatFavorite" ? { action: "favorite", value: true }
          : { action: "visit", id: kind === "changedVisit" && index % 2 === 0 ? otherId : sharedId };
        const { result, elapsed } = await post(action);
        timings[kind].push(elapsed);
        changes[kind].revisions += Number(result.revision !== previous.revision);
        changes[kind].states += Number(JSON.stringify(result.workspace) !== JSON.stringify(previous.workspace));
        previous = result;
      }
    }
    expect(changes.repeatVisit.states).toBe(0);
    expect(changes.repeatFavorite.states).toBe(0);
    expect(changes.changedVisit.states).toBe(80);
    const report = { summary: summarizeTimings(timings), changes, timings };
    await fs.mkdir(path.join(buildRoot, "workspace-write-performance"), { recursive: true });
    await fs.writeFile(path.join(buildRoot, "workspace-write-performance", `${process.env.NOTES_BENCH_WORKSPACE_WRITES}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ summary: report.summary, changes }, null, 2));
  } finally { await library.close(); }
});

test("workspace interaction benchmark measures project navigation and search result latency", async ({ browser }) => {
  test.skip(!process.env.NOTES_BENCH_WORKSPACE, "Opt-in workspace performance measurement.");
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, sharing: "private" });
  const timings = {};
  const record = (name, value) => (timings[name] ??= []).push(value);
  const publicReads = process.env.NOTES_BENCH_PUBLIC_READS === "1";
  const historyReads = process.env.NOTES_BENCH_HISTORY_READS === "1";
  let guest = null;
  try {
    const [page] = library.pages;
    const document = await userResourceId(page.context(), library.url, "Shared.md");
    const body = "A paragraph about design, performance, documentation and shared editing.\n\n".repeat(460);
    for (let index = 0; index < 512; index += 1) {
      await fs.writeFile(path.join(library.notes, `Bench${String(index).padStart(4, "0")}.md`),
        `---\ntitle: Research note ${index}\ntags: [research, group-${index % 8}]\n---\n\n# Research note ${index}\n\n${body}\nUniqueNeedle${index}\n`);
    }
    const created = await page.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "create", name: "Secondary project", kind: "new" },
    });
    expect(created.ok()).toBe(true);
    const secondary = (await created.json()).id;
    const note = await page.request.post(new URL("/api/document", library.url).href, {
      headers: { "X-Notes-Project": secondary },
      data: { path: "Scratch.md", content: "# Scratch\n" },
    });
    expect(note.ok()).toBe(true);
    const aclEntries = Number(process.env.NOTES_BENCH_ACL ?? 0);
    await addPermissionOverrides(library, aclEntries);
    let publicToken = null;
    if (publicReads) {
      const shared = await page.request.post(new URL("/api/projects", library.url).href, {
        data: { action: "document", id: "default", document, permission: "publicRead",
          publicOptions: { password: "protected performance fixture password" } },
      });
      expect(shared.ok()).toBe(true);
      publicToken = (await shared.json()).publicLinks["Shared.md"].token;
      guest = await browser.newContext();
      const session = await guest.request.post(new URL("/api/public/session", library.url).href, {
        headers: { "X-Notes-Share": publicToken },
        data: { password: "protected performance fixture password" },
      });
      expect(session.ok()).toBe(true);
    }
    let historyId = null;
    if (historyReads) {
      const original = await (await page.request.get(new URL(`/api/document?id=${document}`, library.url).href)).json();
      const content = "# Archived content\n\n```text\n"
        + Array.from({ length: 16_384 }, (_, index) => createHash("sha256").update(String(index)).digest("hex")).join("\n")
        + "\n```\n";
      const archived = await page.request.put(new URL("/api/document", library.url).href, {
        data: { id: document, version: original.version, content },
      });
      expect(archived.ok()).toBe(true);
      const version = (await archived.json()).version;
      const restored = await page.request.put(new URL("/api/document", library.url).href, {
        data: { id: document, version, content: original.content },
      });
      expect(restored.ok()).toBe(true);
      const history = await (await page.request.get(new URL(`/api/history?document=${document}`, library.url).href)).json();
      historyId = history.revisions.find((revision) => revision.version === version)?.id;
      expect(Number.isSafeInteger(historyId)).toBe(true);
    }
    await page.locator("#refresh-files").click();
    await expect(page.locator('[data-path="Bench0511.md"]')).toBeAttached();
    const search = async () => {
      await page.locator("#more-menu > summary").click();
      const result = await measureClickFrame(page, "#workspace-search-open", "#search-results button", "#search-results");
      for (const request of result.requests) {
        if (request.path === "/api/search") record("searchRequestMs", request.ms);
      }
      await expect.poll(() => page.locator("#search-message").textContent(), { timeout: 60_000 })
        .not.toMatch(/Searching|Indexing/);
      return result.feedbackMs;
    };
    let probing = true;
    let probeFailure;
    const probes = [];
    if (publicReads) probes.push({ request: guest.request, path: `/api/public/document?id=${document}`,
      headers: { "X-Notes-Share": publicToken }, metric: "indexingProtectedPublicReadMs" });
    if (historyReads) probes.push({ request: page.request, path: `/api/history/content?document=${document}&revision=${historyId}`,
      metric: "indexingHistoryContentMs" });
    if (!probes.length) probes.push({ request: page.request, path: "/api/workspace", metric: "indexingWorkspaceRequestMs" });
    const probe = (async () => {
      while (probing) {
        await Promise.all(probes.map(async (probe) => {
          const started = performance.now();
          const response = await probe.request.get(new URL(probe.path, library.url).href, { headers: probe.headers });
          expect(response.ok()).toBe(true);
          await response.body();
          record(probe.metric, performance.now() - started);
        }));
        await delay(50);
      }
    })().catch((error) => { probeFailure = error; });
    try {
      const coldStart = performance.now();
      record("coldSearchFirstResultsMs", await search());
      record("coldSearchCompleteMs", performance.now() - coldStart);
    } finally {
      probing = false;
      await probe;
      if (probeFailure) throw probeFailure;
    }
    await expect(page.locator("#search-results button")).toHaveCount(100);
    await expect(page.locator("#search-tags")).toContainText("research · 512");
    await page.locator("#search-close").click();
    for (let run = 0; run < 20; run += 1) {
      record("warmSearchFirstResultsMs", await search());
      await expect(page.locator("#search-tags")).toContainText("research · 512");
      await page.locator("#search-close").click();
      const popup = await measureClickFrame(page, "#projects-open", "#projects-dialog[open]");
      record("projectsPopupFrameMs", popup.feedbackMs);
      await expect(page.locator(`[data-project="${secondary}"]`)).toBeVisible();
      const outward = await measureClickFrame(page, `[data-project="${secondary}"]`, '[data-path="Scratch.md"]', "#file-list");
      record("smallProjectTreeReadyMs", outward.feedbackMs);
      await page.locator("#projects-open").click();
      const inward = await measureClickFrame(page, '[data-project="default"]', '[data-path="Bench0000.md"]', "#file-list");
      record("largeProjectTreeReadyMs", inward.feedbackMs);
    }
    const summary = summarizeTimings(timings);
    const report = { files: 512, aclEntries, publicReads, historyReads, bodyBytes: Buffer.byteLength(body), summary, timings };
    await fs.mkdir(path.join(buildRoot, "workspace-performance"), { recursive: true });
    await fs.writeFile(path.join(buildRoot, "workspace-performance", `${process.env.NOTES_BENCH_WORKSPACE}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ files: report.files, aclEntries, publicReads, historyReads, bodyBytes: report.bodyBytes, ...summary }, null, 2));
  } finally { await guest?.close(); await library.close(); }
});
