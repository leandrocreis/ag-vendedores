import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "../paths.js";
import { sha256 } from "../util.js";
import { renderScene, type EngineScene } from "./renderer.js";
import type { StyleRecord } from "../catalog/catalog.js";

/**
 * "Demonstração local gerada": 6 s sem som renderizados pelo NOSSO motor com a família e a paleta
 * extraída do estilo. É rotulada como demo local — não é o filme oficial do estilo.
 */
export function demoScene(style: Pick<StyleRecord, "renderFamily" | "palette">, vertical = false): EngineScene {
  const w = vertical ? 540 : 960, h = vertical ? 960 : 540;
  return {
    w, h, fps: { num: 24, den: 1 }, frameStart: 0, frameCount: 144, style: { family: style.renderFamily, palette: style.palette },
    burnSubtitles: false, subtitles: [],
    shots: [
      { t0: 0, t1: 2.2, setPiece: "acampamento", camera: { move: "push-in", shot: "geral", intensity: 0.8 }, actors: [{ id: "p", kind: "pessoa", action: "look", x: 0.42, facing: "dir" }], props: ["barraca", "fogueira"], fx: ["brasas"], light: "fogueira", transitionIn: "escuro", caption: null, layers: [] },
      { t0: 2.2, t1: 4.2, setPiece: "floresta", camera: { move: "travelling", shot: "medio", intensity: 0.7 }, actors: [{ id: "p", kind: "pessoa", action: "run", x: 0.35, facing: "dir" }, { id: "z", kind: "zumbi", action: "lurch", x: 0.12, facing: "dir" }], props: [], fx: ["neblina"], light: "noite", transitionIn: "whip", caption: null, layers: [] },
      { t0: 4.2, t1: 6.0, setPiece: "estrada", camera: { move: "tremor", shot: "close", intensity: 0.5 }, actors: [{ id: "p", kind: "pessoa", action: "flashlight", x: 0.4, facing: "dir" }], props: ["carro"], fx: ["olhos"], light: "lanterna", transitionIn: "corte", caption: null, layers: [] },
    ],
  };
}

export async function ensureStyleDemo(style: StyleRecord & { hash?: string }) {
  const key = sha256(JSON.stringify([style.id, style.renderFamily, style.palette, fs.statSync(new URL("../../engine/engine.js", import.meta.url)).mtimeMs])).slice(0, 16);
  const out = path.join(CACHE_DIR, "demos", `${style.id.replace(/[^a-z0-9]+/gi, "_")}_${key}.mp4`);
  if (fs.existsSync(out)) return out;
  await renderScene(demoScene(style), out, { crf: 24, jpegQuality: 85 });
  return out;
}
