import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const limit = 600;
const sourceRoots = [
  "apps",
  "crates",
  "scripts",
  "web/editor",
  "web/frontend",
  "web/public",
  "web/tests",
];
const extensions = new Set([".rs", ".swift", ".mjs", ".js", ".css", ".html"]);
const generated = new Set([
  "web/public/app.mjs",
  "web/public/styles.css",
  "web/public/editor.bundle.mjs",
  "web/public/editor.bundle.css",
]);
const ignoredDirectories = new Set([
  ".git", "build", "dist", "node_modules", "target", "test-results",
]);

async function collect(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(absolute, files);
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(absolute);
    }
  }
}

function countLines(source) {
  if (!source) return 0;
  const lines = source.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

const files = [];
for (const directory of sourceRoots) {
  await collect(path.join(root, directory), files);
}

const violations = [];
for (const absolute of files) {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (generated.has(relative)) continue;
  const lines = countLines(await readFile(absolute, "utf8"));
  if (lines > limit) violations.push({ relative, lines });
}

if (violations.length) {
  violations.sort((left, right) => right.lines - left.lines);
  console.error(`Handwritten source files must not exceed ${limit} lines:`);
  for (const violation of violations) {
    console.error(`  ${violation.lines.toString().padStart(4)}  ${violation.relative}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Source line limit passed (${limit} lines maximum).`);
}
