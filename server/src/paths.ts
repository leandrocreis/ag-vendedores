import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Raiz do repositório (server/src/.. /..). */
export const ROOT = path.resolve(here, "..", "..");
export const DATA_DIR = path.resolve(process.env.ESE_DATA_DIR ?? path.join(ROOT, "data"));
export const PROJECTS_DIR = path.join(DATA_DIR, "projetos");
export const CACHE_DIR = path.join(DATA_DIR, "cache");
export const VENDOR_DIR = path.join(ROOT, "vendor");
export const SOUNDS_DIR = path.join(ROOT, "sons");
export const PYTHON_DIR = path.join(ROOT, "python");
export const ENGINE_DIR = path.join(ROOT, "server", "engine");
export const WEB_DIST = path.join(ROOT, "web", "dist");

export function ensureDirs() {
  for (const d of [DATA_DIR, PROJECTS_DIR, CACHE_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function projectDir(projectId: string) {
  if (!/^[a-z0-9-]{4,64}$/.test(projectId)) throw new Error("ID de projeto inválido");
  const d = path.join(PROJECTS_DIR, projectId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Garante que um caminho fica dentro de uma pasta autorizada (sem ../ nem links para fora).
 */
export function safeJoin(base: string, ...parts: string[]) {
  const p = path.resolve(base, ...parts);
  const b = path.resolve(base);
  if (p !== b && !p.startsWith(b + path.sep)) throw new Error("Caminho fora da pasta autorizada");
  return p;
}

export function venvPython() {
  const win = process.platform === "win32";
  const p = path.join(ROOT, ".venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
  return fs.existsSync(p) ? p : null;
}
