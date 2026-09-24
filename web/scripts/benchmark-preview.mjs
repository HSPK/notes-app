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
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-preview-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const runCount = 8;
await mkdir(notes);
await writeFile(path.join(notes, "note.md"), "# Note\n");
await writeFile(path.join(notes, "large.md"), "");
let content = "# Large preview\n\n";
for (let index = 0; Buffer.byteLength(content) < 1024 * 1024; index += 1) {
  content += `## Heading ${index}\n\n`
    + `Paragraph with **bold text**, [link](note.md), and inline code \`value_${index}\`.\n\n`;
}
const service = spawn(executable, [
  "--serve", notes, "--port", "0", "--ready-file", ready, "--stop-file", stop,
  "--auth-mode", "token",
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let diagnostics = "";
service.stderr.on("data", (data) => { diagnostics += data; });
let browser;

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
  const id = await fixtureResourceId(launchUrl, "large.md");
  const measure = (changed) => page.evaluate(async ({ content, runCount, changed, id }) => {
    const token = window.sessionStorage.getItem("notes.connection.token");
    if (!token) throw new Error("The launch token was not retained.");
    const url = new URL("/api/preview", window.location.href).href;
    const request = async (source) => {
      performance.clearResourceTimings();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id, content: source }),
      });
      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
      await response.text();
      return performance.getEntriesByName(url).at(-1)?.duration;
    };
    await request(changed ? `${content}\nWarmup 1` : content);
    await request(changed ? `${content}\nWarmup 2` : content);
    const durations = [];
    for (let index = 0; index < runCount; index += 1) {
      durations.push(await request(changed ? `${content}\nRevision ${index}` : content));
    }
    return durations;
  }, { content, runCount, changed, id });
  const summarize = (runs) => {
    if (runs.some((duration) => !Number.isFinite(duration))) {
      throw new Error("The browser did not expose preview resource timings.");
    }
    const sorted = [...runs].sort((left, right) => left - right);
    const middle = runCount / 2;
    return {
      runsMs: runs.map((value) => Number(value.toFixed(2))),
      medianMs: Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2)),
      p95Ms: Number(sorted.at(-1).toFixed(2)),
    };
  };
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(content),
    unchanged: summarize(await measure(false)),
    changed: summarize(await measure(true)),
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
