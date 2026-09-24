import { startEditorBenchmark, statistics } from "./browser-harness.mjs";

const runCount = 10;
const prepareCount = 200;
const targetBytes = 512 * 1024;
const prefix = "# Source prepare benchmark\n\n";
const line = "A paragraph with English and 中文 text for UTF-8 sizing.\n";
const repetitions = Math.ceil((targetBytes - Buffer.byteLength(prefix)) / Buffer.byteLength(line));
const source = prefix + line.repeat(repetitions);

const harness = `
  import { createSourceEditor } from "/editor.bundle.mjs";
  const root = document.querySelector("#root");
  const textarea = document.createElement("textarea");
  root.append(textarea);
  const editor = createSourceEditor({
    textarea,
    nonce: document.querySelector('meta[name="notes-style-nonce"]').content,
  });
  window.benchmarkSourcePrepare = (source, count) => {
    editor.reset(source);
    const started = performance.now();
    for (let index = 0; index < count; index += 1) editor.prepare();
    return {
      duration: performance.now() - started,
      virtual: editor.isVirtual(),
      length: editor.value.length,
    };
  };
  window.benchmarkReady = true;
`;

const environment = await startEditorBenchmark(harness);
const runs = [];
try {
  const page = await environment.browser.newPage();
  try {
    await page.goto(environment.origin);
    await page.waitForFunction(() => window.benchmarkReady === true);
    for (let index = 0; index < runCount + 1; index += 1) {
      const result = await page.evaluate(
        ({ source, count }) => window.benchmarkSourcePrepare(source, count),
        { source, count: prepareCount },
      );
      if (result.virtual) throw new Error("A 512 KiB source unexpectedly enabled CodeMirror.");
      if (result.length !== source.length) throw new Error("Source preparation changed the document.");
      if (index) runs.push(result.duration);
    }
  } finally {
    await page.close();
  }
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(source),
    prepares: prepareCount,
    total: statistics(runs),
    perPrepareMedianMs: Number((statistics(runs).medianMs / prepareCount).toFixed(4)),
  }, null, 2));
} finally {
  await environment.close();
}
