import { chromium } from "@playwright/test";
import { fixtureResourceId } from "./resource-fixture.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(webRoot, "..");
const executable = process.env.NOTES_TEST_EXE
  ?? path.join(repository, "target", "debug", process.platform === "win32" ? "notes-core.exe" : "notes-core");
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-navigation-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const fileCount = Number.parseInt(process.env.NOTES_BENCH_FILES ?? "1000", 10);
if (!Number.isInteger(fileCount) || fileCount < 2 || fileCount > 10_000) {
  throw new Error("NOTES_BENCH_FILES must be an integer from 2 through 10000.");
}
const runCount = 16;
await mkdir(notes);
const folders = Array.from(
  { length: 20 },
  (_, index) => path.join(notes, `group-${String(index).padStart(2, "0")}`),
);
await Promise.all(folders.map((folder) => mkdir(folder)));
await Promise.all(Array.from({ length: fileCount }, (_, index) =>
  writeFile(
    path.join(folders[index % folders.length], `note-${String(index).padStart(4, "0")}.md`),
    `# Note ${index}\n\nSmall cached document ${index}.\n`,
  )));
const service = spawn(executable, [
  "--serve", notes, "--port", "0", "--ready-file", ready, "--stop-file", stop,
  "--auth-mode", "token",
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let diagnostics = "";
service.stderr.on("data", (data) => { diagnostics += data; });
let browser;

function statistics(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    runsMs: values.map((value) => Number(value.toFixed(2))),
    medianMs: Number(((sorted[7] + sorted[8]) / 2).toFixed(2)),
    p95Ms: Number(sorted.at(-1).toFixed(2)),
  };
}

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
  const first = "group-00/note-0000.md";
  const second = "group-01/note-0001.md";
  const url = new URL(launchUrl);
  url.searchParams.set("document", await fixtureResourceId(launchUrl, first));
  await page.goto(url.href);
  await page.waitForFunction((count) =>
    document.querySelectorAll("button[data-path]").length === count, fileCount);
  await page.keyboard.press("Control+/");
  await page.locator("#editor").waitFor({ state: "visible" });
  const navigate = (target) => page.evaluate((path) => new Promise((resolve) => {
    performance.clearResourceTimings();
    const button = document.querySelector(`button[data-path="${CSS.escape(path)}"]`);
    const started = performance.now();
    const observer = new MutationObserver(() => {
      if (button.getAttribute("aria-current") !== "page") return;
      observer.disconnect();
      const request = performance.getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/api/document"))
        .at(-1)?.duration;
      resolve({ request, total: performance.now() - started });
    });
    observer.observe(button, { attributes: true, attributeFilter: ["aria-current"] });
    button.click();
  }), target);
  await navigate(second);
  await navigate(first);
  const request = [];
  const total = [];
  for (let index = 0; index < runCount; index += 1) {
    const result = await navigate(index % 2 ? first : second);
    if (![result.request, result.total].every(Number.isFinite)) {
      throw new Error("The browser did not expose complete navigation timings.");
    }
    request.push(result.request);
    total.push(result.total);
  }
  console.log(JSON.stringify({
    files: fileCount,
    request: statistics(request),
    total: statistics(total),
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
