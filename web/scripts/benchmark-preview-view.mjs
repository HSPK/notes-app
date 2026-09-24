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
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-preview-view-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const runCount = 6;
await mkdir(notes);
let content = "# Preview view benchmark\n\n";
for (let index = 0; Buffer.byteLength(content) < 512 * 1024; index += 1) {
  content += `## Heading ${index}\n\nParagraph with **bold text**, [link](note.md), and \`code_${index}\`.\n\n`;
}
await writeFile(path.join(notes, "large.md"), content);
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
    medianMs: Number(((sorted[2] + sorted[3]) / 2).toFixed(2)),
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
  page.setDefaultTimeout(120_000);
  const url = new URL(launchUrl);
  url.searchParams.set("document", await fixtureResourceId(launchUrl, "large.md"));
  await page.goto(url.href);
  await page.locator(".ProseMirror[contenteditable=true]").waitFor({ state: "visible" });
  await page.locator("#view-editor").evaluate((button) => button.click());
  await page.locator("#editor").waitFor({ state: "visible" });
  const runs = [];
  for (let index = 0; index < runCount; index += 1) {
    const result = await page.evaluate(() => new Promise((resolve) => {
      performance.clearResourceTimings();
      const panes = document.querySelector("#document-panes");
      const status = document.querySelector("#preview-status");
      const started = performance.now();
      document.querySelector("#view-preview").click();
      const wait = () => {
        if (panes.dataset.view !== "preview" || status.textContent !== "Up to date") {
          requestAnimationFrame(wait);
          return;
        }
        requestAnimationFrame(() => {
          const entries = performance.getEntriesByType("resource")
            .filter((entry) => entry.name.includes("/api/preview"));
          resolve({
            total: performance.now() - started,
            requests: entries.length,
            request: entries.at(-1)?.duration ?? 0,
          });
        });
      };
      requestAnimationFrame(wait);
    }));
    runs.push(result);
    await page.locator("#view-editor").evaluate((button) => button.click());
    await page.locator("#editor").waitFor({ state: "visible" });
  }
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(content),
    requestRuns: runs.reduce((total, run) => total + run.requests, 0),
    request: statistics(runs.map((run) => run.request)),
    total: statistics(runs.map((run) => run.total)),
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
