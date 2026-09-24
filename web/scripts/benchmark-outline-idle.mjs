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
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-outline-idle-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const runCount = 8;
await mkdir(notes);
let content = "# Outline idle benchmark\n\n";
for (let index = 0; Buffer.byteLength(content) < 1024 * 1024; index += 1) {
  content += `## Heading ${index}\n\nA paragraph with several words for deferred analysis.\n\n`;
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
  await page.keyboard.press("Control+/");
  const native = page.locator("#editor");
  const virtual = page.locator(".virtual-source-editor .cm-content");
  const editor = await virtual.isVisible().catch(() => false) ? virtual : native;
  await editor.waitFor({ state: "visible" });
  const wrapOff = process.env.NOTES_BENCH_WRAP_OFF === "1";
  if (wrapOff && await native.isVisible()) {
    await native.evaluate((element) => element.setAttribute("wrap", "off"));
  }
  const background = [];
  const reveal = [];
  for (let index = 0; index < runCount; index += 1) {
    await editor.focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("End");
    if (index === 0) await page.keyboard.insertText(" ");
    else await page.keyboard.press("Shift+ArrowLeft");
    const delay = page.evaluate(() => new Promise((resolve) => {
      const expected = performance.now() + 220;
      setTimeout(() => resolve(performance.now() - expected), 220);
    }));
    await page.keyboard.insertText(index % 2 ? "A" : "B");
    background.push(await delay);
    reveal.push(await page.evaluate(() => {
      const started = performance.now();
      document.querySelector("#outline-tab").click();
      const duration = performance.now() - started;
      document.querySelector("#files-tab").click();
      return duration;
    }));
  }
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(content),
    wrapOff,
    backgroundDelay: statistics(background),
    reveal: statistics(reveal),
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
