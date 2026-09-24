import { test, expect, fs, path, chooseView, metadataField } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

async function append(page, text) {
  await page.locator("#editor").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(text);
}

async function draftRows(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("notes-private-drafts", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise((resolve, reject) => {
      const request = database.transaction("drafts").objectStore("drafts").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return Promise.all(records.map(async (record) => ({ key: record.key, cleartext: await record.payload.text() })));
  });
}

test("acknowledged but unsaved collaborative drafts resume without a manual recovery dialog", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { source: true, saveDelay: 10_000 });
  try {
    const [alice, bob] = library.pages;
    const opened = alice.waitForEvent("websocket");
    await alice.reload();
    const socket = await opened;
    await expect(alice.locator("#collaboration-join")).toHaveText("Sharing");
    const acknowledged = socket.waitForEvent("framereceived", (event) =>
      typeof event.payload === "string" && event.payload.includes('"type":"ack"'));
    await append(alice, "\nACKNOWLEDGED DRAFT\n");
    await acknowledged;
    await expect(bob.locator("#editor")).toHaveValue(/ACKNOWLEDGED DRAFT/);
    await expect.poll(async () => (await draftRows(alice)).length).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).not.toContain("ACKNOWLEDGED DRAFT");
    await alice.reload();
    await expect(alice.locator("#collaboration-join")).toHaveText("Sharing");
    await expect(alice.locator("#draft-recovery-dialog")).toBeHidden();
    await expect(alice.locator("#editor")).toHaveValue(/ACKNOWLEDGED DRAFT/);
  } finally { await library.close(); }
});

test("accepted collaborative updates survive a crash and encrypted offline drafts merge after a browser refresh", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { source: true, routeSockets: true, saveDelay: 10_000 });
  try {
    const [alice, bob] = library.pages;
    await append(alice, "\nDURABLE ACCEPTED TEXT\n");
    await expect(bob.locator("#editor")).toHaveValue(/DURABLE ACCEPTED TEXT/);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).not.toContain("DURABLE ACCEPTED TEXT");
    await library.restart(true);
    await expect(alice.locator("#collaboration-join")).toHaveText("Sharing");
    await expect(bob.locator("#collaboration-join")).toHaveText("Sharing");
    await expect(alice.locator("#editor")).toHaveValue(/DURABLE ACCEPTED TEXT/);
    await alice.locator("#editor").focus();
    await alice.keyboard.press("Control+s");
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await alice.context().setOffline(true);
    const disconnected = library.sockets.at(-1);
    await disconnected.socket.close({ code: 1012, reason: "offline draft fixture" });
    await disconnected.server.close();
    await expect(alice.locator("#collaboration-join")).toHaveText("Reconnect");
    await append(alice, "\nOFFLINE RECOVERY 中文\n");
    await expect.poll(async () => (await draftRows(alice)).length).toBeGreaterThan(0);
    for (const row of await draftRows(alice)) expect(row.cleartext).not.toContain("OFFLINE RECOVERY");
    await append(bob, "\nREMOTE WHILE OFFLINE\n");
    await alice.context().setOffline(false);
    await alice.reload();
    await expect(alice.locator("#collaboration-join")).toHaveText("Sharing");
    await expect(alice.locator("#editor")).toHaveValue(/OFFLINE RECOVERY 中文/);
    await expect(alice.locator("#editor")).toHaveValue(/REMOTE WHILE OFFLINE/);
    await expect(bob.locator("#editor")).toHaveValue(/OFFLINE RECOVERY 中文/);
    await alice.locator("#editor").focus();
    await alice.keyboard.press("Control+s");
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await expect.poll(async () => (await draftRows(alice)).length).toBe(0);
  } finally { await library.close(); }
});

test("metadata tags drive permission-filtered search and history restores without replacing YAML spelling", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [alice, bob] = library.pages;
    const metadata = await metadataField(alice);
    await metadata.fill('title: "Shared"\n# Preserve this\ncustom: {x: 1}\n');
    const add = alice.getByRole("textbox", { name: "Add a metadata tag" });
    await add.fill("research");
    await add.press("Enter");
    await expect(metadata).toHaveValue(/tags: \["research"\]/);
    await expect(metadata).toHaveValue(/custom: \{x: 1\}/);
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await alice.locator(".notes-tag").getByRole("button", { name: "research", exact: true }).click();
    await expect(alice.locator("#search-dialog")).toBeVisible();
    await expect(alice.locator("#search-results")).toContainText("Shared");
    await expect(alice.locator("#search-results")).not.toContainText("Other.md");
    await alice.locator("#search-close").click();
    await chooseView(alice, "editor");
    await append(alice, "\nVERSION TO REVERT\n");
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await alice.locator("#more-menu > summary").click();
    await alice.locator("#history-open").click();
    await expect(alice.locator("#history-list button")).toHaveCount(3);
    await alice.locator("#history-list button").nth(1).click();
    await expect(alice.locator("#history-diff")).toContainText("VERSION TO REVERT");
    alice.once("dialog", (dialog) => dialog.accept());
    await alice.locator("#history-restore").click();
    await expect(alice.locator("#history-dialog")).toBeHidden();
    await expect(alice.locator("#editor")).not.toHaveValue(/VERSION TO REVERT/);
    await expect(bob.locator("#collaboration-message")).toContainText(/restored|removed/);
    await expect(alice.locator("#collaboration-join")).toBeHidden();
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await alice.locator("#more-menu > summary").click();
    alice.once("dialog", (dialog) => dialog.accept());
    await alice.locator("#document-trash").click();
    await expect(alice.locator("#document-title")).toHaveText("Select a note");
    expect(await fs.stat(path.join(library.notes, "Shared.md")).then(() => true, () => false)).toBe(false);
    await alice.locator("#more-menu > summary").click();
    await alice.locator("#trash-open").click();
    await alice.getByRole("button", { name: "Restore Shared.md", exact: true }).click();
    await expect(alice.locator("#trash-list")).not.toContainText("Shared.md");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toContain("research");
  } finally { await library.close(); }
});

test("favorites and recent notes follow the account without restoring legacy document tabs", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  const other = await browser.newContext();
  try {
    const [alice] = library.pages;
    await alice.locator("#more-menu > summary").click();
    await alice.locator("#workspace-favorite").click();
    await expect(alice.locator("#workspace-favorite")).toHaveText("Remove from favorites");
    const legacy = await alice.request.post(new URL("/api/workspace", library.url).href, {
      data: { action: "pin", project: "default", id: new URL(alice.url()).searchParams.get("document"), value: true },
    });
    expect(legacy.ok()).toBe(true);
    await alice.locator('[data-path="Other.md"]').click();
    await expect(alice.locator("#document-title")).toHaveText("Other.md");
    await alice.locator('[data-path="Shared.md"]').click();
    await expect(alice.locator("#document-title")).toHaveText("Shared");
    await expect(alice.locator("#document-tabs, #workspace-pin")).toHaveCount(0);
    const login = await other.request.post(new URL("/api/auth/login", library.url).href, {
      data: { username: "alice", password: "alice test password long enough" },
    });
    expect(login.ok()).toBe(true);
    const page = await other.newPage();
    await page.goto(library.url);
    await expect(page.locator("#document-title")).toHaveText("Shared");
    await expect(page.locator("#document-tabs, #workspace-pin")).toHaveCount(0);
    await page.locator("#more-menu > summary").click();
    await page.locator("#workspace-open").click();
    await expect(page.locator("#workspace-list")).toContainText("Shared");
    await expect(page.locator("#workspace-kind option")).toHaveCount(2);
    await page.locator("#workspace-kind").selectOption("recent");
    await expect(page.locator("#workspace-list")).toContainText("Other.md");
    await page.locator(".workspace-item-name").filter({ hasText: "Other.md" }).click();
    await expect(page.locator("#document-title")).toHaveText("Other.md");
    await expect(page.locator("#document-tabs")).toHaveCount(0);
  } finally { await other.close(); await library.close(); }
});
