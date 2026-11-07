/** Verificação visual do motor: gera quadros de referência de três famílias. */
import path from "node:path";
import { demoScene } from "../render/demo.js";
import { renderStill, closeBrowser, renderScene } from "../render/renderer.js";
const out = process.argv[2] ?? "engine-check";
for (const fam of [{ renderFamily: "cel", palette: ["#14213d", "#1f3b57", "#e9c46a", "#f4a261", "#e76f51"] }, { renderFamily: "aquarela", palette: ["#f1e9da", "#9fb4c4", "#5f7486", "#c8442a", "#8ea860"] }, { renderFamily: "cinema-mudo", palette: ["#222", "#888", "#ddd"] }]) {
  const sc = demoScene(fam);
  for (const f of [30, 80, 125]) await renderStill(sc, f, path.join(out, `${fam.renderFamily}_${f}.jpg`));
}
const t = Date.now();
await renderScene(demoScene({ renderFamily: "cel", palette: [] }), path.join(out, "cel.mp4"));
console.log("mp4 144 quadros em", ((Date.now() - t) / 1000).toFixed(1), "s");
await closeBrowser();
