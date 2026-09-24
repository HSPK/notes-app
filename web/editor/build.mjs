import { build } from "esbuild";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(packageRoot, "src");
const defaultOutput = path.join(packageRoot, "dist");
const licenseFallbacks = {
  "overlayscrollbars@2.16.0": path.join(packageRoot, "licenses/overlayscrollbars-2.16.0.txt"),
  "remark-math@6.0.0": path.join(packageRoot, "licenses/remark-math-6.0.0.txt"),
};

function dependencyDirectory(input) {
  const parts = path.resolve(input).split(path.sep);
  const index = parts.lastIndexOf("node_modules");
  if (index < 0 || !parts[index + 1]) return null;
  const end = index + (parts[index + 1].startsWith("@") ? 3 : 2);
  return parts.slice(0, end).join(path.sep);
}

export async function buildEditor(output = defaultOutput) {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const { metafile } = await build({
    entryPoints: [path.join(sourceRoot, "index.mjs")],
    outfile: path.join(output, "editor.bundle.mjs"),
    bundle: true,
    minify: true,
    format: "esm",
    target: ["es2022"],
    legalComments: "eof",
    loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
    metafile: true,
  });
  await copyFile(
    path.join(sourceRoot, "editor-helpers.mjs"),
    path.join(output, "editor-helpers.mjs"),
  );
  const packages = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const directory = dependencyDirectory(input);
    if (directory) packages.add(directory);
  }
  const notices = [
    "Third-party software bundled with @notes-app/editor\n"
      + "Rebuild: npm install && npm run build\n",
  ];
  for (const directory of [...packages].sort()) {
    const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    notices.push(`\n${"=".repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? "See below"}\n`);
    const licenses = (await readdir(directory))
      .filter((name) => /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(name));
    if (!licenses.length) {
      const fallback = licenseFallbacks[`${pkg.name}@${pkg.version}`];
      if (!fallback) throw new Error(`Missing license file for bundled package ${pkg.name}`);
      notices.push(await readFile(fallback, "utf8"));
    }
    for (const name of licenses) {
      notices.push(`${name}\n${await readFile(path.join(directory, name), "utf8")}`);
    }
  }
  await writeFile(path.join(output, "THIRD-PARTY-LICENSES.txt"), notices.join("\n"));
  const cssPath = path.join(output, "editor.bundle.css");
  const css = await readFile(cssPath, "utf8");
  await writeFile(cssPath, css.replace(/[ \t]+$/gm, ""));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildEditor();
}
