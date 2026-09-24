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
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-asset-benchmark-"));
const notes = path.join(temporary, "notes");
const images = path.join(notes, "images");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
await mkdir(images, { recursive: true });
const png = (size) => {
  const bytes = Buffer.alloc(size, 0x5a);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  return bytes;
};
await writeFile(path.join(images, "small.png"), png(4 * 1024));
await writeFile(path.join(images, "large.png"), png(8 * 1024 * 1024));
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
    runsMs: values.map((value) => Number(value.toFixed(2))),
    medianMs: Number(median.toFixed(2)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)),
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
  await page.goto(launchUrl);
  await page.waitForFunction(() =>
    document.querySelector("#connection-label")?.dataset.state === "ready");
  const measure = async (assetPath, runCount) => page.evaluate(async ({ id, runCount }) => {
    const url = new URL("/assets", window.location.href);
    url.searchParams.set("id", id);
    const request = async () => {
      performance.clearResourceTimings();
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
      await response.arrayBuffer();
      const entry = performance.getEntriesByName(url.href).at(-1);
      if (!entry) throw new Error("The browser did not expose asset resource timing.");
      return {
        ttfb: entry.responseStart - entry.startTime,
        download: entry.responseEnd - entry.responseStart,
        total: entry.duration,
      };
    };
    await request();
    await request();
    const results = [];
    for (let index = 0; index < runCount; index += 1) results.push(await request());
    return results;
  }, { id: await fixtureResourceId(launchUrl, assetPath, "asset"), runCount });
  const summarize = (results) => ({
    ttfb: statistics(results.map((result) => result.ttfb)),
    download: statistics(results.map((result) => result.download)),
    total: statistics(results.map((result) => result.total)),
  });
  console.log(JSON.stringify({
    small: { bytes: 4 * 1024, ...summarize(await measure("images/small.png", 20)) },
    large: { bytes: 8 * 1024 * 1024, ...summarize(await measure("images/large.png", 8)) },
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
