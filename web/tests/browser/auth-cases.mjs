import { spawn } from "node:child_process";

import { test, expect, fs, path, buildRoot, executable, delay } from "./fixture.mjs";

test("login survives refresh and service restart, while logout requires login again", async ({ browser }) => {
  const fixture = await fs.mkdtemp(path.join(buildRoot, "auth-browser-"));
  const notes = path.join(fixture, "notes");
  const authFile = path.join(fixture, "users.json");
  const readyFile = path.join(fixture, "ready.json");
  const stopFile = path.join(fixture, "stop");
  await fs.mkdir(notes);
  await fs.writeFile(path.join(notes, "Shared.md"), "# Shared\n");
  let output = "";
  const launch = (port = "0") => {
    const service = spawn(executable, [
      "--serve", notes, "--port", port, "--ready-file", readyFile, "--stop-file", stopFile,
      "--auth-file", authFile,
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout.on("data", (data) => { output += data; });
    service.stderr.on("data", (data) => { output += data; });
    return service;
  };
  let service = launch();
  const readyUrl = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (service.exitCode !== null) throw new Error(`Authenticated Notes exited: ${output}`);
      try {
        return JSON.parse(await fs.readFile(readyFile, "utf8")).url;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      await delay(100);
    }
    throw new Error(`Authenticated Notes did not initialize: ${output}`);
  };
  const context = await browser.newContext();
  try {
    const url = await readyUrl();
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator("#auth-title")).toHaveText("Create the administrator");
    await page.locator("#auth-username").fill("Owner");
    await page.locator("#auth-password").fill("correct horse battery staple");
    await page.locator("#auth-confirm").fill("correct horse battery staple");
    await page.locator("#auth-submit").click();
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator("#connection-label")).toHaveText("Local service");
    await expect(page.locator("#connection-label")).toBeHidden();
    await expect(page.locator("#file-list")).toContainText("Shared.md");
    await page.reload();
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator("#file-list")).toContainText("Shared.md");

    const cookies = (await context.cookies()).filter((cookie) =>
      cookie.name.startsWith("notes_user_session_"));
    expect(cookies).toHaveLength(1);
    expect(cookies[0].httpOnly).toBe(true);
    expect(cookies[0].sameSite).toBe("Strict");
    await fs.writeFile(stopFile, "");
    await expect.poll(() => service.exitCode).toBe(0);
    await fs.rm(readyFile);
    await fs.rm(stopFile);
    service = launch(new URL(url).port);
    expect(await readyUrl()).toBe(url);
    await page.reload();
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator("#file-list")).toContainText("Shared.md");

    await page.locator("#more-menu > summary").click();
    const loggedOut = page.waitForEvent("domcontentloaded");
    await page.locator("#logout").click();
    await loggedOut;
    await expect(page.locator("#auth-screen")).toBeVisible();
    await expect(page.locator("#auth-title")).toHaveText("Log in to Notes");
    await page.reload();
    await expect(page.locator("#auth-screen")).toBeVisible();
    await page.locator("#auth-username").fill("owner");
    await page.locator("#auth-password").fill("correct horse battery staple");
    await page.locator("#auth-submit").click();
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator("#connection-label")).toHaveText("Local service");
    await expect(page.locator("#connection-label")).toBeHidden();

    const stored = await fs.readFile(authFile, "utf8");
    expect(stored).toContain("argon2id");
    expect(stored).not.toContain("correct horse battery staple");
  } finally {
    await context.close();
    await fs.writeFile(stopFile, "");
    for (let attempt = 0; attempt < 100 && service.exitCode === null; attempt += 1) {
      await delay(50);
    }
    if (service.exitCode === null) service.kill();
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
