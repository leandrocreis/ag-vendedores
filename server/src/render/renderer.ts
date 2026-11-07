import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { ENGINE_DIR } from "../paths.js";
import { ffprobe } from "../util.js";

/**
 * Renderização quadro a quadro, determinística: o tempo de cada quadro vem do número do quadro e
 * do FPS fracionário (t = n·den/num), nunca do relógio do navegador. O motor roda isolado em
 * file:// com CSP e TODAS as requisições de rede bloqueadas — não alcança o backend nem chaves.
 */
export interface EngineScene {
  w: number; h: number; fps: { num: number; den: number }; frameStart: number; frameCount: number;
  style: { family: string; palette: string[] }; shots: any[]; subtitles: { t0: number; t1: number; text: string }[];
  burnSubtitles: boolean; safeArea?: { bottom: number };
}

let browser: Browser | null = null;
async function getBrowser() {
  if (browser?.isConnected()) return browser;
  const exe = process.env.PLAYWRIGHT_CHROME || undefined;
  browser = await chromium.launch({ executablePath: exe, args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"] });
  return browser;
}
export async function closeBrowser() { await browser?.close().catch(() => {}); browser = null; }

export interface RenderOpts { onProgress?: (done: number, total: number) => void; signal?: AbortSignal; jpegQuality?: number; crf?: number }

export async function renderScene(scene: EngineScene, outMp4: string, opts: RenderOpts = {}) {
  const b = await getBrowser();
  const ctxB = await b.newContext({ viewport: { width: scene.w, height: scene.h }, deviceScaleFactor: 1, javaScriptEnabled: true, offline: true });
  const page = await ctxB.newPage();
  await page.route("**/*", (route) => (route.request().url().startsWith("file://") ? route.continue() : route.abort()));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((s) => { (window as any).__SCENE = s; }, scene);
  await page.goto(pathToFileURL(path.join(ENGINE_DIR, "index.html")).toString());
  await page.waitForFunction(() => (window as any).READY === true, null, { timeout: 120_000 });
  if (errors.length) throw new Error("Erro no motor: " + errors.join("; "));
  fs.mkdirSync(path.dirname(outMp4), { recursive: true });
  const tmp = outMp4 + ".part.mp4";
  const rate = `${scene.fps.num}/${scene.fps.den}`;
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", rate, "-c:v", "mjpeg", "-i", "-",
    "-frames:v", String(scene.frameCount), "-r", rate, "-c:v", "libx264", "-preset", "veryfast", "-crf", String(opts.crf ?? 18), "-pix_fmt", "yuv420p", "-threads", "2", tmp], { shell: false });
  let ffErr = "";
  ff.stderr.on("data", (d) => (ffErr += d));
  const ffDone = new Promise<number>((res) => ff.on("close", (c) => res(c ?? -1)));
  const q = (opts.jpegQuality ?? 92) / 100;
  try {
    for (let n = 0; n < scene.frameCount; n++) {
      if (opts.signal?.aborted) throw new Error("cancelado");
      const b64: string = await page.evaluate(([i, qq]) => { (window as any).renderFrame(i); return (document.getElementById("c") as HTMLCanvasElement).toDataURL("image/jpeg", qq).split(",")[1]; }, [n, q] as [number, number]);
      if (!ff.stdin.write(Buffer.from(b64, "base64"))) await new Promise((r) => ff.stdin.once("drain", r));
      if (n % 12 === 0) opts.onProgress?.(n, scene.frameCount);
    }
    ff.stdin.end();
    const code = await ffDone;
    if (code !== 0) throw new Error("ffmpeg falhou: " + ffErr.slice(0, 400));
    if (errors.length) throw new Error("Erro no motor durante a captura: " + errors.join("; "));
    const info = await ffprobe(tmp);
    const v = info.streams.find((s) => s.codec_type === "video");
    const frames = Number(v?.nb_frames ?? 0);
    if (frames && frames !== scene.frameCount) throw new Error(`Quadros gravados ${frames} ≠ esperados ${scene.frameCount}`);
    fs.renameSync(tmp, outMp4);
    opts.onProgress?.(scene.frameCount, scene.frameCount);
    return { path: outMp4, frames: scene.frameCount };
  } catch (e) {
    try { ff.stdin.destroy(); ff.kill("SIGKILL"); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  } finally {
    await ctxB.close().catch(() => {});
  }
}

/** Uma imagem estática (prévia rápida) de um tempo específico da cena. */
export async function renderStill(scene: EngineScene, frame: number, outJpg: string) {
  const b = await getBrowser();
  const ctxB = await b.newContext({ viewport: { width: scene.w, height: scene.h }, deviceScaleFactor: 1, offline: true });
  const page = await ctxB.newPage();
  await page.route("**/*", (route) => (route.request().url().startsWith("file://") ? route.continue() : route.abort()));
  await page.addInitScript((s) => { (window as any).__SCENE = s; }, scene);
  await page.goto(pathToFileURL(path.join(ENGINE_DIR, "index.html")).toString());
  await page.waitForFunction(() => (window as any).READY === true, null, { timeout: 60_000 });
  const b64: string = await page.evaluate((i) => { (window as any).renderFrame(i); return (document.getElementById("c") as HTMLCanvasElement).toDataURL("image/jpeg", 0.9).split(",")[1]; }, frame);
  fs.mkdirSync(path.dirname(outJpg), { recursive: true });
  fs.writeFileSync(outJpg, Buffer.from(b64, "base64"));
  await ctxB.close();
  return outJpg;
}
