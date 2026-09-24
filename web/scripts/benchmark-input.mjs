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
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-input-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
await mkdir(notes);
let content = "# Large document\n\n";
for (let index = 0; Buffer.byteLength(content) < 1024 * 1024; index += 1) {
  content += `## Heading ${index}\n\nA paragraph with several words for counting and outline work.\n\n`;
}
await writeFile(path.join(notes, "large.md"), content);
const service = spawn(executable, [
  "--serve", notes, "--port", "0", "--ready-file", ready, "--stop-file", stop,
  "--auth-mode", "token",
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let diagnostics = "";
service.stderr.on("data", (data) => { diagnostics += data; });
let browser;

const statistics = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    runsMs: values.map((value) => Number(value.toFixed(2))),
    medianMs: Number(((sorted[5] + sorted[6]) / 2).toFixed(2)),
    p95Ms: Number(sorted.at(-1).toFixed(2)),
  };
};

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
  const url = new URL(launchUrl);
  url.searchParams.set("document", await fixtureResourceId(launchUrl, "large.md"));
  await page.goto(url.href);
  await page.locator(".ProseMirror[contenteditable=true]").waitFor({ state: "visible" });
  await page.keyboard.press("Control+/");
  const native = page.locator("#editor");
  const virtual = page.locator(".virtual-source-editor .cm-content");
  await page.waitForFunction(() =>
    document.querySelector("#editor")?.offsetParent
      || document.querySelector(".virtual-source-editor .cm-content"));
  const virtualMode = await virtual.isVisible().catch(() => false);
  const editor = virtualMode ? virtual : native;
  await editor.waitFor({ state: "visible" });
  const total = [];
  const dispatch = [];
  if (virtualMode) {
    await editor.focus();
    await page.keyboard.press("Control+End");
    await page.evaluate(() => {
      const textarea = document.querySelector("#editor");
      const content = document.querySelector(".virtual-source-editor .cm-content");
      let started = 0;
      let resolve;
      window.measureSourceInput = () => new Promise((next) => { resolve = next; });
      content.addEventListener("beforeinput", () => { started = performance.now(); }, true);
      textarea.addEventListener("input", () => {
        const elapsed = performance.now() - started;
        resolve({ total: elapsed, dispatch: elapsed });
      });
    });
  }
  for (let index = 0; index < 12; index += 1) {
    let result;
    if (virtualMode) {
      const measured = page.evaluate(() => window.measureSourceInput());
      await page.keyboard.insertText(index % 2 ? "x" : "y");
      result = await measured;
    } else {
      result = await editor.evaluate((element, iteration) => {
        const totalStart = performance.now();
        element.value += iteration % 2 ? "x" : "y";
        const dispatchStart = performance.now();
        element.dispatchEvent(new Event("input", { bubbles: true }));
        return {
          total: performance.now() - totalStart,
          dispatch: performance.now() - dispatchStart,
        };
      }, index);
    }
    total.push(result.total);
    dispatch.push(result.dispatch);
    await page.waitForTimeout(100);
  }
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(content),
    mode: virtualMode ? "virtual" : "textarea",
    total: statistics(total),
    dispatch: statistics(dispatch),
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
