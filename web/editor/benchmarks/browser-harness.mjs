import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(packageRoot, "dist");

export function statistics(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    runsMs: values.map((value) => Number(value.toFixed(2))),
    medianMs: Number(median.toFixed(2)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)),
  };
}

export async function startEditorBenchmark(harness) {
  const server = createServer(async (request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-notes-editor-benchmark'; "
        + "style-src-attr 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:",
    );
    try {
      if (request.url === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<!doctype html><meta name="notes-style-nonce" content="notes-editor-benchmark">'
            + '<link rel="stylesheet" href="/editor.bundle.css">'
            + '<style nonce="notes-editor-benchmark">html,body,#root{height:100%;margin:0}</style>'
            + '<div id="root"></div><script type="module" src="/benchmark.mjs"></script>',
        );
      } else if (request.url === "/benchmark.mjs") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(harness);
      } else if ([
        "/editor.bundle.mjs",
        "/editor.bundle.css",
        "/editor-helpers.mjs",
      ].includes(request.url)) {
        response.setHeader(
          "Content-Type",
          request.url.endsWith(".css") ? "text/css" : "text/javascript",
        );
        response.end(await readFile(path.join(publicRoot, request.url.slice(1))));
      } else {
        response.writeHead(404).end();
      }
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    browser,
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await browser.close();
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
