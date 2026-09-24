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
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-outline-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const headingCount = 4096;
const runCount = 16;
const filler = "Outline navigation benchmark content. ".repeat(24);
await mkdir(notes);
const content = Array.from(
  { length: headingCount },
  (_, index) => `## Heading ${index}\n\n${filler}\n\n`,
).join("");
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
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    runsMs: values.map((value) => Number(value.toFixed(3))),
    medianMs: Number(median.toFixed(3)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3)),
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
  await page.keyboard.press("Control+/");
  const native = page.locator("#editor");
  const virtual = page.locator(".virtual-source-editor .cm-content");
  const virtualMode = await virtual.isVisible().catch(() => false);
  const editor = virtualMode ? virtual : native;
  await editor.waitFor({ state: "visible" });
  await page.locator("#outline-tab").click();
  await page.waitForFunction((count) =>
    document.querySelectorAll("#outline-list button[data-heading]").length === count,
  headingCount);
  const runs = [];
  for (let index = 0; index < runCount; index += 1) {
    const result = await page.evaluate(() => {
      const editor = document.querySelector("#editor");
      const scroller = document.querySelector(".virtual-source-editor .cm-scroller") ?? editor;
      const button = document.querySelector("#outline-list li:last-child button");
      scroller.scrollTop = 0;
      if (editor.offsetParent) editor.setSelectionRange(0, 0);
      const started = performance.now();
      button.click();
      return {
        duration: performance.now() - started,
        selection: editor.offsetParent ? editor.selectionStart : null,
        scrollTop: scroller.scrollTop,
      };
    });
    if ((!virtualMode && result.selection < content.length * 0.99) || result.scrollTop <= 0) {
      throw new Error(`The outline jump did not reach the final heading: ${JSON.stringify({
        virtualMode, ...result,
      })}`);
    }
    runs.push(result.duration);
  }
  const rebuildRuns = [];
  for (let index = 0; index < 8; index += 1) {
    await editor.focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+ArrowLeft");
    const measured = page.evaluate((marker) => new Promise((resolve) => {
      const outline = document.querySelector("#outline-list");
      const expected = `Heading ${marker}`;
      const observer = new MutationObserver(() => {
        if (outline.querySelector("button")?.textContent !== expected) return;
        observer.disconnect();
        resolve(performance.now() - started);
      });
      observer.observe(outline, { childList: true, subtree: true, characterData: true });
      const started = performance.now();
      window.outlineBenchmarkStarted = started;
    }), index % 2 ? "A" : "B");
    await page.keyboard.insertText(index % 2 ? "A" : "B");
    rebuildRuns.push(await measured);
  }
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(content),
    headings: headingCount,
    dispatch: statistics(runs),
    rebuild: statistics(rebuildRuns),
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
