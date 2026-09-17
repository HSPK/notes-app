import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const browser = process.env.NOTES_TEST_BROWSER ?? (process.platform === "win32"
  ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : chromium.executablePath());

test("formatted editing preserves YAML independently of body editing, selection, and history", {
  skip: !existsSync(browser), timeout: 60000,
}, async () => {
  const profile = path.join(webRoot, "frontend", `.browser-test-${process.pid}`);
  await mkdir(profile, { recursive: true });
  const harness = `
    import {createInlineEditor, extractOutline, applyAppearance} from "/editor.bundle.mjs";
    window.extractOutline = extractOutline;
    window.applyAppearance = applyAppearance;
    window.changes = []; window.fallbacks = []; window.links = []; window.outlines = []; window.selections = []; window.cspViolations = [];
    document.addEventListener("securitypolicyviolation", event => cspViolations.push(event.violatedDirective));
    window.editor = createInlineEditor({
      root: document.querySelector("#root"), toolbar: document.querySelector("#toolbar"),
      onChange: text => changes.push(text), onFallback: text => fallbacks.push(text),
      onLink: href => links.push(href), onOutline: items => outlines.push(items),
      onSelection: value => selections.push(value),
      styleNonce: document.querySelector('meta[name="notes-style-nonce"]').content,
    });
    window.loaded = true;
  `;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-notes-editor-test'; style-src-attr 'unsafe-inline'; img-src 'self'");
    try {
      if (request.url === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end('<!doctype html><meta name="notes-style-nonce" content="notes-editor-test"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/editor.bundle.css"><link rel="stylesheet" href="/test.css"><div class="test-sidebar"><div class="search-field"><input id="file-filter" aria-label="Search files"></div><button class="file-button">A note</button></div><button id="outside">Outside editor</button><div id="toolbar"></div><section id="test-layout" class="rich-pane"><div id="root" class="rich-editor"></div></section><script type="module" src="/test.mjs"></script>');
      } else if (request.url === "/test.css") {
        response.setHeader("Content-Type", "text/css");
        response.end("#test-layout { height: calc(100vh - 80px); } .test-sidebar { position: absolute; top: 0; left: 0; width: 180px; }");
      } else if (request.url === "/test.mjs") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(harness);
      } else if (["/editor.bundle.mjs", "/editor-helpers.mjs", "/editor.bundle.css", "/styles.css"].includes(request.url)) {
        response.setHeader("Content-Type", request.url.endsWith(".css") ? "text/css" : "text/javascript");
        response.end(await readFile(path.join(webRoot, "public", request.url.slice(1))));
      } else response.writeHead(404).end();
    } catch (error) { response.writeHead(500).end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const processHandle = spawn(browser, [
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1440,1400",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let socket;
  try {
    const debugPort = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser startup timed out")), 15000);
      processHandle.once("error", reject);
      processHandle.stderr.on("data", (data) => {
        const match = data.toString().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    const errors = [];
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
      if (!message.id) return;
      const operation = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) operation.reject(new Error(message.error.message));
      else operation.resolve(message.result);
    };
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const type = (text) => command("Input.insertText", { text });
    const undo = () => evaluate("document.querySelector('button[aria-label=Undo]').click()");
    await command("Runtime.enable");
    for (let count = 0; count < 100 && !await evaluate("Boolean(window.loaded)"); count++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await evaluate("Boolean(window.loaded)"), true);

    const prefix = '\uFEFF---\r\n# keep comment and order\r\ntitle: "Guide: examples"\r\ndescription: >-\r\n  Folded description\r\n  across lines\r\ntags:\r\n  - alpha\r\n  - "beta tag"\r\nunknown:\r\n  nested: [one, "two"]\r\n---\r\n\r\n';
    const body = '# Heading **world**\r\n\r\nA **bold** paragraph.\r\n\r\n- [ ] A task\r\n- Other\r\n\r\n| A | B |\r\n| - | - |\r\n| x | y |\r\n\r\n```cpp\r\nint main() {\r\n  return 0;\r\n}\r\n```\r\n\r\n[Next](../next.md#hello)\r\n\r\n![Local](../images/a.png)\r\n';
    const source = prefix + body;
    await evaluate(`editor.load(${JSON.stringify(source)}, "Folder/note.md")`);
    assert.deepEqual(await evaluate("fallbacks"), []);
    assert.equal(await evaluate("document.querySelectorAll('.ProseMirror[contenteditable=true]').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('[data-editor-scroller]').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('.frontmatter details textarea').length"), 1);
    assert.equal(await evaluate("document.querySelector('.ProseMirror h1').textContent"), "Heading world");
    assert.equal(await evaluate("document.querySelectorAll('.ProseMirror h2,.ProseMirror hr').length"), 0);
    assert.doesNotMatch(await evaluate("document.querySelector('.ProseMirror').textContent"), /title:|Folded description|unknown:/);
    assert.equal(await evaluate("document.querySelector('.notes-metadata details').open"), false);
    const summary = await evaluate("document.querySelector('.notes-metadata-summary').textContent");
    assert.match(summary, /Guide: examples/);
    assert.match(await evaluate("document.querySelector('.notes-metadata-description').textContent"), /Folded description across lines/);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.notes-metadata-tag')].map(tag => tag.textContent)"), ["alpha", "beta tag"]);
    assert.equal(await evaluate("document.querySelector('.notes-metadata-warning').hidden"), true);
    assert.equal(await evaluate("editor.getSource()"), source);
    assert.deepEqual(await evaluate("changes"), []);
    assert.deepEqual(await evaluate("outlines.at(-1)"), [{ text: "Heading world", level: 1, from: prefix.length, id: "heading-world" }]);
    assert.deepEqual(await evaluate(`extractOutline(${JSON.stringify(source)})`), await evaluate("outlines.at(-1)"));
    assert.equal(await evaluate("document.querySelector('.ProseMirror a').getAttribute('href')"), "/?file=next.md#hello");
    assert.equal(await evaluate("document.querySelector('.ProseMirror img[src]').getAttribute('src')"), "/assets?path=images%2Fa.png");
    assert.equal(await evaluate("document.querySelectorAll('.notes-code-gutter span').length"), 3);
    assert.ok(await evaluate("document.querySelectorAll('.notes-code-keyword').length") > 0);
    const layout = await evaluate(`(() => {
      const root = document.querySelector('#root').getBoundingClientRect();
      const scroll = document.querySelector('.notes-live-scroll').getBoundingClientRect();
      const page = document.querySelector('.notes-live-page');
      const rect = page.getBoundingClientRect();
      const task = document.querySelector('.notes-task-item');
      const check = task.querySelector('input').getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(task.querySelector('p'));
      const label = range.getBoundingClientRect();
      return {
        height: scroll.height, rootHeight: root.height, width: rect.width,
        padding: parseFloat(getComputedStyle(page).paddingTop), font: getComputedStyle(page).fontFamily,
        size: parseFloat(getComputedStyle(page).fontSize),
        gap: label.left - check.right, checkWidth: check.width, labelHeight: label.height,
      };
    })()`);
    assert.ok(Math.abs(layout.height - layout.rootHeight) <= 1, JSON.stringify(layout));
    assert.ok(layout.width <= 780 && layout.width > 700, JSON.stringify(layout));
    assert.equal(layout.padding, 56);
    assert.equal(layout.size, 17);
    assert.doesNotMatch(layout.font, /Consolas|monospace/);
    assert.ok(layout.checkWidth >= 12 && layout.checkWidth <= 22 && layout.gap >= 0 && layout.gap < 18 && layout.labelHeight < 30, JSON.stringify(layout));
    await evaluate("document.querySelector('#file-filter').focus()");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#file-filter')).outlineStyle"), "none");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#file-filter')).borderTopWidth"), "0px");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.search-field'),'::before').height"), "2px");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.search-field'),'::before').width"), "28px");
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.search-field'),'::before').backgroundColor"), "rgba(0, 0, 0, 0)");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.file-button'),'::before').content"), "none");
    await evaluate("document.querySelector('#outside').focus()");
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "solid");

    await evaluate(`editor.select(${source.indexOf("Heading") + 3})`);
    assert.equal(await evaluate("document.querySelector('.ProseMirror h1').textContent"), "Heading world");
    assert.equal(await evaluate("document.querySelectorAll('.cm-active-source').length"), 0);
    assert.deepEqual(await evaluate("changes"), []);
    await type("!");
    assert.equal(await evaluate("document.querySelector('.ProseMirror h1').textContent"), "Hea!ding world");
    assert.equal((await evaluate("changes.at(-1)")).slice(0, prefix.length), prefix);
    await undo();
    assert.equal(await evaluate("editor.getSource()"), source);
    await evaluate(`editor.select(${source.indexOf("bold") + 2})`);
    await type("X");
    assert.equal(await evaluate("document.querySelector('.ProseMirror p strong').textContent"), "boXld");
    assert.equal((await evaluate("editor.getSource()")).slice(0, prefix.length), prefix);
    await undo();
    assert.equal(await evaluate("editor.getSource()"), source);
    await evaluate("document.querySelector('#outside').focus()");
    assert.equal(await evaluate("document.querySelector('.ProseMirror h1').textContent"), "Heading world");
    assert.equal(await evaluate("document.querySelectorAll('.ProseMirror table').length"), 1);

    await evaluate(`(() => {
      document.querySelector('.notes-metadata details').open = true;
      const input = document.querySelector('.notes-metadata-source');
      input.focus(); const from = input.value.indexOf('Guide'); input.setSelectionRange(from, from + 5);
    })()`);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.notes-metadata-scroll')).borderLeftWidth"), "1px");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.notes-metadata-source')).borderLeftWidth"), "0px");
    await type("Updated");
    const metadataChanged = await evaluate("editor.getSource()");
    assert.equal(metadataChanged, source.replace("Guide", "Updated"));
    assert.ok(metadataChanged.endsWith(body));
    const changedPrefix = metadataChanged.slice(0, metadataChanged.length - body.length);
    assert.equal(await evaluate("outlines.at(-1)[0].from"), changedPrefix.length);
    await evaluate(`editor.select(${metadataChanged.indexOf("Heading") + 3})`);
    await type(" body");
    assert.ok((await evaluate("changes.at(-1)")).startsWith(changedPrefix));
    await undo();
    assert.equal(await evaluate("editor.getSource()"), changedPrefix + body);
    assert.match(await evaluate("document.querySelector('.notes-metadata-source').value"), /Updated/);
    await evaluate(`window.beforeAppearance = {
      editor: document.querySelector('.ProseMirror'),
      metadata: document.querySelector('.notes-metadata-source'),
      anchor: getSelection().anchorNode, offset: getSelection().anchorOffset,
      source: editor.getSource(), changes: changes.length,
    }; void 0`);
    await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await evaluate("applyAppearance({theme:'light',latinFont:'Georgia',cjkFont:'Microsoft YaHei'})");
    assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(255, 255, 255)");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.notes-code-keyword')).color"), "rgb(152, 81, 153)");
    assert.equal(await evaluate("document.documentElement.dataset.theme"), "light");
    assert.equal(await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--font-latin').trim()"), '"Georgia"');
    assert.match(await evaluate("getComputedStyle(document.querySelector('.notes-live-page')).fontFamily"), /Notes Local CJK.*Georgia/);
    assert.doesNotMatch(await evaluate("getComputedStyle(document.querySelector('.notes-prose code')).fontFamily"), /Georgia/);
    assert.ok(await evaluate("[...document.fonts].some(face => face.family.includes('Notes Local CJK') && face.unicodeRange.includes('U+4E00-9FFF'))"));
    await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await evaluate("applyAppearance({theme:'dark',latinFont:'Georgia',cjkFont:'Microsoft YaHei'})");
    assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(39, 39, 39)");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.notes-code-keyword')).color"), "rgb(200, 148, 208)");
    assert.equal((await evaluate("applyAppearance({theme:'dark',latinFont:'Georgia',cjkFont:'Microsoft YaHei'})")).changed, false);
    await evaluate("applyAppearance({theme:'system',latinFont:'Georgia',cjkFont:'Microsoft YaHei'})");
    assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(255, 255, 255)");
    await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(39, 39, 39)");
    await command("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    assert.equal(await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()"), "Canvas");
    await command("Emulation.setEmulatedMedia", { features: [] });
    assert.equal(await evaluate("document.querySelector('.ProseMirror') === beforeAppearance.editor"), true);
    assert.equal(await evaluate("document.querySelector('.notes-metadata-source') === beforeAppearance.metadata"), true);
    assert.equal(await evaluate("getSelection().anchorNode === beforeAppearance.anchor && getSelection().anchorOffset === beforeAppearance.offset"), true);
    assert.equal(await evaluate("editor.getSource() === beforeAppearance.source && changes.length === beforeAppearance.changes"), true);
    assert.equal(await evaluate("(() => {try {applyAppearance({theme:'invalid',latinFont:'Arial',cjkFont:'宋体'});return false;} catch {return true;}})()"), true);
    assert.equal((await evaluate("applyAppearance({theme:'system',latinFont:'sans-serif',cjkFont:'sans-serif'})")).warning, "");
    assert.equal(await evaluate("document.documentElement.style.getPropertyValue('--font-latin')"), "sans-serif");
    assert.doesNotMatch(await evaluate("document.documentElement.style.getPropertyValue('--code-font')"), /sans-serif/);
    assert.equal(await evaluate("editor.getSource() === beforeAppearance.source"), true);
    await evaluate("applyAppearance({theme:'system',latinFont:'Segoe UI',cjkFont:'Microsoft YaHei'})");
    if (process.env.NOTES_EDITOR_SCREENSHOT === "1") {
      const clip = await evaluate(`(() => {
        const rect = document.querySelector('.notes-metadata').getBoundingClientRect();
        return { x: rect.left - 16, y: rect.top - 12, width: rect.width + 32, height: rect.height + 24, scale: 1 };
      })()`);
      const image = await command("Page.captureScreenshot", { format: "png", clip });
      await writeFile(path.join(webRoot, "..", "build", "editor-metadata-polish-check.png"), Buffer.from(image.data, "base64"));
    }
    await evaluate("document.querySelector('.notes-task-item input').click()");
    assert.match(await evaluate("changes.at(-1)"), /[-*] \[x\] A task/);
    assert.ok((await evaluate("changes.at(-1)")).startsWith(changedPrefix));
    assert.match(await evaluate("changes.at(-1)"), /!\[Local\]\(\.\.\/images\/a\.png\)/);
    await evaluate("document.querySelector('.ProseMirror a').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))");
    assert.deepEqual(await evaluate("links"), ["/?file=next.md#hello"]);
    const tableText = await evaluate("editor.getSource()");
    await evaluate(`editor.select(${tableText.indexOf("| x |") + 2})`);
    await type("new");
    assert.equal(await evaluate("document.querySelectorAll('.ProseMirror table').length"), 1);
    assert.match(await evaluate("document.querySelector('.ProseMirror table').textContent"), /newx/);
    assert.ok((await evaluate("editor.getSource()")).startsWith(changedPrefix));
    const listText = await evaluate("editor.getSource()");
    await evaluate(`editor.select(${listText.indexOf("Other") + 2})`);
    await type("X");
    assert.match(await evaluate("document.querySelector('.ProseMirror ul').textContent"), /OtXher/);
    assert.equal(await evaluate("document.querySelectorAll('.ProseMirror li').length"), 2);

    const invalid = "---\ntitle: [broken\n---\n\n# Body\n";
    await evaluate(`editor.load(${JSON.stringify(invalid)}, "invalid.md")`);
    assert.equal(await evaluate("document.querySelector('.notes-metadata-warning').hidden"), false);
    assert.match(await evaluate("document.querySelector('.notes-metadata-warning').textContent"), /Invalid YAML/);
    assert.equal(await evaluate("document.querySelector('.ProseMirror h1').textContent"), "Body");
    assert.equal(await evaluate("editor.getSource()"), invalid);
    await evaluate("editor.load('---\\n- a\\n- b\\n...\\n\\n# Body\\n', 'sequence.md')");
    assert.match(await evaluate("document.querySelector('.notes-metadata-warning').textContent"), /mapping/);
    assert.equal(await evaluate("document.querySelector('.ProseMirror h1').textContent"), "Body");
    assert.deepEqual(await evaluate("fallbacks"), []);
    await evaluate(`(async () => {
      const loading = editor.load(${JSON.stringify(source)}, 'pending.md');
      const input = document.querySelector('.notes-metadata-source');
      input.value = input.value.replace('Guide', 'Pending');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await loading;
    })()`);
    assert.equal(await evaluate("editor.getSource()"), source.replace("Guide", "Pending"));
    await evaluate("Promise.all([editor.load('# Stale', 'stale.md'), editor.load('# Latest', 'latest.md')])");
    assert.equal(await evaluate("document.querySelector('.ProseMirror h1').textContent"), "Latest");
    assert.equal(await evaluate("document.querySelectorAll('.notes-metadata').length"), 0);
    await evaluate("editor.load('', 'shortcut.md');");
    await evaluate("editor.focus()");
    await type("# ");
    await type("Typed heading");
    assert.equal(await evaluate("document.querySelector('.ProseMirror h1').textContent"), "Typed heading");
    await evaluate("editor.load('', 'typing.md');");
    await evaluate("editor.focus()");
    await type("输入");
    assert.match(await evaluate("editor.getSource()"), /输入/);
    await undo();
    assert.equal(await evaluate("editor.getSource()"), "");
    await command("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
    await type("中文");
    assert.match(await evaluate("editor.getSource()"), /中文/);

    const collisions = "---\ntitle: metadata\n---\n\n# Hello\n\n# Hello\n\n# hello-2\n\n# !!!";
    await evaluate(`editor.load(${JSON.stringify(collisions)}, 'outline.md')`);
    assert.deepEqual(await evaluate("outlines.at(-1).map(item=>item.id)"), ["hello", "hello-2", "hello-2-2", "section"]);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.ProseMirror h1')].map(item=>item.id)"), ["hello", "hello-2", "hello-2-2", "section"]);
    assert.equal(await evaluate("editor.jumpTo('hello-2-2')"), true);
    assert.equal(await evaluate("editor.getSource()"), collisions);
    assert.equal(await evaluate("editor.jumpTo('missing')"), false);
    await evaluate("editor.load('[Reference][id]\\n\\n[id]: ../next.md\\n', 'Folder/reference.md')");
    assert.deepEqual(await evaluate("fallbacks"), []);
    assert.equal(await evaluate("document.querySelector('.ProseMirror a').getAttribute('href')"), "/?file=next.md");
    const html = "---\ntitle: safe\n---\n\n<div id=\"executed\">HTML</div><script>window.executed=true</script>";
    await evaluate(`editor.load(${JSON.stringify(html)}, 'html.md')`);
    assert.equal(await evaluate("editor.getSource()"), html);
    assert.match(await evaluate("fallbacks.at(-1)"), /raw HTML/);
    assert.equal(await evaluate("Boolean(window.executed || document.querySelector('#executed'))"), false);
    await evaluate("editor.load('[Unsafe](javascript:alert(1))\\n\\n![Remote](https://example.com/tracker.png)', 'unsafe.md')");
    assert.equal(await evaluate("document.querySelector('.ProseMirror a').hasAttribute('href')"), false);
    assert.equal(await evaluate("document.querySelectorAll('.ProseMirror img[src]').length"), 0);
    await evaluate("(async () => {const pending = editor.load('# Canceled', 'canceled.md'); editor.clear(); await pending;})()");
    assert.equal(await evaluate("document.querySelectorAll('.ProseMirror').length"), 0);
    assert.deepEqual(await evaluate("cspViolations"), []);
    assert.deepEqual(errors, []);
    await command("Browser.close").catch(() => {});
  } finally {
    socket?.close();
    if (processHandle.exitCode === null) processHandle.kill();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
