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
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-preview-jump-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const headingCount = 4096;
const runCount = 16;
await mkdir(notes);
const content = Array.from(
  { length: headingCount },
  (_, index) => `## Heading ${index}\n\nPreview heading benchmark text.\n\n`,
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
  return {
    runsMs: values.map((value) => Number(value.toFixed(3))),
    medianMs: Number(((sorted[7] + sorted[8]) / 2).toFixed(3)),
    p95Ms: Number(sorted.at(-1).toFixed(3)),
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
  await page.emulateMedia({ reducedMotion: "reduce" });
  const url = new URL(launchUrl);
  url.searchParams.set("document", await fixtureResourceId(launchUrl, "large.md"));
  await page.goto(url.href);
  await page.locator(".ProseMirror[contenteditable=true]").waitFor({ state: "visible" });
  await page.locator("#view-preview").evaluate((button) => button.click());
  await page.locator("#preview h2").last().waitFor({ state: "visible" });
  await page.locator("#outline-tab").click();
  await page.waitForFunction((count) =>
    document.querySelectorAll("#outline-list button[data-heading]").length === count,
  headingCount);
  const runs = [];
  for (let index = 0; index < runCount; index += 1) {
    const result = await page.evaluate(() => {
      const preview = document.querySelector("#preview");
      const button = document.querySelector("#outline-list li:last-child button");
      preview.scrollTop = 0;
      const started = performance.now();
      button.click();
      return {
        duration: performance.now() - started,
        scrollTop: preview.scrollTop,
        maximum: preview.scrollHeight - preview.clientHeight,
      };
    });
    if (result.scrollTop < result.maximum * 0.9) {
      throw new Error("The preview jump did not reach the final heading.");
    }
    runs.push(result.duration);
  }
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(content),
    headings: headingCount,
    dispatch: statistics(runs),
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
