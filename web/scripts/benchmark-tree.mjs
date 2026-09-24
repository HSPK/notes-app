import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(webRoot, "..");
const executable = process.env.NOTES_TEST_EXE
  ?? path.join(repository, "target", "debug", process.platform === "win32" ? "notes-core.exe" : "notes-core");
const noteKib = Number(process.env.NOTES_BENCH_NOTE_KIB ?? 0);
if (!Number.isInteger(noteKib) || noteKib < 0 || noteKib > 1024) {
  throw new Error("NOTES_BENCH_NOTE_KIB must be an integer from 0 through 1024.");
}
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-tree-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const fileCount = 1000;
const runCount = 8;
const hiddenPatternCount = process.env.NOTES_BENCH_HIDDEN === "1" ? 100 : 0;
const filler = noteKib ? "performance benchmark content ".repeat(Math.ceil(noteKib * 1024 / 30)).slice(0, noteKib * 1024)
  : "performance benchmark content ".repeat(280);
const noteContent = (index, title = `Benchmark note ${index}`) =>
  `---\ntitle: ${title}\n---\n# Note ${index}\n\n${filler}\n`;
await mkdir(notes);
const folders = Array.from(
  { length: 20 },
  (_, index) => path.join(notes, `group-${String(index).padStart(2, "0")}`),
);
await Promise.all(folders.map((folder) => mkdir(folder)));
await Promise.all(Array.from({ length: fileCount }, (_, index) =>
  writeFile(
    path.join(folders[index % folders.length], `note-${String(index).padStart(4, "0")}.md`),
    noteContent(index),
  )));
const service = spawn(executable, [
  "--serve", notes, "--port", "0", "--ready-file", ready, "--stop-file", stop,
  "--auth-mode", "token",
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let diagnostics = "";
service.stderr.on("data", (data) => { diagnostics += data; });
let browser;

const statistics = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = runCount / 2;
  return {
    runsMs: values.map((value) => Number(value.toFixed(2))),
    medianMs: Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2)),
    p95Ms: Number(sorted.at(-1).toFixed(2)),
  };
};
const measurements = () => ({ request: [], render: [], total: [], retained: 0 });
const record = (runs, result) => {
  if (![result.request, result.render, result.total].every(Number.isFinite)) {
    throw new Error("The browser did not expose complete tree timings.");
  }
  runs.request.push(result.request);
  runs.render.push(result.render);
  runs.total.push(result.total);
  if (result.retained) runs.retained += 1;
};
const summarize = (runs) => ({
  request: statistics(runs.request),
  render: statistics(runs.render),
  total: statistics(runs.total),
  retainedRuns: `${runs.retained}/${runCount}`,
});

try {
  let launchUrl;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      launchUrl = JSON.parse(await readFile(ready, "utf8")).url;
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!launchUrl) throw new Error(`Notes did not start: ${diagnostics}`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  if (hiddenPatternCount) {
    const patterns = [
      ...Array.from({ length: 10 }, (_, index) => `group-${String(index).padStart(2, "0")}/**`),
      ...Array.from({ length: 90 }, (_, index) => `missing-${index}/**`),
    ].join("\n");
    await page.addInitScript((value) => {
      window.localStorage.setItem("notes.library.hiddenPatterns", value);
    }, patterns);
  }
  const firstTree = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/tree");
  await page.goto(launchUrl);
  const visibleFileCount = hiddenPatternCount ? fileCount / 2 : fileCount;
  await page.waitForFunction((count) =>
    document.querySelectorAll("button[data-path]").length === count, visibleFileCount);
  const initialTree = await (await firstTree).json();
  const coldRequestMs = await page.evaluate(() => performance.getEntriesByType("resource")
    .find((entry) => new URL(entry.name).pathname === "/api/tree")?.duration);
  const measureRefresh = () => page.evaluate(() => new Promise((resolve) => {
    performance.clearResourceTimings();
    const navigation = document.querySelector("#file-nav");
    const firstFile = document.querySelector("button[data-path]");
    const started = performance.now();
    let sawBusy = false;
    const observer = new MutationObserver(() => {
      const busy = navigation.getAttribute("aria-busy") === "true";
      sawBusy ||= busy;
      if (!sawBusy || busy) return;
      observer.disconnect();
      const entry = performance.getEntriesByType("resource")
        .filter((item) => item.name.includes("/api/tree"))
        .at(-1);
      const finished = performance.now();
      resolve({
        request: entry?.duration,
        render: entry ? finished - entry.responseEnd : undefined,
        total: finished - started,
        retained: firstFile === document.querySelector("button[data-path]"),
      });
    });
    observer.observe(navigation, { attributes: true, attributeFilter: ["aria-busy"] });
    document.querySelector("#refresh-files").click();
    sawBusy = navigation.getAttribute("aria-busy") === "true";
  }));
  const unchanged = measurements();
  const changed = measurements();
  for (let index = 0; index < runCount; index += 1) {
    record(unchanged, await measureRefresh());
    await writeFile(
      path.join(folders[0], "note-0000.md"),
      noteContent(0, `Benchmark revision ${index}`),
    );
    record(changed, await measureRefresh());
  }
  const filterDispatch = [];
  const filterTotal = [];
  const measureFilter = () => page.evaluate((count) => {
    const input = document.querySelector("#file-filter");
    const list = document.querySelector("#file-list");
    const waitFor = (predicate) => new Promise((resolve) => {
      const frame = () => predicate() ? resolve() : requestAnimationFrame(frame);
      frame();
    });
    return (async () => {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => list.querySelectorAll("button[data-path]").length === count);
      const values = ["n", "no", "not", "note", "note-", "note-0", "note-09", "note-099", "note-0999"];
      const started = performance.now();
      for (const value of values) {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const dispatch = performance.now() - started;
      await waitFor(() => {
        const buttons = list.querySelectorAll("button[data-path]");
        return buttons.length === 1 && buttons[0].dataset.path.endsWith("/note-0999.md");
      });
      return { dispatch, total: performance.now() - started };
    })();
  }, visibleFileCount);
  await measureFilter();
  for (let index = 0; index < runCount; index += 1) {
    const result = await measureFilter();
    filterDispatch.push(result.dispatch);
    filterTotal.push(result.total);
  }
  console.log(JSON.stringify({
    files: fileCount,
    noteKib,
    coldRequestMs,
    metadataTitles: initialTree.files.filter((file) => typeof file.title === "string").length,
    hiddenPatterns: hiddenPatternCount,
    visibleFiles: visibleFileCount,
    approximateMiB: Number((fileCount * Buffer.byteLength(filler) / 1_048_576).toFixed(2)),
    unchanged: summarize(unchanged),
    changed: summarize(changed),
    filterBurst: {
      events: 9,
      dispatch: statistics(filterDispatch),
      total: statistics(filterTotal),
    },
  }, null, 2));
} finally {
  await browser?.close();
  if (service.exitCode === null) {
    await writeFile(stop, "");
    for (let attempt = 0; attempt < 100 && service.exitCode === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (service.exitCode === null) service.kill();
  }
  await rm(temporary, { recursive: true, force: true });
}
