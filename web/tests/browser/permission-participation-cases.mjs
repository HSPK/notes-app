import { test, expect, fs, path, userDocumentUrl, userResourceId } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

async function loginPage(browser, library, username) {
  const context = await browser.newContext();
  const login = await context.request.post(new URL("/api/auth/login", library.url).href, {
    data: { username, password: `${username} test password long enough` },
  });
  expect(login.ok()).toBe(true);
  return { context, page: await context.newPage() };
}

test("private notes save normally without collaboration rooms or sockets on open", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private", source: true });
  try {
    const [page] = library.pages;
    let joins = 0;
    let sockets = 0;
    page.on("request", (request) => { if (request.url().includes("/collaboration/join")) joins += 1; });
    page.on("websocket", () => { sockets += 1; });
    await page.reload();
    await expect(page.locator("#editor")).toBeEnabled();
    await page.locator("#editor").fill("# Solo edit\n\nNo collaboration setup.\n");
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await expect(page.locator("#collaboration-join")).toBeHidden();
    await expect(page.locator(".collaboration-avatar")).toHaveCount(0);
    expect(joins).toBe(0);
    expect(sockets).toBe(0);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toContain("Solo edit");
    const denied = await page.request.post(new URL("/api/collaboration/join", library.url).href, {
      data: { document: new URL(page.url()).searchParams.get("document") },
    });
    expect(denied.status()).toBe(403);
  } finally { await library.close(); }
});

test("only another authorized identity activates collaboration and pending solo edits survive the handoff", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, saveDelay: 10_000 });
  const same = await loginPage(browser, library, "alice");
  const other = await loginPage(browser, library, "bob");
  try {
    const [alice] = library.pages;
    const document = new URL(alice.url()).searchParams.get("document");
    await same.page.goto(await userDocumentUrl(same.context, library.url, "Shared.md"));
    await expect(same.page.locator("#editor")).toBeEnabled();
    const policy = await same.page.request.post(new URL("/api/collaboration/presence", library.url).href, {
      data: { document },
    });
    expect(policy.ok()).toBe(true);
    const registration = await policy.json();
    expect(registration.phase).toBe("solo");
    await same.page.request.post(new URL("/api/collaboration/presence", library.url).href, {
      data: { document, participant: registration.participant, leave: true },
    });
    await expect(alice.locator("#collaboration-join")).toBeHidden();
    await expect(same.page.locator("#collaboration-join")).toBeHidden();
    await alice.locator("#editor").fill("# Unsaved handoff\n\nKeep the local edit.\n");
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
    await other.page.goto(await userDocumentUrl(other.context, library.url, "Shared.md"));
    for (const page of [alice, same.page, other.page]) {
      await expect(page.locator("#collaboration-join")).toHaveText("Sharing");
      await expect(page.locator("#editor")).toHaveValue("# Unsaved handoff\n\nKeep the local edit.\n");
      await expect(page.locator(".collaboration-avatar")).toHaveCount(3);
    }
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toContain("Keep the local edit.");
  } finally { await same.context.close(); await other.context.close(); await library.close(); }
});

test("private page overrides disable collaboration even for an owner in an editable project", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true });
  try {
    const [owner] = library.pages;
    const document = new URL(owner.url()).searchParams.get("document");
    const response = await owner.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "document", id: "default", document, permission: "private" },
    });
    expect(response.ok()).toBe(true);
    await owner.reload();
    await expect(owner.locator("#editor")).toBeEnabled();
    await expect(owner.locator("#editor")).toHaveJSProperty("readOnly", false);
    const doc = await owner.request.get(new URL(`/api/document?id=${document}`, library.url).href);
    expect(JSON.parse(doc.headers()["x-notes-document-permissions"])).toEqual({
      writable: true, collaborative: false, owner: true,
    });
    await expect(owner.locator("#collaboration-join")).toBeHidden();
  } finally { await library.close(); }
});

test("a conflicting solo draft blocks activation without overwriting disk and preparation can be cancelled", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, saveDelay: 10_000 });
  const other = await loginPage(browser, library, "bob");
  try {
    const [alice] = library.pages;
    let joins = 0;
    for (const page of [alice, other.page]) {
      page.on("request", (request) => { if (request.url().includes("/collaboration/join")) joins += 1; });
    }
    await alice.locator("#editor").fill("# Keep my local draft\n");
    await fs.writeFile(path.join(library.notes, "Shared.md"), "# External version\n");
    await other.page.goto(await userDocumentUrl(other.context, library.url, "Shared.md"));
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "conflict");
    await expect(alice.locator("#editor")).toHaveValue("# Keep my local draft\n");
    await expect(alice.locator("#editor")).toBeEnabled();
    await expect(other.page.locator("#collaboration-join")).toHaveText("Preparing");
    await other.page.locator("#collaboration-join").click();
    await expect(other.page.locator("#editor")).toBeEnabled();
    expect(joins).toBe(0);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe("# External version\n");
  } finally { await other.context.close(); await library.close(); }
});

test("a delayed handoff cannot save or enter collaboration in a subsequently opened document", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, saveDelay: 10_000 });
  const other = await loginPage(browser, library, "bob");
  try {
    const [alice] = library.pages;
    await alice.evaluate(() => {
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      let first = true;
      const gate = new Promise((resolve) => { window.releaseDraftEncryption = resolve; });
      crypto.subtle.encrypt = async (...args) => {
        if (first) { first = false; window.draftEncryptionBlocked = true; await gate; }
        return encrypt(...args);
      };
    });
    await alice.locator("#editor").fill("# Old document draft\n");
    await alice.waitForFunction(() => window.draftEncryptionBlocked);
    await other.page.goto(await userDocumentUrl(other.context, library.url, "Shared.md"));
    await expect(alice.locator("#editor")).toBeDisabled();
    alice.once("dialog", (dialog) => dialog.accept());
    await alice.locator('[data-path="Other.md"]').click();
    await expect(alice.locator("#document-title")).toHaveText("Other.md");
    await expect(alice.locator("#editor")).toBeEnabled();
    const target = await userResourceId(alice.context(), library.url, "Other.md");
    let saves = 0;
    alice.on("request", (request) => {
      if (request.method() === "PUT" && request.url().endsWith("/api/document")
          && request.postDataJSON()?.id === target) saves += 1;
    });
    await alice.locator("#editor").fill("# New document unsaved\n");
    const heartbeat = alice.waitForResponse((response) =>
      response.url().includes("/collaboration/presence") && response.request().postDataJSON()?.document === target);
    await alice.evaluate(() => window.releaseDraftEncryption());
    await heartbeat;
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
    await expect(alice.locator("#collaboration-join")).toBeHidden();
    expect(saves).toBe(0);
    expect(await fs.readFile(path.join(library.notes, "Other.md"), "utf8")).toBe("# Other\n");
  } finally {
    await library.pages[0].evaluate(() => window.releaseDraftEncryption?.())
      .catch((error) => console.warn("The draft fixture page closed before cleanup.", error.message));
    await other.context.close();
    await library.close();
  }
});
