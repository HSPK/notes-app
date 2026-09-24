import { networkInterfaces } from "node:os";
import { test, expect, fs, path } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

test("network HTTP binding supports login and online editing without plaintext recovery", async ({ browser }) => {
  const address = Object.values(networkInterfaces()).flat().find(entry => entry?.family === "IPv4" && !entry.internal)?.address;
  test.skip(!address, "A non-loopback IPv4 interface is required.");
  const library = await collaborativeLibrary(browser, { host: "0.0.0.0", source: true, participants: 1, sharing: "private" });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const url = new URL(library.pages[0].url());
    url.hostname = address;
    await page.goto(url.href);
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    await expect(page.locator("#auth-screen")).toBeVisible();
    await page.locator("#auth-username").fill("alice");
    await page.locator("#auth-password").fill("alice test password long enough");
    await page.locator("#auth-submit").click();
    await expect(page.locator("#editor")).toBeEnabled();
    await expect(page.locator("#document-message")).toBeHidden();
    await expect(page.locator("#dirty-indicator")).toBeHidden();
    await page.locator("#editor").fill("# Network edit\n");
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await expect(page.locator("#dirty-indicator")).toBeHidden();
    await expect(page.locator("#document-modified")).toBeHidden();
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe("# Network edit\n");
    await page.locator('[data-path="Other.md"]').click();
    await expect(page.locator("#document-title")).toHaveText("Other.md");
    await expect(page.locator("#document-message")).toBeHidden();
    expect(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === "notes-private-drafts"))).toBe(false);
    await page.locator("#more-menu > summary").click();
    await page.locator("#drafts-open").click();
    await expect(page.locator("#document-message")).toContainText("Local recovery is unavailable:");
    await expect(page.locator("#document-message")).toHaveClass(/is-error/);
    expect(errors).toEqual([]);
  } finally { await context.close(); await library.close(); }
});

test("configured DNS hostname supports login, session refresh and collaborative sockets", async ({ browser, playwright }) => {
  const hostname = "notes.example.test";
  const library = await collaborativeLibrary(browser, {
    host: "0.0.0.0", allowedHosts: [hostname], source: true, participants: 1,
  });
  const dnsBrowser = await playwright.chromium.launch({
    args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, "--no-proxy-server"],
  });
  try {
    const errors = [];
    const pages = [];
    for (const username of ["alice", "bob"]) {
      const page = await dnsBrowser.newPage();
      pages.push(page);
      page.on("pageerror", error => errors.push(error.message));
      const url = new URL(library.pages[0].url());
      url.hostname = hostname;
      await page.goto(url.href);
      await expect(page.locator("#auth-screen")).toBeVisible();
      await page.locator("#auth-username").fill(username);
      await page.locator("#auth-password").fill(`${username} test password long enough`);
      await page.locator("#auth-submit").click();
      await expect(page.locator("#editor")).toBeEnabled();
    }
    for (const page of pages) await expect(page.locator("#collaboration-join")).toHaveText("Sharing");
    const [alice, bob] = pages;
    await alice.locator("#editor").fill("# DNS collaborative edit\n");
    await expect(bob.locator("#editor")).toHaveValue("# DNS collaborative edit\n");
    for (const page of pages) await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe("# DNS collaborative edit\n");
    await alice.reload();
    await expect(alice.locator("#auth-screen")).toBeHidden();
    await expect(alice.locator("#collaboration-join")).toHaveText("Sharing");
    await expect(alice.locator("#editor")).toHaveValue("# DNS collaborative edit\n");
    expect(errors).toEqual([]);
  } finally { await dnsBrowser.close(); await library.close(); }
});
