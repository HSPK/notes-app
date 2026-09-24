import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(webRoot, "..");
const executable = process.env.NOTES_TEST_EXE
  ?? path.join(repository, "target", "debug", process.platform === "win32" ? "notes-core.exe" : "notes-core");
const temporary = await mkdtemp(path.join(os.tmpdir(), "notes-startup-benchmark-"));
const notes = path.join(temporary, "notes");
const authFile = path.join(temporary, "users.json");
await mkdir(notes);
await writeFile(path.join(notes, "note.md"), "# Note\n");

async function measure(mode, index) {
  const ready = path.join(temporary, `${mode}-${index}.ready`);
  const stop = path.join(temporary, `${mode}-${index}.stop`);
  const arguments_ = [
    "--serve", notes, "--port", "0", "--ready-file", ready, "--stop-file", stop,
    "--auth-mode", mode,
  ];
  if (mode === "users") arguments_.push("--auth-file", authFile);
  const started = performance.now();
  const child = spawn(executable, arguments_, {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (data) => { diagnostics += data; });
  let duration;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      await readFile(ready);
      duration = performance.now() - started;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (child.exitCode !== null) throw new Error(diagnostics);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  if (duration === undefined) throw new Error(`Notes did not become ready: ${diagnostics}`);
  await writeFile(stop, "");
  for (let attempt = 0; attempt < 1000 && child.exitCode === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (child.exitCode === null) child.kill();
  return duration;
}

try {
  const result = {};
  for (const mode of ["token", "users"]) {
    const runs = [];
    for (let index = 0; index < 12; index += 1) runs.push(await measure(mode, index));
    const sorted = [...runs].sort((left, right) => left - right);
    result[mode] = {
      runsMs: runs.map((value) => Number(value.toFixed(2))),
      medianMs: Number(((sorted[5] + sorted[6]) / 2).toFixed(2)),
      p95Ms: Number(sorted.at(-1).toFixed(2)),
    };
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
