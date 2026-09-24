import { performance } from "node:perf_hooks";

import {
  createDocumentModel,
  isDirty,
  markdownByteLength,
  normalizeEditorText,
  serializeEditorText,
} from "../public/model.mjs";

const runCount = 8;
let lf = "# Serialization benchmark\n\n";
for (let index = 0; Buffer.byteLength(lf) < 1024 * 1024; index += 1) {
  lf += `Line ${index} with UTF-8 中文 content and several words.\n`;
}
const mixed = lf.split("\n").map((line, index, lines) =>
  index === lines.length - 1 ? line : line + (index % 2 ? "\r\n" : "\n")).join("");

function statistics(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    runsMs: values.map((value) => Number(value.toFixed(2))),
    medianMs: Number(((sorted[3] + sorted[4]) / 2).toFixed(2)),
    p95Ms: Number(sorted.at(-1).toFixed(2)),
  };
}

function benchmark(raw) {
  const document = createDocumentModel({
    path: "large.md",
    content: raw,
    html: "",
    version: "0".repeat(64),
  });
  const edited = document.text.replace("# Serialization", "# Updated");
  const runs = [];
  let serialized;
  for (let index = 0; index < runCount; index += 1) {
    const started = performance.now();
    if (!isDirty(document, edited)) throw new Error("The edited document was not dirty.");
    serialized = serializeEditorText(document, edited);
    markdownByteLength(serialized);
    runs.push(performance.now() - started);
  }
  if (normalizeEditorText(serialized) !== edited) {
    throw new Error("Serialization changed normalized editor text.");
  }
  return statistics(runs);
}

console.log(JSON.stringify({
  lfBytes: Buffer.byteLength(lf),
  mixedBytes: Buffer.byteLength(mixed),
  lf: benchmark(lf),
  mixed: benchmark(mixed),
}, null, 2));
