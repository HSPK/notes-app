import { spawn } from "node:child_process";
import { fixtureResourceId } from "./resource-fixture.mjs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(webRoot, "..");
const executable = process.env.NOTES_TEST_EXE
  ?? path.join(repository, "target", "debug", process.platform === "win32" ? "notes-core.exe" : "notes-core");
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-document-benchmark-"));
const notes = path.join(temporary, "notes");
const ready = path.join(temporary, "ready.json");
const stop = path.join(temporary, "stop");
const runCount = 8;
await mkdir(notes);
let body = "# Large document\n\n";
for (let index = 0; Buffer.byteLength(body) < 1024 * 1024; index += 1) {
  body += `## Heading ${index}\n\nParagraph with **bold**, [link](other.md), and \`code_${index}\`.\n\n`;
}
const documentPath = path.join(notes, "large.md");
await writeFile(documentPath, body);
const service = spawn(executable, [
  "--serve", notes, "--port", "0", "--ready-file", ready, "--stop-file", stop,
  "--auth-mode", "token",
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let diagnostics = "";
service.stderr.on("data", (data) => { diagnostics += data; });

function statistics(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    runsMs: values.map((value) => Number(value.toFixed(2))),
    medianMs: Number(((sorted[3] + sorted[4]) / 2).toFixed(2)),
    p95Ms: Number(sorted.at(-1).toFixed(2)),
  };
}

try {
  let launchUrl;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      launchUrl = JSON.parse(await readFile(ready, "utf8")).url;
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!launchUrl) throw new Error(`Notes did not start: ${diagnostics}`);
  const token = new URL(launchUrl).hash.match(/(?:^#|&)token=([a-f0-9]+)/i)?.[1];
  if (!token) throw new Error("Notes did not expose a launch token.");
  const id = await fixtureResourceId(launchUrl, "large.md");
  const url = new URL(`/api/document?id=${id}`, launchUrl);
  const request = async () => {
    const started = performance.now();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const headers = performance.now();
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    const payload = await response.json();
    if (payload.content.length < 1024 * 1024 || !payload.html.includes("<h2")) {
      throw new Error("The service returned an incomplete document.");
    }
    return { ttfb: headers - started, total: performance.now() - started };
  };
  await request();
  await request();
  const unchanged = [];
  const changed = [];
  for (let index = 0; index < runCount; index += 1) {
    unchanged.push(await request());
    const replacement = index % 2 ? "A" : "B";
    await writeFile(documentPath, replacement + body.slice(1));
    changed.push(await request());
  }
  const summarize = (runs) => ({
    ttfb: statistics(runs.map((run) => run.ttfb)),
    total: statistics(runs.map((run) => run.total)),
  });
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(body),
    unchanged: summarize(unchanged),
    changed: summarize(changed),
  }, null, 2));
} finally {
  if (service.exitCode === null) {
    await writeFile(stop, "");
    for (let attempt = 0; attempt < 100 && service.exitCode === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (service.exitCode === null) service.kill();
  }
  await rm(temporary, { recursive: true, force: true });
}
