import { performance } from "node:perf_hooks";

import { buildFileTree } from "../public/model.mjs";

const fileCount = 10_000;
const runCount = 20;
const files = Array.from({ length: fileCount }, (_, index) => {
  const group = index % 100;
  const section = Math.floor(index / 100) % 10;
  const path = `group-${group}/section-${section}/level-a/level-b/level-c/level-d`
    + `/note-${String(index).padStart(5, "0")}.md`;
  return {
    path,
    name: path.split("/").at(-1),
    title: index % 7 === 0 ? `Titled note ${index}` : null,
  };
});
const directories = Array.from({ length: 100 }, (_, index) => ({
  path: `group-${index}/section-0/level-a/level-b/empty`,
  name: "empty",
  title: index % 5 === 0 ? `Empty ${index}` : null,
}));

function count(tree) {
  return tree.files.length + tree.directories.reduce(
    (total, directory) => total + count(directory),
    0,
  );
}

function measure() {
  const started = performance.now();
  const tree = buildFileTree(files, directories);
  const duration = performance.now() - started;
  if (count(tree) !== fileCount) throw new Error("The file tree lost entries.");
  if (tree.directories.length !== 100) throw new Error("The file tree lost root directories.");
  return duration;
}

const cold = measure();
measure();
const runs = Array.from({ length: runCount }, measure);
const sorted = [...runs].sort((left, right) => left - right);
const middle = runCount / 2;
console.log(JSON.stringify({
  files: fileCount,
  explicitDirectories: directories.length,
  depth: files[0].path.split("/").length,
  coldMs: Number(cold.toFixed(2)),
  runsMs: runs.map((value) => Number(value.toFixed(2))),
  medianMs: Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2)),
  p95Ms: Number(sorted.at(-1).toFixed(2)),
}, null, 2));
