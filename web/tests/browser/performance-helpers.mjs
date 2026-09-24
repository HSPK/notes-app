import { readdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

export async function addPermissionOverrides(library, count) {
  if (!Number.isInteger(count) || count < 0 || count > 5000) {
    throw new Error("NOTES_BENCH_ACL must be an integer from 0 through 5000.");
  }
  if (!count) return;
  const directory = path.dirname(library.notes);
  const catalogs = (await readdir(directory)).filter((name) => /^projects-.*\.json$/.test(name));
  if (catalogs.length !== 1) throw new Error("Expected one isolated project catalog.");
  const filename = path.join(directory, catalogs[0]);
  const catalog = JSON.parse(await readFile(filename, "utf8"));
  for (let index = 0; index < count; index += 1) {
    catalog.projects.default.pages[`acl/hidden-${String(index).padStart(4, "0")}.md`] = "private";
  }
  const temporary = `${filename}.benchmark`;
  await writeFile(temporary, JSON.stringify(catalog), { mode: 0o600 });
  await rename(temporary, filename);
}

export function summarizeTimings(timings) {
  return Object.fromEntries(Object.entries(timings).map(([name, values]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return [name, {
      runs: values.length,
      medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
      p95Ms: Number(sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2)),
    }];
  }));
}

export function measureClickFrame(page, selector, readySelector, observe = "body") {
  return page.evaluate(({ selector, readySelector, observe }) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Timed out: ${selector}`)); }, 30_000);
    const finish = () => {
      const node = document.querySelector(readySelector);
      if (!node || !node.getClientRects().length || node.closest("[hidden]")) return;
      observer.disconnect();
      clearTimeout(timeout);
      requestAnimationFrame(() => setTimeout(() => resolve({
        feedbackMs: performance.now() - started,
        requests: performance.getEntriesByType("resource")
          .filter((entry) => new URL(entry.name).pathname.startsWith("/api/"))
          .map((entry) => ({ path: new URL(entry.name).pathname, ms: entry.duration })),
      }), 0));
    };
    const observer = new MutationObserver(finish);
    observer.observe(document.querySelector(observe), { subtree: true, attributes: true, childList: true });
    performance.clearResourceTimings();
    const started = performance.now();
    document.querySelector(selector).click();
    if (observe === "body") finish();
  }), { selector, readySelector, observe });
}
