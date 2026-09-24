import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const buildRoot = path.resolve(webRoot, "..", "build");
export const executable = process.env.NOTES_TEST_EXE
  ?? path.join(buildRoot, "rust", "debug", process.platform === "win32" ? "notes-core.exe" : "notes-core");
export const initialText = "# Welcome\n\nA **local** notebook.\n\n"
  + "- [ ] A task\n\n| Name | Value |\n| --- | --- |\n| Notes | Local |\n\n"
  + "```rust\nfn main() {}\n```\n\n![Pixel](images/pixel.png)\n\n[Second](Second.md)\n";
const defaultPreferences = {
  appearance: { theme: "system", latinFont: "sans-serif", cjkFont: "sans-serif" },
  web: {
    autoSaveDelayMs: 1000,
    defaultView: "live",
    sourceLineWrap: true,
    spellcheck: true,
    fontSizePx: 17,
    lineHeightPercent: 175,
    density: "comfortable",
    defaultSidebar: "files",
    sidebarOpen: true,
    hiddenPatterns: [],
    treeRefreshSeconds: 0,
    gitRefreshSeconds: 15,
    gitShowUntracked: true,
    gitDefaultDiff: "working",
    largeDocumentThresholdKib: 768,
    previewDelayMs: 300,
    outlineDelayMs: 75,
    reducedMotion: false,
    highContrast: false,
    strongFocus: true,
  },
};
let directory;
export let root;
let ready;
let stop;
let child;
let launchUrl;
let diagnostics = "";

export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export async function chooseView(page, id) {
  await page.locator("#view-menu > summary").click();
  await page.locator(`#view-${id}`).click();
}

export async function reloadDocument(page) {
  await page.locator("#more-menu > summary").click();
  await page.locator("#reload-document").click();
}

export async function openFixture(page, name, content, displayTitle = name) {
  await fs.writeFile(path.join(root, name), content);
  await page.goto(await fixtureDocumentUrl(name));
  await expect(page.locator("#document-title")).toHaveText(displayTitle);
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
}

async function fixtureDocumentUrl(path) {
  const url = new URL(launchUrl);
  const token = url.hash.match(/(?:^#|&)token=([a-f0-9]+)/i)?.[1];
  const response = await fetch(new URL("/api/resources/resolve", url), {
    method: "POST", headers: { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" },
    body: JSON.stringify({path, kind: "document"}),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  url.searchParams.set("document", (await response.json()).id);
  return url.href;
}

export async function userResourceId(context, base, path, kind = "document", project = "default") {
  const response = await context.request.post(new URL("/api/resources/resolve", base).href, {
    headers: { "X-Notes-Project": project }, data: { path, kind },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).id;
}

export async function userDocumentUrl(context, base, path, project = "default") {
  const id = await userResourceId(context, base, path, "document", project);
  const url = new URL(base);
  url.searchParams.set("document", id);
  url.searchParams.set("project", project);
  return url.href;
}

export async function metadataField(page) {
  const panel = page.locator("#rich-editor details");
  await expect(panel).toBeVisible();
  if (await panel.getAttribute("open") === null) await panel.locator("summary").click();
  return panel.locator("textarea");
}

test.beforeAll(async () => {
  await fs.mkdir(buildRoot, { recursive: true });
  directory = await fs.mkdtemp(path.join(buildRoot, "browser-fixture-"));
  root = path.join(directory, "notes");
  ready = path.join(directory, "ready.json");
  stop = path.join(directory, "stop");
  await fs.mkdir(path.join(root, "images"), { recursive: true });
  await fs.writeFile(path.join(root, "images", "pixel.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ));
  child = spawn(executable, [
    "--serve", root, "--port", "0", "--ready-file", ready, "--stop-file", stop,
    "--auth-mode", "token",
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let launchError;
  child.on("error", (error) => { launchError = error; });
  child.stdout.on("data", (data) => { diagnostics += data; });
  child.stderr.on("data", (data) => { diagnostics += data; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Notes exited: ${diagnostics}`);
    try {
      launchUrl = JSON.parse(await fs.readFile(ready, "utf8")).url;
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  expect(launchUrl, `The native service did not initialize: ${diagnostics}`).toBeTruthy();
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    await fs.writeFile(stop, "");
    for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1) await delay(100);
    if (child.exitCode === null) {
      child.kill();
      throw new Error("The native service failed to stop gracefully.");
    }
  }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.notesDiagnostics = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      window.notesDiagnostics.push(`CSP: ${event.violatedDirective}`);
    });
    window.addEventListener("error", (event) => {
      window.notesDiagnostics.push(event.message);
    });
    window.addEventListener("unhandledrejection", (event) => {
      window.notesDiagnostics.push(String(event.reason));
    });
  });
  await fs.writeFile(path.join(root, "README.md"), initialText);
  await fs.writeFile(path.join(root, "Second.md"), "# Second\n\nAnother note.\n");
  await fs.writeFile(path.join(root, "Unsupported.md"), "# Source\n\n<div>Keep this HTML</div>\n");
  const token = new URL(launchUrl).hash.match(/(?:^#|&)token=([a-f0-9]+)/i)?.[1];
  const settings = await fetch(new URL("/api/preferences", launchUrl), {
    method: "PUT",
    headers: {
      Authorization: ["Bearer", token].join(" "),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(defaultPreferences),
  });
  expect(settings.ok, await settings.text()).toBeTruthy();
  await page.goto(await fixtureDocumentUrl("README.md"));
  await expect(page.locator("#document-title")).toHaveText("README.md");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#dirty-indicator")).toBeHidden();
  await expect(page.locator("#document-modified")).toBeHidden();
});

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) {
    expect(await page.evaluate(() => window.notesDiagnostics)).toEqual([]);
  }
});


export { test, expect, fs, path };
