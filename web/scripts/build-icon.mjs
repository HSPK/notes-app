import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.dirname(webRoot);
const shared = path.join(root, "Shared", "Resources");
const svg = await readFile(path.join(shared, "NotesIcon.svg"), "utf8");
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 1024];
const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 560 }, deviceScaleFactor: 1 });
  const frames = await page.evaluate(async ({ svg, sizes }) => {
    const image = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      image.src = url;
      await image.decode();
      const master = document.createElement("canvas");
      master.width = master.height = 1024;
      master.getContext("2d").drawImage(image, 0, 0, 1024, 1024);
      return sizes.map((size) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const context = canvas.getContext("2d");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(master, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        let monochrome = true;
        let darkest = 255;
        let lightest = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 128) {
            monochrome &&= Math.max(pixels[index], pixels[index + 1], pixels[index + 2])
              - Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) <= 2;
            darkest = Math.min(darkest, pixels[index]);
            lightest = Math.max(lightest, pixels[index]);
          }
        }
        return {
          size,
          png: canvas.toDataURL("image/png").split(",")[1],
          cornerAlpha: pixels[3],
          centerAlpha: pixels[((size / 2) * size + size / 2) * 4 + 3],
          monochrome,
          contrast: lightest - darkest,
        };
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }, { svg, sizes });

  for (const frame of frames) {
    assert.equal(frame.cornerAlpha, 0, `${frame.size}px must have transparent corners`);
    assert.equal(frame.centerAlpha, 255, `${frame.size}px must be opaque in the center`);
    assert.ok(frame.monochrome, `${frame.size}px must remain strictly monochrome`);
    assert.ok(frame.contrast > 140, `${frame.size}px must retain distinct light and dark layers`);
  }
  await writeFile(path.join(shared, "NotesIcon.png"), Buffer.from(frames.at(-1).png, "base64"));
  const icons = frames.filter((frame) => frame.size <= 256);
  const directory = Buffer.alloc(6 + 16 * icons.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(icons.length, 4);
  let offset = directory.length;
  const images = icons.map((frame, index) => {
    const png = Buffer.from(frame.png, "base64");
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = frame.size === 256 ? 0 : frame.size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
    return png;
  });
  await writeFile(path.join(shared, "Notes.ico"), Buffer.concat([directory, ...images]));

  const source = (size) => `data:image/png;base64,${frames.find((frame) => frame.size === size).png}`;
  const samples = () => [16, 24, 32, 48, 64].map((size) =>
    `<div class="sample"><img src="${source(size)}" width="${size}" height="${size}" alt="${size} pixel icon"><span>${size}px</span></div>`,
  ).join("");
  await page.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box; }
    body { margin: 0; font: 13px "Segoe UI", sans-serif; background: #f4f4f2; color: #373a38; }
    header { height: 96px; padding: 28px 36px; }
    h1 { margin: 0 0 5px; font-size: 22px; font-weight: 600; }
    header p { margin: 0; color: #777; }
    main { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 0 24px; }
    section { height: 390px; background: white; border-radius: 16px; padding: 24px; text-align: center; }
    section.dark { background: #25272b; color: #d6d7d8; }
    h2 { margin: 0; font-size: 10px; letter-spacing: 2px; font-weight: 500; opacity: .65; text-align: left; }
    .hero { width: 200px; height: 200px; margin: 14px 0; }
    .sizes { display: flex; gap: 20px; align-items: end; justify-content: center; }
    .sample { display: flex; align-items: center; flex-direction: column; gap: 8px; }
    .sample span { font-size: 10px; opacity: .6; }
    footer { padding: 23px 36px; font-size: 11px; color: #777; }
  </style></head><body>
    <header><h1>Notes · Layered N</h1><p>Black and white. A single abstract mark, with quiet depth.</p></header>
    <main><section><h2>LIGHT BACKGROUND</h2><img class="hero" src="${source(1024)}" alt="Notes icon"><div class="sizes">${samples()}</div></section>
    <section class="dark"><h2>DARK BACKGROUND</h2><img class="hero" src="${source(1024)}" alt="Notes icon"><div class="sizes">${samples()}</div></section></main>
    <footer>Original vector artwork · Transparent PNG · Nine Windows icon sizes · No Python dependency</footer>
  </body></html>`);
  await page.locator("img").evaluateAll(async (images) => Promise.all(images.map((image) => image.decode())));
  await mkdir(path.join(root, "build"), { recursive: true });
  await page.screenshot({ path: path.join(root, "build", "icon-preview.png") });
  console.log(`Generated NotesIcon.png (1024px), Notes.ico (${icons.map((frame) => frame.size).join(", ")}px), and build\\icon-preview.png.`);
} finally {
  await browser.close();
}
