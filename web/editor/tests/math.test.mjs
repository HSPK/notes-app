import test from "node:test";
import assert from "node:assert/strict";

import { remarkDisplayMath } from "../src/math-syntax.mjs";

test("single-line double-dollar paragraphs become display math", () => {
  const source = "Before\n\n$$x^2 + y^2$$\n";
  const start = source.indexOf("$$");
  const tree = {
    type: "root",
    children: [{
      type: "paragraph",
      children: [{ type: "inlineMath", value: "x^2 + y^2" }],
      position: {
        start: { offset: start },
        end: { offset: source.length - 1 },
      },
    }],
  };
  remarkDisplayMath()(tree, { value: source });
  assert.equal(tree.children[0].type, "math");
  assert.equal(tree.children[0].value, "x^2 + y^2");
});
