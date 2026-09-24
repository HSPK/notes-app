import test from "node:test";
import assert from "node:assert/strict";
import { createSharedText } from "../src/shared-text.mjs";

test("shared Markdown merges independent edits with local-only undo and stable Unicode cursors", () => {
  const seed = createSharedText(() => {});
  const aliceUpdates = [];
  const bobUpdates = [];
  const alice = createSharedText((update) => aliceUpdates.push(update));
  const bob = createSharedText((update) => bobUpdates.push(update));
  try {
    seed.replace("---\ntitle: Shared\n---\n\n# 中文😀\n\nAlpha\n\nBeta\n");
    alice.apply(seed.snapshot());
    bob.apply(seed.snapshot());
    const cursor = bob.relative({ from: bob.value.indexOf("Beta"), to: bob.value.indexOf("Beta") });
    alice.replace(alice.value.replace("Alpha", "**Alpha**"));
    bob.replace(bob.value.replace("Beta", "Beta $x^2$"));
    for (const update of aliceUpdates.splice(0)) bob.apply(update);
    for (const update of bobUpdates.splice(0)) alice.apply(update);
    assert.equal(alice.value, bob.value);
    assert.match(alice.value, /\*\*Alpha\*\*[\s\S]*Beta \$x\^2\$/);
    assert.equal(bob.resolve(cursor).to, bob.value.indexOf("Beta"));
    alice.undo();
    for (const update of aliceUpdates.splice(0)) bob.apply(update);
    assert.match(bob.value, /Alpha\n\nBeta \$x\^2\$/);
    alice.redo();
    for (const update of aliceUpdates.splice(0)) bob.apply(update);
    assert.equal(alice.value, bob.value);
    assert.match(bob.value, /\*\*Alpha\*\*/);
  } finally { seed.destroy(); alice.destroy(); bob.destroy(); }
});
