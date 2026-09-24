import { performance } from "node:perf_hooks";

import { createHiddenPathMatcher } from "../public/model.mjs";

const pathCount = 10_000;
const runCount = 8;
const patterns = [
  ...Array.from({ length: 50 }, (_, index) => `archive-${index}`),
  ...Array.from({ length: 25 }, (_, index) => `group-${index}/**/draft-*`),
  ...Array.from({ length: 25 }, (_, index) => `*.private-${index}.md`),
];
const paths = Array.from({ length: pathCount }, (_, index) => {
  const group = index % 50;
  const folder = index % 5 === 0 ? `archive-${group}` : `active-${group}`;
  const draft = index % 11 === 0 ? `draft-${index}` : `note-${index}`;
  const file = index % 7 === 0
    ? `${draft}.private-${index % 25}.md`
    : `${draft}.md`;
  return `group-${group}/level-a/level-b/level-c/${folder}/nested/deep/${file}`;
});
const hidden = createHiddenPathMatcher(patterns);

function measure() {
  const started = performance.now();
  let matches = 0;
  for (const path of paths) if (hidden(path)) matches += 1;
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
  if (result.matches !== matches) throw new Error("Visibility results changed between runs.");
}
if (!matches || matches === pathCount) {
  throw new Error(`Expected a mixed visibility result, received ${matches}/${pathCount}.`);
}
const sorted = [...runs].sort((left, right) => left - right);
console.log(JSON.stringify({
  paths: pathCount,
  patterns: patterns.length,
  depth: paths[0].split("/").length,
  matches,
  runsMs: runs.map((value) => Number(value.toFixed(2))),
  medianMs: Number(((sorted[3] + sorted[4]) / 2).toFixed(2)),
  p95Ms: Number(sorted.at(-1).toFixed(2)),
}, null, 2));
