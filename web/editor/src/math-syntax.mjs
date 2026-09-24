export function remarkDisplayMath() {
  return (tree, file) => {
    const source = String(file.value ?? "");
    const transform = (parent) => {
      if (!Array.isArray(parent.children)) return;
      parent.children = parent.children.map((node) => {
        if (node.type === "paragraph" && node.children?.length === 1
            && node.children[0].type === "inlineMath" && node.position) {
          const raw = source.slice(node.position.start.offset, node.position.end.offset).trim();
          if (raw.startsWith("$$") && raw.endsWith("$$") && raw.length >= 4) {
            return { type: "math", value: raw.slice(2, -2), position: node.position };
          }
        }
        transform(node);
        return node;
      });
    };
    transform(tree);
  };
}
