import { performance } from "node:perf_hooks";

import { filterNotes } from "../public/model.mjs";

const fileCount = 10_000;
const runCount = 8;
const files = Array.from({ length: fileCount }, (_, index) => {
  const name = `Note-${String(index).padStart(5, "0")}.md`;
  return {
    path: `Group-${index % 100}/Projects/2026/${name}`,
    name,
    title: index % 4 === 0 ? `Quarterly roadmap ${index}` : null,
  };
});
const queries = [
  "n", "no", "note", "note-0", "note-09", "group-42",
  "projects", "2026", "roadmap", "9999", "missing", "quarterly roadmap 8000",
];

function measure() {
  const started = performance.now();
  let matches = 0;
  for (const query of queries) matches += filterNotes(files, query).length;
  return { duration: performance.now() - started, matches };
}

measure();
measure();
const runs = [];
let matches;
for (let index = 0; index < runCount; index += 1) {
  const result = measure();
  runs.push(result.duration);
  matches ??= result.matches;
  if (result.matches !== matches) throw new Error("File search results changed between runs.");
}
if (!matches) throw new Error("File search returned no benchmark matches.");
const sorted = [...runs].sort((left, right) => left - right);
console.log(JSON.stringify({
  files: fileCount,
  queries: queries.length,
  matches,
  runsMs: runs.map((value) => Number(value.toFixed(2))),
  medianMs: Number(((sorted[3] + sorted[4]) / 2).toFixed(2)),
  p95Ms: Number(sorted.at(-1).toFixed(2)),
}, null, 2));
