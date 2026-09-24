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
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-controls-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const runCount = 8;
await mkdir(notes);
let content = "# Large controls benchmark\n\n";
for (let index = 0; Buffer.byteLength(content) < 1024 * 1024; index += 1) {
  content += `## Heading ${index}\n\nA paragraph with words for editor analysis and status updates.\n\n`;
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
  await page.waitForFunction(() =>
    document.querySelector("#editor")?.offsetParent
      || document.querySelector(".virtual-source-editor .cm-content"));
  const runs = [];
  for (let index = 0; index < runCount; index += 1) {
    runs.push(await page.evaluate(() => new Promise((resolve) => {
      const navigation = document.querySelector("#file-nav");
      let sawBusy = false;
      const observer = new MutationObserver(() => {
        const busy = navigation.getAttribute("aria-busy") === "true";
        sawBusy ||= busy;
        if (!sawBusy || busy) return;
        observer.disconnect();
        resolve({ dispatch, total: performance.now() - started });
      });
      observer.observe(navigation, { attributes: true, attributeFilter: ["aria-busy"] });
      const started = performance.now();
      document.querySelector("#refresh-files").click();
      const dispatch = performance.now() - started;
      sawBusy = navigation.getAttribute("aria-busy") === "true";
    })));
  }
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(content),
    dispatch: statistics(runs.map((run) => run.dispatch)),
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
