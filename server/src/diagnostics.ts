import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./util.js";
import { DATA_DIR, VENDOR_DIR, venvPython, ROOT } from "./paths.js";
import { keyringAvailable, secretBackend, type SecretName } from "./secrets.js";
import { kokoro, voicestudio } from "./providers/tts.js";
import { localStatus, runpodStatus, muapiStatus } from "./providers/video.js";
import { discoverSkillCatalog } from "./editorial/skills.js";

async function ver(cmd: string, args: string[], re: RegExp) {
  try { const r = await run(cmd, args, { timeoutMs: 15000 }); const m = (r.stdout + r.stderr).match(re); return r.code === 0 ? (m?.[1] ?? "ok") : null; } catch { return null; }
}

export async function doctor() {
  const items: { area: string; item: string; state: "ok" | "aviso" | "falta"; detail: string }[] = [];
  const add = (area: string, item: string, state: "ok" | "aviso" | "falta", detail: string) => items.push({ area, item, state, detail });
  add("Sistema", "Sistema operacional", "ok", `${os.type()} ${os.release()} (${os.arch()})`);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("Sistema", "Node.js", nodeMajor >= 20 ? "ok" : "falta", `v${process.versions.node} (mínimo 20.11)`);
  const py = await ver("python3", ["--version"], /Python ([\d.]+)/);
  add("Sistema", "Python", py ? "ok" : "falta", py ? `${py} (motores de voz/alinhamento em .venv)` : "Python 3.10+ necessário para voz local e alinhamento");
  add("Sistema", "Ambiente .venv", venvPython() ? "ok" : "falta", venvPython() ? venvPython()! : "rode `npm run setup`");
  const ff = await ver("ffmpeg", ["-version"], /ffmpeg version (\S+)/), fp = await ver("ffprobe", ["-version"], /ffprobe version (\S+)/);
  add("Sistema", "FFmpeg", ff ? "ok" : "falta", ff ?? "instale o FFmpeg (com libx264)");
  add("Sistema", "FFprobe", fp ? "ok" : "falta", fp ?? "instale o FFprobe");
  const x264 = ff ? await ver("ffmpeg", ["-hide_banner", "-encoders"], /(libx264)/) : null;
  add("Sistema", "Codificador H.264", x264 ? "ok" : "falta", x264 ? "libx264 disponível" : "FFmpeg sem libx264");
  try {
    const { chromium } = await import("playwright-core");
    const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROME || undefined }); const v = b.version(); await b.close();
    add("Sistema", "Navegador de renderização", "ok", `Chromium ${v}`);
  } catch (e: any) { add("Sistema", "Navegador de renderização", "falta", "Chromium do Playwright ausente: `npx playwright install chromium` (" + String(e.message).slice(0, 80) + ")"); }
  try { const s = fs.statfsSync(fs.existsSync(DATA_DIR) ? DATA_DIR : ROOT); const gb = (s.bavail * s.bsize) / 1e9; add("Sistema", "Disco livre", gb > 10 ? "ok" : "aviso", `${gb.toFixed(1)} GB livres (um longo de 10 min usa ~2–4 GB intermediários)`); } catch {}
  const ram = os.totalmem() / 1e9; add("Sistema", "Memória", ram >= 8 ? "ok" : "aviso", `${ram.toFixed(1)} GB · ${os.cpus().length} CPUs`);
  const nv = await ver("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"], /(.+)/);
  add("Sistema", "GPU", nv ? "ok" : "aviso", nv ?? "Nenhuma GPU NVIDIA detectada — só necessária para cenas por IA locais");
  add("Segurança", "Cofre do sistema", keyringAvailable() ? "ok" : "aviso", keyringAvailable() ? "Chaves no cofre do sistema operacional" : "Cofre indisponível: chaves ficam em data/segredos.json (permissão 0600) ou variáveis de ambiente");
  for (const n of ["anthropic", "openai", "runpod"] as SecretName[]) { const b = secretBackend(n); add("Credenciais", n, b === "nenhum" ? "aviso" : "ok", b === "nenhum" ? "não configurada (recursos dependentes ficam pendentes)" : `configurada (${b})`); }
  const k = await kokoro.status(); add("Voz", "Kokoro (local)", k.state === "disponível" ? "ok" : "falta", k.detail);
  const vs = await voicestudio.status(); add("Voz", "VoiceStudio (API local)", vs.state === "disponível" ? "ok" : "aviso", vs.detail);
  const wh = fs.existsSync(path.join(DATA_DIR, "modelos", "hf")); add("Voz", "Alinhador faster-whisper", venvPython() ? "ok" : "falta", wh ? "modelo em cache" : "modelo baixa no primeiro uso (~480 MB, 'small')");
  const lv = await localStatus(); add("Cenas por IA", "Minha máquina", lv.state === "disponível" ? "ok" : "aviso", lv.detail);
  const rp = await runpodStatus(); add("Cenas por IA", "RunPod", rp.state === "disponível" ? "ok" : "aviso", rp.detail);
  add("Cenas por IA", "Muapi (Open-Higgsfield)", "aviso", muapiStatus().detail);
  for (const r of ["lemo-opuscar", "bang-motion", "vox-explainer-skill", "earshot", "motion-graphics", "VoiceStudio", "Open-Higgsfield-AI", "youtube-agent-skill"]) add("Repositórios", r, fs.existsSync(path.join(VENDOR_DIR, r)) ? "ok" : "falta", fs.existsSync(path.join(VENDOR_DIR, r)) ? "presente em vendor/" : "rode `npm run refs`");
  const sk = discoverSkillCatalog(); add("Skills", "youtube-agent-skill", sk.missing.length ? "aviso" : "ok", `${sk.found.length} encontradas${sk.missing.length ? `; faltam ${sk.missing.join(", ")}` : ""}${sk.extra.length ? `; novas: ${sk.extra.join(", ")}` : ""}`);
  add("Skills", "sound-effects (projeto)", fs.existsSync(path.join(ROOT, ".claude", "skills", "sound-effects", "SKILL.md")) ? "ok" : "falta", ".claude/skills/sound-effects");
  add("Sons", "Kit Openverse (3 whooshes)", fs.existsSync(path.join(ROOT, "sons", "openverse_manifest.json")) ? "ok" : "aviso", "sons/ + CREDITOS.txt");
  const earshot = venvPython() ? await ver(venvPython()!, ["-I", "-m", "earshot", "--help"], /(usage)/) : null;
  add("Sons", "Earshot", earshot ? "ok" : "aviso", earshot ? "instalado" : "não instalado (opcional; `npm run setup -- --earshot` instala sem modelos grandes; comandos com modelos baixam ~1 GB, confirmados antes)");
  return { at: new Date().toISOString(), items, summary: { ok: items.filter((i) => i.state === "ok").length, aviso: items.filter((i) => i.state === "aviso").length, falta: items.filter((i) => i.state === "falta").length } };
}
