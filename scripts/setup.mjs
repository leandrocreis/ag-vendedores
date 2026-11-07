#!/usr/bin/env node
// Instalação local. Uso:
//   npm run setup                 dependências Node + .venv (voz e alinhamento) + modelo Kokoro + referências
//   npm run setup -- --sem-voz    pula o modelo Kokoro (~354 MB)
//   npm run setup -- --video-local  instala PyTorch/diffusers para cenas por IA na SUA GPU (vários GB; pede confirmação)
//   npm run setup -- --earshot    instala o Earshot (medição de áudio; comandos com modelos baixam ~1 GB sob demanda)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const has = (f) => process.argv.includes(f);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
const win = process.platform === "win32";
const py = path.join(ROOT, ".venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
async function ask(q) { if (!process.stdin.isTTY) return false; const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const a = await rl.question(q + " [s/N] "); rl.close(); return /^s/i.test(a); }

console.log("1/5 Dependências Node (versões fixadas no package-lock)…"); sh(win ? "npm.cmd" : "npm", ["ci"]);
console.log("2/5 Repositórios de referência (commits fixados em refs.lock.json)…"); sh(process.execPath, ["scripts/fetch-refs.mjs"]);
console.log("3/5 Ambiente Python isolado (.venv)…");
if (!fs.existsSync(py)) { try { sh("uv", ["venv", ".venv", "--python", "3.12"]); } catch { sh(win ? "python" : "python3", ["-m", "venv", ".venv"]); } }
try { sh("uv", ["pip", "install", "--python", py, "-r", "python/requirements.lock.txt"]); } catch { sh(py, ["-m", "pip", "install", "-r", "python/requirements.lock.txt"]); }
if (!has("--sem-voz")) {
  console.log("4/5 Modelo de voz Kokoro v1.0 (Apache-2.0): kokoro-v1.0.onnx 326 MB + voices-v1.0.bin 28 MB");
  const dir = path.join(ROOT, "data", "modelos", "kokoro"); fs.mkdirSync(dir, { recursive: true });
  for (const f of ["kokoro-v1.0.onnx", "voices-v1.0.bin"]) {
    if (fs.existsSync(path.join(dir, f))) continue;
    const r = await fetch(`https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/${f}`);
    if (!r.ok) throw new Error(`download falhou: ${f} HTTP ${r.status}`);
    fs.writeFileSync(path.join(dir, f), Buffer.from(await r.arrayBuffer()));
  }
}
if (has("--video-local")) {
  console.log("Cenas por IA locais: PyTorch + diffusers (~3–5 GB) e, no primeiro uso, pesos do Wan2.1 T2V 1.3B (~8 GB). Requer GPU NVIDIA com ≥ 8 GB.");
  if (await ask("Instalar agora?")) sh(py, ["-m", "pip", "install", "torch", "diffusers==0.42.1", "transformers", "accelerate", "ftfy", "imageio", "imageio-ffmpeg"]);
}
if (has("--earshot")) {
  console.log("Earshot 0.4.1 (MIT): instalação a partir de vendor/earshot. Comandos sem modelos: measure, sfx, kit. Os demais carregam modelos (~1 GB) no primeiro uso.");
  if (await ask("Instalar o Earshot (inclui torch para CPU, vários centenas de MB)?")) sh(py, ["-m", "pip", "install", "./vendor/earshot"]);
}
console.log("5/5 Diagnóstico:"); try { sh(win ? "npm.cmd" : "npm", ["run", "doctor"]); } catch { console.log("Há itens faltando — veja acima."); }
console.log("\nPronto. Inicie com:  npm start");
