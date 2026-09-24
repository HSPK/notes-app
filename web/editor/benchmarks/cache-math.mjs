import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startEditorBenchmark, statistics } from "./browser-harness.mjs";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const runCount = 8;
const formulaCount = 1024;
const formulas = [
  "E=mc^2",
  "\\int_0^1 x^2\\,dx",
  "\\sum_{n=1}^{\\infty} n^{-2}",
  "\\Vert f(x)-y\\Vert_2",
  "\\frac{\\partial L}{\\partial x}",
  "P(A\\mid B)=\\frac{P(B\\mid A)P(A)}{P(B)}",
  "\\mathbf{W}\\mathbf{x}+\\mathbf{b}",
  "\\operatorname{softmax}(z_i)",
];
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createCachedKatexRenderer } from "../src/katex-renderer.mjs";
      const options = {
        throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml",
      };
      const formulas = ${JSON.stringify(formulas)};
      const common = Array.from(
        { length: 40 },
        (_, index) => \`x_{\${index}}^2+y_{\${index}}^2=z_{\${index}}^2\`,
      );
      window.benchmarkCache = (count, mode) => {
        const root = document.querySelector("#root");
        root.replaceChildren();
        const render = createCachedKatexRenderer();
        const started = performance.now();
        for (let index = 0; index < count; index += 1) {
          const output = document.createElement(index % 2 ? "span" : "div");
          root.append(output);
          const mixed = mode === "mixed";
          const cacheable = !mixed || index % 2 === 0;
          const value = mode === "unique"
            ? \`x_{\${index}}^2+y_{\${index}}^2=z_{\${index}}^2\`
            : mixed
              ? cacheable
                ? common[(index / 2) % common.length]
                : \`u_{\${index}}^2+v_{\${index}}^2=w_{\${index}}^2\`
              : formulas[index % formulas.length];
          render(
            value,
            output,
            options,
            mode !== "unique" && cacheable,
          );
        }
        return {
          duration: performance.now() - started,
          rendered: root.querySelectorAll(".katex").length,
        };
      };
      window.benchmarkReady = true;
    `,
    resolveDir: benchmarkRoot,
    sourcefile: "cache-entry.mjs",
  },
  outfile: "benchmark.mjs",
  bundle: true,
  format: "esm",
  target: ["es2022"],
  write: false,
});
const environment = await startEditorBenchmark(outputFiles[0].text);

async function measure(mode, runs) {
  const page = await environment.browser.newPage();
  try {
    await page.goto(environment.origin);
    await page.waitForFunction(() => window.benchmarkReady === true);
    const result = await page.evaluate(
      ({ count, mode }) => window.benchmarkCache(count, mode),
      { count: formulaCount, mode },
    );
    if (result.rendered !== formulaCount) {
      throw new Error(`Expected ${formulaCount} formulas, rendered ${result.rendered}.`);
    }
    if (runs) runs.push(result.duration);
  } finally {
    await page.close();
  }
}

try {
  await measure("repeated");
  const repeatedRuns = [];
  const uniqueRuns = [];
  const mixedRuns = [];
  for (let index = 0; index < runCount; index += 1) {
    await measure("repeated", repeatedRuns);
    await measure("unique", uniqueRuns);
    await measure("mixed", mixedRuns);
  }
  console.log(JSON.stringify({
    formulas: formulaCount,
    repeated: statistics(repeatedRuns),
    unique: statistics(uniqueRuns),
    mixed: statistics(mixedRuns),
  }, null, 2));
} finally {
  await environment.close();
}
