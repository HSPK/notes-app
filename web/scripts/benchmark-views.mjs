import { chromium } from "@playwright/test";
import { fixtureResourceId } from "./resource-fixture.mjs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(webRoot, "..");
const executable = process.env.NOTES_TEST_EXE
  ?? path.join(repository, "target", "debug", process.platform === "win32" ? "notes-core.exe" : "notes-core");
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-view-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
await mkdir(notes);
let content = "# Large document\n\n";
for (let index = 0; Buffer.byteLength(content) < 512 * 1024; index += 1) {
  content += `## Heading ${index}\n\nParagraph with **formatted text** and $x_${index}+y_${index}$.\n\n`;
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
    medianMs: Number(((sorted[2] + sorted[3]) / 2).toFixed(2)),
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
  page.setDefaultTimeout(120_000);
  const url = new URL(launchUrl);
  url.searchParams.set("document", await fixtureResourceId(launchUrl, "large.md"));
  await page.goto(url.href);
  await page.locator(".ProseMirror[contenteditable=true]").waitFor({ state: "visible" });
  const sourceToLive = [];
  const liveToSource = [];
  for (let index = 0; index < 6; index += 1) {
    let started = await page.evaluate(() => performance.now());
    await page.keyboard.press("Control+/");
    await page.locator("#editor").waitFor({ state: "visible" });
    liveToSource.push(await page.evaluate((time) => performance.now() - time, started));
    started = await page.evaluate(() => performance.now());
    await page.keyboard.press("Control+/");
    await page.locator(".ProseMirror[contenteditable=true]").waitFor({ state: "visible" });
    sourceToLive.push(await page.evaluate((time) => performance.now() - time, started));
  }
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(content),
    sourceToLive: statistics(sourceToLive),
    liveToSource: statistics(liveToSource),
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
