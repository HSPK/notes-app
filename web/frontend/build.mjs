import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildEditor } from "../editor/build.mjs";

const appParts = (await readdir("frontend/app"))
  .filter((name) => name.endsWith(".mjs"))
  .sort();
const appSource = await Promise.all(
  appParts.map((name) => readFile(path.join("frontend/app", name), "utf8")),
);
await writeFile(
  "public/app.mjs",
  `// Generated from frontend/app/*.mjs by npm run build.\n${appSource.join("\n")}`,
);

const styles = await Promise.all(
  ["app.css", "controls.css"].map(name => readFile(path.join("frontend/styles", name), "utf8")),
);
await writeFile("public/styles.css", `/* Generated from frontend/styles/*.css by npm run build. */\n${styles.join("\n")}`);

const editorOutput = await buildEditor();
for (const name of [
  "editor.bundle.mjs",
  "editor.bundle.css",
  "editor-helpers.mjs",
  "THIRD-PARTY-LICENSES.txt",
]) {
  await copyFile(path.join(editorOutput, name), path.join("public", name));
}
