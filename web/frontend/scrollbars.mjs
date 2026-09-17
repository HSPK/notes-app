import { OverlayScrollbars } from "overlayscrollbars";
import "./scrollbars.css";

export function attachScrollbars(host, viewport, { nonce, horizontal = true } = {}) {
  OverlayScrollbars.nonce(nonce ?? document.querySelector('meta[name="notes-style-nonce"]')?.content);
  const contrast = window.matchMedia("(forced-colors: active)");
  const instance = OverlayScrollbars({
    target: host,
    elements: { viewport, padding: false, content: false },
  }, {
    overflow: { x: horizontal ? "scroll" : "hidden", y: "scroll" },
    scrollbars: {
      theme: "os-theme-notes",
      visibility: "auto",
      autoHide: contrast.matches ? "never" : "move",
      autoHideDelay: 750,
      autoHideSuspend: false,
      dragScroll: true,
      clickScroll: "instant",
    },
  });
  const update = () => instance.update();
  const updateContrast = () => instance.options({
    scrollbars: { autoHide: contrast.matches ? "never" : "move" },
  });
  viewport.addEventListener("input", update);
  contrast.addEventListener("change", updateContrast);
  return {
    update,
    destroy() {
      viewport.removeEventListener("input", update);
      contrast.removeEventListener("change", updateContrast);
      instance.destroy();
    },
  };
}
