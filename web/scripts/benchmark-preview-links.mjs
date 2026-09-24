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
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-preview-links-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const runCount = 6;
await mkdir(notes);
let content = "# Link benchmark A\n\n";
for (let index = 0; Buffer.byteLength(content) < 512 * 1024; index += 1) {
  content += `[note](other.md) [heading](#section) [web](https://example.com/${index}) `
    + `[email](mailto:user${index}@example.com) [phone](tel:+1202555${String(index).padStart(4, "0")})\n\n`;
}
await writeFile(path.join(notes, "large.md"), content);
await writeFile(path.join(notes, "other.md"), "# Other\n");
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
  const editor = page.locator("#editor");
  await editor.waitFor({ state: "visible" });
  const runs = [];
  for (let index = 0; index < runCount; index += 1) {
    const marker = index % 2 ? "A" : "B";
    await editor.evaluate((element, value) => {
      element.value = element.value.replace(/^# Link benchmark [AB]/, `# Link benchmark ${value}`);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, marker);
    const result = await page.evaluate(() => new Promise((resolve) => {
      performance.clearResourceTimings();
      const status = document.querySelector("#preview-status");
      const started = performance.now();
      document.querySelector("#view-preview").click();
      const observer = new MutationObserver(() => {
        if (status.textContent !== "Up to date") return;
        observer.disconnect();
        requestAnimationFrame(() => {
          const entry = performance.getEntriesByType("resource")
            .filter((item) => item.name.includes("/api/preview"))
            .at(-1);
          const finished = performance.now();
          resolve({
            request: entry?.duration,
            client: entry ? finished - entry.responseEnd : undefined,
            total: finished - started,
          });
        });
      });
      observer.observe(status, { childList: true, characterData: true, subtree: true });
    }));
    if (![result.request, result.client, result.total].every(Number.isFinite)) {
      throw new Error("The browser did not expose complete preview timings.");
    }
    const links = await page.locator("#preview a").count();
    const external = await page.locator('#preview a[target="_blank"][rel="noopener noreferrer"]').count();
    if (!links || external * 5 !== links * 3) {
      throw new Error(`Unexpected external-link classification: ${external}/${links}.`);
    }
    runs.push(result);
    await page.locator("#view-editor").evaluate((button) => button.click());
  }
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(content),
    links: await page.locator("#preview a").count(),
    request: statistics(runs.map((run) => run.request)),
    client: statistics(runs.map((run) => run.client)),
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
