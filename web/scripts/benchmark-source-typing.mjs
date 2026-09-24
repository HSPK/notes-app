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
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-source-typing-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const runCount = 8;
await mkdir(notes);
let content = "# Source typing benchmark\n\n";
for (let index = 0; Buffer.byteLength(content) < 1024 * 1024; index += 1) {
  content += `Line ${index} with enough Markdown text to exercise large-document layout.\n`;
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
    medianMs: Number(((sorted[3] + sorted[4]) / 2).toFixed(2)),
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
  const activationStarted = await page.evaluate(() => performance.now());
  await page.keyboard.press("Control+/");
  const native = page.locator("#editor");
  const virtual = page.locator(".virtual-source-editor .cm-content");
  await page.waitForFunction(() =>
    document.querySelector("#editor")?.offsetParent
      || document.querySelector(".virtual-source-editor .cm-content"));
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const activation = await page.evaluate((started) => performance.now() - started, activationStarted);
  const target = await virtual.isVisible().catch(() => false) ? virtual : native;
  await target.focus();
  await page.keyboard.press("Control+End");
  await page.evaluate(() => {
    const textarea = document.querySelector("#editor");
    const inputTarget = document.querySelector(".virtual-source-editor .cm-content") ?? textarea;
    let started = 0;
    let resolve;
    window.measureSourceInput = () => new Promise((next) => { resolve = next; });
    inputTarget.addEventListener("beforeinput", () => { started = performance.now(); }, true);
    textarea.addEventListener("input", () => {
      const dispatch = performance.now() - started;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve({ dispatch, total: performance.now() - started });
      }));
    });
  });
  const runs = [];
  for (let index = 0; index < runCount; index += 1) {
    const result = page.evaluate(() => window.measureSourceInput());
    await page.keyboard.insertText(index % 2 ? "x" : "y");
    runs.push(await result);
  }
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(content),
    mode: await virtual.isVisible().catch(() => false) ? "virtual" : "textarea",
    activationMs: Number(activation.toFixed(2)),
    dispatch: statistics(runs.map((run) => run.dispatch)),
    interactive: statistics(runs.map((run) => run.total)),
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
