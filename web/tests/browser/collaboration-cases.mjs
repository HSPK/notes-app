import { spawn } from "node:child_process";
import { test, expect, fs, path, buildRoot, executable, delay, chooseView, userDocumentUrl } from "./fixture.mjs";

export async function collaborativeLibrary(browser, { content, source = false, routeSockets = false, saveDelay, participants = 2, sharing = "edit", host = "127.0.0.1", allowedHosts = [] } = {}) {
  const directory = await fs.mkdtemp(path.join(buildRoot, "collaboration-"));
  const notes = path.join(directory, "notes");
  const users = path.join(directory, "users.json");
  const ready = path.join(directory, "ready.json");
  const stop = path.join(directory, "stop");
  await fs.mkdir(notes);
  await fs.writeFile(path.join(notes, "Shared.md"), content ?? "---\ntitle: Shared\n---\n\n# Shared\n\nAlpha\n\nBeta\n");
  await fs.writeFile(path.join(notes, "Other.md"), "# Other\n");
  let diagnostic = "";
  const launch = (port = "0") => {
    const child = spawn(executable, [
      "--serve", notes, "--host", host, "--port", port, "--auth-file", users, "--ready-file", ready, "--stop-file", stop,
      ...allowedHosts.flatMap(hostname => ["--allow-host", hostname]),
    ], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (data) => { diagnostic += data; });
    return child;
  };
  let service = launch();
  const contexts = [];
  try {
    let url;
    for (let i = 0; i < 200; i += 1) {
      if (service.exitCode !== null) throw new Error(diagnostic);
      try { url = JSON.parse(await fs.readFile(ready, "utf8")).url; break; }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await delay(50);
    }
    if (!url) throw new Error(`Collaboration server did not start: ${diagnostic}`);
    const alice = await browser.newContext();
    contexts.push(alice);
    const setup = await alice.request.post(new URL("/api/auth/setup", url).href, {
      data: { username: "alice", password: "alice test password long enough" },
    });
    expect(setup.ok(), await setup.text()).toBe(true);
    const invitation = await alice.request.post(new URL("/api/admin/accounts", url).href, {
      data: { action: "invite", hours: 24 },
    });
    expect(invitation.ok(), await invitation.text()).toBe(true);
    const code = (await invitation.json()).code;
    const bob = await browser.newContext();
    contexts.push(bob);
    const login = await bob.request.post(new URL("/api/auth/register", url).href, {
      data: { username: "bob", password: "bob test password long enough", invitation: code },
    });
    expect(login.ok(), await login.text()).toBe(true);
    const shared = await alice.request.post(new URL("/api/projects", url).href, {
      data: { action: "share", id: "default", shared: sharing },
    });
    expect(shared.ok(), await shared.text()).toBe(true);
    if (source || saveDelay !== undefined) {
      const prefs = await (await alice.request.get(new URL("/api/preferences", url).href)).json();
      if (source) prefs.web.defaultView = "source";
      if (saveDelay !== undefined) prefs.web.autoSaveDelayMs = saveDelay;
      const updated = await alice.request.put(new URL("/api/preferences", url).href, { data: prefs });
      expect(updated.ok(), await updated.text()).toBe(true);
    }
    const sockets = [];
    if (routeSockets) await alice.routeWebSocket(/\/api\/collaboration\/socket/, (socket) => {
      sockets.push({ socket, server: socket.connectToServer() });
    });
    const pages = await Promise.all(contexts.slice(0, participants).map((context) => context.newPage()));
    for (const page of pages) {
      await page.goto(await userDocumentUrl(page.context(), url, "Shared.md"));
      if (!source) await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
    }
    if (participants > 1) {
      for (const page of pages) await expect(page.locator("#collaboration-join")).toHaveText("Sharing");
      for (const page of pages) await expect(page.locator(".collaboration-avatar")).toHaveCount(participants);
    } else {
      await expect(pages[0].locator("#collaboration-join")).toBeHidden();
    }
    return {
      pages, notes, url, sockets,
      async restart(crash = false) {
        const exited = new Promise((resolve) => service.once("exit", resolve));
        if (crash) service.kill("SIGKILL");
        else await fs.writeFile(stop, "");
        await exited;
        await fs.rm(ready, { force: true });
        await fs.rm(stop, { force: true });
        service = launch(new URL(url).port);
        for (let i = 0; i < 200; i += 1) {
          if (service.exitCode !== null) throw new Error(diagnostic);
          try { if (JSON.parse(await fs.readFile(ready, "utf8")).url === url) return; }
          catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
          await delay(50);
        }
        throw new Error(`Collaboration server did not restart: ${diagnostic}`);
      },
      async close() {
        await Promise.all(contexts.map((context) => context.close()));
        await fs.writeFile(stop, "");
        for (let i = 0; i < 100 && service.exitCode === null; i += 1) await delay(50);
        if (service.exitCode === null) service.kill();
        await fs.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.all(contexts.map((context) => context.close()));
    await fs.writeFile(stop, "");
    for (let i = 0; i < 100 && service.exitCode === null; i += 1) await delay(50);
    if (service.exitCode === null) service.kill();
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function sourceCaret(page, word) {
  await page.locator("#editor").focus();
  await page.locator("#editor").evaluate((element, word) => {
    const end = element.value.indexOf(word) + word.length;
    element.setSelectionRange(end, end);
  }, word);
}

test("two authenticated editors merge simultaneous Source edits, preserve local undo and show colored cursors", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [alice, bob] = library.pages;
    await expect(alice.getByRole("img", { name: "alice (you)", exact: true })).toBeVisible();
    await expect(alice.getByRole("img", { name: "bob", exact: true })).toBeVisible();
    const colors = await alice.locator(".collaboration-avatar").evaluateAll(
      (avatars) => avatars.map((avatar) => getComputedStyle(avatar).borderColor),
    );
    expect(new Set(colors).size).toBe(2);
    for (const page of library.pages) await chooseView(page, "editor");
    await sourceCaret(alice, "Alpha");
    await sourceCaret(bob, "Beta");
    await expect(alice.locator(".collaboration-caret-name")).toHaveText("bob");
    await expect(bob.locator(".collaboration-caret-name")).toHaveText("alice");
    await alice.screenshot({ path: path.join(buildRoot, "collaboration-source.png") });
    await Promise.all([
      alice.keyboard.insertText(" alice"),
      bob.keyboard.insertText(" bob"),
    ]);
    for (const page of library.pages) {
      await expect(page.locator("#editor")).toHaveValue(/Alpha alice[\s\S]*Beta bob/);
      await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    }
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toContain("Beta bob");
    await alice.keyboard.press("Control+z");
    for (const page of library.pages) await expect(page.locator("#editor")).toHaveValue(/Alpha\n\nBeta bob/);
    await alice.keyboard.press("Control+Shift+z");
    for (const page of library.pages) await expect(page.locator("#editor")).toHaveValue(/Alpha alice[\s\S]*Beta bob/);
  } finally { await library.close(); }
});

test("Live and Compare editors share Markdown and metadata without mixing document presence", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [alice, bob] = library.pages;
    await chooseView(bob, "split");
    await sourceCaret(bob, "Beta");
    await bob.keyboard.insertText(" 中文 $x^2$");
    await expect(alice.locator(".ProseMirror")).toContainText("Beta 中文");
    await expect(alice.locator(".notes-math-output .katex")).toHaveCount(1);
    await expect(alice.locator(".collaboration-caret-name")).toHaveText("bob");
    await alice.screenshot({ path: path.join(buildRoot, "collaboration-live.png") });
    await alice.locator(".ProseMirror h1").click();
    await alice.keyboard.press("End");
    await alice.keyboard.insertText(" jointly");
    await expect(bob.locator("#editor")).toHaveValue(/# Shared jointly/);
    const metadata = alice.locator(".notes-metadata");
    await metadata.locator("summary").click();
    await metadata.locator("textarea").fill("title: Shared together\n");
    await expect(bob.locator("#editor")).toHaveValue(/title: Shared together/);
    await expect(bob.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await bob.goto(await userDocumentUrl(bob.context(), library.url, "Other.md"));
    await expect(bob.locator("#collaboration-join")).toBeHidden();
    await expect(alice.locator(".collaboration-avatar")).toHaveCount(1);
    await expect(bob.locator(".collaboration-avatar")).toHaveCount(0);
    expect(await fs.readFile(path.join(library.notes, "Other.md"), "utf8")).toBe("# Other\n");
  } finally { await library.close(); }
});

test("the last collaborator disconnecting flushes accepted edits before the autosave delay", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { source: true, saveDelay: 10_000 });
  try {
    const [alice, bob] = library.pages;
    await sourceCaret(alice, "Alpha");
    await alice.keyboard.insertText(" before closing");
    await expect(bob.locator("#editor")).toHaveValue(/Alpha before closing/);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).not.toContain("before closing");
    await alice.close({ runBeforeUnload: false });
    await expect(bob.locator(".collaboration-avatar")).toHaveCount(1);
    await bob.close({ runBeforeUnload: false });
    await expect.poll(() => fs.readFile(path.join(library.notes, "Shared.md"), "utf8"), { timeout: 5000 })
      .toContain("Alpha before closing");
  } finally { await library.close(); }
});

test("authenticated collaboration remains connected beyond the HTTP header timeout", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { routeSockets: true, source: true });
  try {
    const [alice, bob] = library.pages;
    await delay(31_500);
    expect(library.sockets).toHaveLength(1);
    await sourceCaret(alice, "Alpha");
    await alice.keyboard.insertText(" still connected");
    await expect(bob.locator("#editor")).toHaveValue(/Alpha still connected/);
  } finally { await library.close(); }
});

test("collaborative edits queued during IME and disconnection merge after reconnect", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { routeSockets: true });
  try {
    const [alice, bob] = library.pages;
    await alice.locator(".ProseMirror h1").click();
    await alice.keyboard.press("End");
    const cdp = await alice.context().newCDPSession(alice);
    await cdp.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
    await chooseView(bob, "editor");
    await sourceCaret(bob, "Beta");
    await bob.keyboard.insertText(" remote");
    await cdp.send("Input.insertText", { text: "中文" });
    await expect(alice.locator(".ProseMirror h1")).toContainText("中文");
    await expect(alice.locator(".ProseMirror")).toContainText("Beta remote");
    await expect(bob.locator("#editor")).toHaveValue(/Shared中文/);
    await chooseView(alice, "editor");
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await library.sockets[0].socket.close({ code: 1012, reason: "Connection interrupted for test" });
    await library.sockets[0].server.close();
    await expect(alice.locator("#collaboration-message")).toContainText("disconnected");
    await sourceCaret(alice, "Alpha");
    await alice.keyboard.insertText(" offline");
    await sourceCaret(bob, "Beta remote");
    await bob.keyboard.insertText(" online");
    await expect(alice.locator("#collaboration-join")).toHaveText("Sharing");
    for (const page of library.pages) {
      await expect(page.locator("#editor")).toHaveValue(/Alpha offline[\s\S]*Beta remote online/);
      await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    }
  } finally { await library.close(); }
});

test("collaborative large Source uses virtual editing and protects external disk changes", async ({ browser }) => {
  const content = "# Large shared\n\n" + "Paragraph with enough text for virtualization.\n".repeat(20_000);
  const library = await collaborativeLibrary(browser, { content, source: true });
  try {
    const [alice, bob] = library.pages;
    const virtual = (page) => page.locator(".virtual-source-editor .cm-content");
    for (const page of library.pages) await expect(virtual(page)).toBeVisible();
    await virtual(alice).focus();
    await alice.keyboard.press("Control+End");
    await alice.keyboard.insertText("Alice 中文\n");
    await virtual(bob).focus();
    await bob.keyboard.press("Control+Home");
    await bob.keyboard.insertText("Bob\n\n");
    for (const page of library.pages) await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await expect.poll(() => fs.readFile(path.join(library.notes, "Shared.md"), "utf8"))
      .toBe(`Bob\n\n${content}Alice 中文\n`);
    await fs.writeFile(path.join(library.notes, "Shared.md"), "# Externally replaced\n");
    await alice.keyboard.insertText("Keep this draft");
    await expect(alice.locator("#collaboration-message")).toContainText("save failed");
    await expect(bob.locator("#collaboration-message")).toContainText("save failed");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe("# Externally replaced\n");
  } finally { await library.close(); }
});

test("administrator creates one-use invitations and manages invited users from Settings", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  const guest = await browser.newContext();
  try {
    const [alice] = library.pages;
    await alice.locator("#settings-open").click();
    await alice.locator("#settings-dialog").getByRole("tab", { name: "Users", exact: true }).click();
    await expect(alice.locator("#accounts-list")).toContainText("alice");
    await expect(alice.locator("#accounts-list")).toContainText("bob");
    await alice.locator("#invite-create").click();
    await expect(alice.locator("#invite-created")).toBeVisible();
    const invitation = await alice.locator("#invite-code").inputValue();
    expect(invitation).toMatch(/^[a-f0-9]{24}\.[a-f0-9]{64}$/);
    const page = await guest.newPage();
    await page.goto(library.url);
    await page.locator("#auth-use-invitation").click();
    await page.locator("#auth-invitation").fill(invitation);
    await page.locator("#auth-username").fill("charlie");
    await page.locator("#auth-password").fill("charlie test password long enough");
    await page.locator("#auth-confirm").fill("charlie test password long enough");
    await page.locator("#auth-submit").click();
    await expect(page.locator("#auth-screen")).toBeHidden();
    await page.locator("#settings-open").click();
    await expect(page.locator("[data-settings-tab=users]")).toBeHidden();
    const replay = await guest.request.post(new URL("/api/auth/register", library.url).href, {
      data: { username: "replay", password: "replay password long enough", invitation },
    });
    expect(replay.status()).toBe(400);
    await alice.locator("#settings-dialog").getByRole("tab", { name: "Library", exact: true }).click();
    await alice.locator("#settings-dialog").getByRole("tab", { name: "Users", exact: true }).click();
    const row = alice.locator(".account-row").filter({ has: alice.getByText("charlie", { exact: true }) });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Reset password" }).click();
    await alice.locator("#account-password").fill("replacement password long enough");
    await alice.locator("#account-password-form button[type=submit]").click();
    await expect(alice.locator("#account-password-dialog")).toBeHidden();
    const denied = await guest.request.get(new URL("/api/admin/accounts", library.url).href);
    expect(denied.status()).toBe(401);
    alice.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(alice.locator("#accounts-list")).not.toContainText("charlie");
  } finally { await guest.close(); await library.close(); }
});
