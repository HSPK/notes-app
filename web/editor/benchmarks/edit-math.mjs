import { startEditorBenchmark, statistics } from "./browser-harness.mjs";

const runCount = 8;
const editCount = 32;
const harness = `
  import { createInlineEditor } from "/editor.bundle.mjs";
  const editor = createInlineEditor({
    root: document.querySelector("#root"),
    onChange() {},
    onFallback(message) { throw new Error(message); },
    onLink() {},
    onOutline() {},
    onSelection() {},
    styleNonce: document.querySelector('meta[name="notes-style-nonce"]').content,
  });
  const frames = () => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.benchmarkMathEdit = async (count) => {
    await editor.load("Formula $x$ tail.\\n", "edit.md");
    await frames();
    const math = document.querySelector('[data-type="math_inline"]');
    const output = math.querySelector(".notes-math-output");
    output.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, cancelable: true, button: 0,
    }));
    const editRuns = [];
    const started = performance.now();
    for (let index = 0; index < count; index += 1) {
      const editStarted = performance.now();
      if (!document.execCommand("insertText", false, String(index % 10))) {
        throw new Error("The browser rejected formula text insertion.");
      }
      await Promise.resolve();
      editRuns.push(performance.now() - editStarted);
    }
    const processedMs = performance.now() - started;
    await frames();
    return {
      editRuns,
      processedMs,
      settledMs: performance.now() - started,
      value: math.dataset.value,
    };
  };
  window.benchmarkReady = true;
`;

const environment = await startEditorBenchmark(harness);
const editRuns = [];
const processedRuns = [];
const settledRuns = [];
try {
  for (let index = 0; index < runCount + 1; index += 1) {
    const page = await environment.browser.newPage();
    try {
      await page.goto(environment.origin);
      await page.waitForFunction(() => window.benchmarkReady === true);
      const result = await page.evaluate((count) => window.benchmarkMathEdit(count), editCount);
      if (result.value.length !== editCount + 1) {
        throw new Error(`Expected ${editCount + 1} TeX characters, received ${result.value.length}.`);
      }
      if (index) {
        editRuns.push(...result.editRuns);
        processedRuns.push(result.processedMs);
        settledRuns.push(result.settledMs);
      }
    } finally {
      await page.close();
    }
  }
  console.log(JSON.stringify({
    edits: editCount,
    perEdit: statistics(editRuns),
    processed: statistics(processedRuns),
    settled: statistics(settledRuns),
  }, null, 2));
} finally {
  await environment.close();
}
