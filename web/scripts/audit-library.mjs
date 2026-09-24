import { chromium } from "@playwright/test";
import { fixtureResourceId } from "./resource-fixture.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(webRoot, "..");
const root = path.resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("Usage: npm run audit:library -- <notes-folder>");
}
const executable = process.env.NOTES_TEST_EXE
  ?? path.join(repository, "target", "debug", process.platform === "win32" ? "notes-core.exe" : "notes-core");
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-library-audit-"));
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const service = spawn(executable, [
  "--serve", root, "--port", "0", "--ready-file", ready, "--stop-file", stop,
  "--auth-mode", "token",
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let diagnostics = "";
service.stderr.on("data", (data) => { diagnostics += data; });
let browser;

try {
  let launchUrl;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (service.exitCode !== null) break;
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
  await page.locator("#connection-label").filter({ hasText: "Local service" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll("button[data-path]").length > 0);
  const files = await page.locator("button[data-path]")
    .evaluateAll((buttons) => buttons.map((button) => button.dataset.path));
  const failures = [];
  for (const file of files) {
    const url = new URL(launchUrl);
    url.searchParams.set("document", await fixtureResourceId(launchUrl, file));
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const panes = document.querySelector("#document-panes");
      const editor = document.querySelector("#rich-editor");
      return panes && !panes.hidden && editor?.getAttribute("aria-busy") !== "true";
    });
    const warning = page.locator("#rich-warning");
    if (await warning.isVisible()) {
      failures.push({ path: file, warning: (await warning.textContent()).trim() });
    }
  }
  console.log(JSON.stringify({ scanned: files.length, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
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
