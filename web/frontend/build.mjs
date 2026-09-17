import { build } from "esbuild";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const licenseFallbacks = {
  "overlayscrollbars@2.16.0": "frontend/licenses/overlayscrollbars-2.16.0.txt",
};

await build({
  entryPoints: ["frontend/editor.mjs"],
  outfile: "public/editor.bundle.mjs",
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2022"],
  legalComments: "eof",
  external: ["./editor-helpers.mjs"],
  metafile: true,
}).then(async ({ metafile }) => {
  const packages = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) packages.add(match[1]);
  }
  const notices = ["Third-party software bundled with Notes\nRebuild: npm ci && npm run build (from web)\n"];
  for (const directory of [...packages].sort()) {
    const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    notices.push(`\n${"=".repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? "See below"}\n`);
    const licenses = (await readdir(directory)).filter((name) => /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(name));
    if (!licenses.length) {
      const fallback = licenseFallbacks[`${pkg.name}@${pkg.version}`];
      if (!fallback) throw new Error(`Missing license file for bundled package ${pkg.name}`);
      notices.push(await readFile(fallback, "utf8"));
    }
    for (const name of licenses) notices.push(`${name}\n${await readFile(path.join(directory, name), "utf8")}`);
  }
  await writeFile("public/THIRD-PARTY-LICENSES.txt", notices.join("\n"));
  const cssPath = "public/editor.bundle.css";
  const css = await readFile(cssPath, "utf8");
  await writeFile(cssPath, css.replace(/[ \t]+$/gm, ""));
});
