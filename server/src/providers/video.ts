import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, j, now, uid } from "../db.js";
import { PYTHON_DIR, venvPython, DATA_DIR } from "../paths.js";
import { getSecret } from "../secrets.js";
import { getConfig, recordCost, setStatus } from "./config.js";
import { ffprobe, run, UserError } from "../util.js";

/**
 * VideoGenerationProvider — camada própria que separa a UI de estúdio do LOCAL de inferência.
 * "Minha máquina" executa de fato o modelo (Wan 2.1, pesos Apache-2.0) em GPU local;
 * "RunPod" envia o MESMO contrato a um endpoint Serverless do usuário, com o worker em runpod-worker/.
 * Muapi (backend do Open-Higgsfield-AI) NÃO está implementado nesta versão: aparece como não suportado.
 * O áudio embutido de qualquer clipe é descartado: a narração aprovada é preservada.
 */
export interface ClipRequest { prompt: string; negativePrompt?: string; width: number; height: number; numFrames: number; fps: number; seed: number; steps?: number; guidance?: number; model?: string; imageB64?: string }
export interface ProviderStatus { state: "disponível" | "precisa instalar" | "precisa configurar" | "incompatível" | "não suportado"; detail: string; hardware?: any }

export const VIDEO_LIMITS = { maxFrames: 81, fps: 16, maxSeconds: 81 / 16, resolutions: ["832x480", "480x832"], note: "Wan2.1-T2V-1.3B: até 81 quadros (~5 s a 16 fps) por clipe; cenas longas são divididas em planos menores." };

/* --------------------------------- local --------------------------------- */
export async function localStatus(): Promise<ProviderStatus> {
  const hw = { os: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, ramGb: Math.round(os.totalmem() / 1e9), freeDiskGb: freeDiskGb() };
  const py = venvPython();
  if (!py) return { state: "precisa instalar", detail: "Ambiente Python ausente.", hardware: hw };
  const r = await run(py, ["-I", path.join(PYTHON_DIR, "video_wan.py")], { input: JSON.stringify({ op: "check" }), timeoutMs: 60_000 });
  let info: any = {};
  try { info = JSON.parse(r.stdout.trim().split("\n").pop()!); } catch {}
  const full = { ...hw, ...info };
  if (!info.torch) return { state: "precisa instalar", detail: "PyTorch e diffusers não instalados no .venv (download de ~3 GB + pesos do modelo ~8 GB). Instale só se tiver GPU NVIDIA compatível: `npm run setup -- --video-local`.", hardware: full };
  if (!info.cuda) return { state: "incompatível", detail: "Nenhuma GPU CUDA detectada. Este modelo não é prático em CPU" + (info.mps ? " (Apple MPS detectado, não suportado por este adaptador)" : "") + ". Escolha RunPod — nada é enviado automaticamente.", hardware: full };
  const vram = Math.max(...info.gpus.map((g: any) => g.vram_gb));
  if (vram < 8) return { state: "incompatível", detail: `GPU com ${vram} GB de VRAM; o Wan2.1 1.3B precisa de ~8 GB.`, hardware: full };
  if (!info.diffusers) return { state: "precisa instalar", detail: "diffusers não instalado.", hardware: full };
  return { state: "disponível", detail: `GPU ${info.gpus[0].name} (${vram} GB). Teste uma geração curta antes do lote.`, hardware: full };
}
function freeDiskGb() { try { const s = fs.statfsSync(DATA_DIR); return Math.round((s.bavail * s.bsize) / 1e9); } catch { return null; } }

export async function localGenerate(req: ClipRequest, out: string, signal?: AbortSignal) {
  const st = await localStatus();
  if (st.state !== "disponível") throw new UserError(`Geração local indisponível: ${st.detail}`, 412);
  const py = venvPython()!;
  const r = await run(py, ["-I", path.join(PYTHON_DIR, "video_wan.py")], { input: JSON.stringify({ op: "generate", prompt: req.prompt, negative_prompt: req.negativePrompt ?? "", width: req.width, height: req.height, num_frames: req.numFrames, fps: req.fps, seed: req.seed, steps: req.steps ?? 30, guidance: req.guidance ?? 5, model: req.model ?? getConfig("local_video").model, out }), timeoutMs: 3_600_000, signal, env: { ...process.env, HF_HOME: path.join(DATA_DIR, "modelos", "hf") } });
  const o = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
  if (!o.ok) throw new Error(o.error ?? "falha na geração local");
  return await normalizeClip(out, req.fps);
}

/* --------------------------------- RunPod -------------------------------- */
const RP = "https://api.runpod.ai/v2";
function rpHeaders() {
  const k = getSecret("runpod");
  if (!k) throw new UserError("Chave RunPod não configurada.", 412, "Configurar RunPod");
  return { Authorization: `Bearer ${k}`, "content-type": "application/json" };
}
function endpoint() {
  const e = getConfig("runpod").endpointId;
  if (!e) throw new UserError("Endpoint Serverless do RunPod não configurado. A chave sozinha não cria um serviço: implante o worker de runpod-worker/ e informe o ID do endpoint.", 412, "Configurar RunPod");
  if (!/^[a-z0-9-]{6,64}$/i.test(e)) throw new UserError("ID de endpoint inválido", 400);
  return e;
}

export async function runpodStatus(): Promise<ProviderStatus> {
  if (!getSecret("runpod")) return { state: "precisa configurar", detail: "Informe a chave RunPod (mascarada) e o ID do endpoint Serverless." };
  if (!getConfig("runpod").endpointId) return { state: "precisa configurar", detail: "Chave presente, mas falta o endpoint Serverless com o worker deste projeto." };
  try {
    const r = await fetch(`${RP}/${endpoint()}/health`, { headers: rpHeaders(), signal: AbortSignal.timeout(15000) });
    if (r.status === 401) return { state: "precisa configurar", detail: "RunPod recusou a chave (401)." };
    if (!r.ok) return { state: "precisa configurar", detail: `RunPod /health respondeu HTTP ${r.status}.` };
    const h: any = await r.json();
    setStatus("runpod", { ok: true, health: h });
    return { state: "disponível", detail: `Endpoint respondeu: workers ${JSON.stringify(h.workers ?? {})}, jobs ${JSON.stringify(h.jobs ?? {})}. Ociosidade não gera cobrança de GPU além da política do seu endpoint.` };
  } catch (e: any) {
    return { state: "precisa configurar", detail: "Falha ao contatar a API RunPod: " + e.message };
  }
}

/** Envia, salva o ID remoto ANTES de aguardar, e acompanha por polling. Retomada consulta o mesmo ID. */
export async function runpodGenerate(jobId: string, req: ClipRequest, out: string, opts: { signal?: AbortSignal; onStatus?: (s: string) => void; projectId?: string }) {
  const ep = endpoint();
  let remote = db().prepare("SELECT * FROM remote_jobs WHERE job_id=? AND provider='runpod' ORDER BY created_at DESC LIMIT 1").get(jobId) as any;
  if (!remote) {
    const body = { input: { prompt: req.prompt, negative_prompt: req.negativePrompt ?? "", width: req.width, height: req.height, num_frames: req.numFrames, fps: req.fps, seed: req.seed, steps: req.steps ?? 30, guidance: req.guidance ?? 5, model: req.model }, policy: { executionTimeout: getConfig("runpod").timeoutSec * 1000, ttl: (getConfig("runpod").timeoutSec + 600) * 1000 } };
    const r = await fetch(`${RP}/${ep}/run`, { method: "POST", headers: rpHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new UserError(`RunPod recusou o envio (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`, 502);
    const o: any = await r.json();
    const id = uid("rj_");
    db().prepare("INSERT INTO remote_jobs(id,job_id,provider,remote_id,endpoint,status,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, jobId, "runpod", o.id, ep, o.status, JSON.stringify({ request: { ...body.input, prompt: body.input.prompt.slice(0, 400) } }), now(), now());
    remote = db().prepare("SELECT * FROM remote_jobs WHERE id=?").get(id);
  }
  const started = Date.now();
  for (;;) {
    if (opts.signal?.aborted) {
      await fetch(`${RP}/${ep}/cancel/${remote.remote_id}`, { method: "POST", headers: rpHeaders() }).catch(() => {});
      db().prepare("UPDATE remote_jobs SET status='CANCELLED', updated_at=? WHERE id=?").run(now(), remote.id);
      throw new Error("cancelado (pedido de cancelamento enviado ao RunPod; tempo já consumido pode ter sido cobrado)");
    }
    const r = await fetch(`${RP}/${ep}/status/${remote.remote_id}`, { headers: rpHeaders(), signal: AbortSignal.timeout(30000) });
    const o: any = await r.json().catch(() => ({}));
    db().prepare("UPDATE remote_jobs SET status=?, updated_at=? WHERE id=?").run(o.status ?? `HTTP ${r.status}`, now(), remote.id);
    opts.onStatus?.(o.status);
    if (o.status === "COMPLETED") {
      if (!o.output?.video_b64) throw new Error("Worker concluiu sem vídeo: " + JSON.stringify(o.output ?? {}).slice(0, 200));
      fs.writeFileSync(out, Buffer.from(o.output.video_b64, "base64"));
      const price = getConfig("runpod").pricePerSecondUsd;
      const secs = (o.executionTime ?? 0) / 1000;
      recordCost({ projectId: opts.projectId, jobId, provider: "runpod", model: o.output.model, kind: price ? "estimado" : "indisponível", amountUsd: price ? price * secs : null, units: { executionSeconds: secs, delayMs: o.delayTime ?? null } });
      return await normalizeClip(out, req.fps);
    }
    if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(o.status)) throw new Error(`RunPod: ${o.status} ${JSON.stringify(o.error ?? o.output?.error ?? "").slice(0, 300)}`);
    if (Date.now() - started > (getConfig("runpod").timeoutSec + 600) * 1000) throw new Error("tempo máximo de espera excedido (o job remoto continua consultável pela retomada)");
    await new Promise((res) => setTimeout(res, 5000));
  }
}

/** Valida o clipe baixado, descarta áudio embutido e conforma FPS antes de marcar como pronto. */
async function normalizeClip(file: string, fps: number) {
  const info = await ffprobe(file);
  if (!info.streams.some((s) => s.codec_type === "video")) throw new Error("clipe inválido (sem vídeo)");
  const fixed = file.replace(/\.mp4$/, "_mudo.mp4");
  const r = await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", fixed]);
  if (r.code !== 0) throw new Error("falha ao normalizar clipe");
  const i2 = await ffprobe(fixed);
  return { path: fixed, duration: i2.duration, fps, audioDiscarded: info.streams.some((s) => s.codec_type === "audio") };
}

export function muapiStatus(): ProviderStatus {
  return { state: "não suportado", detail: "O Open-Higgsfield-AI usa a Muapi (serviço externo, chave própria). O adaptador Muapi não foi implementado nesta versão; não há substituição silenciosa do local escolhido." };
}

/** Plano editorial para uma cena: clipes ≤ ~5 s; nunca esticar nem repetir em loop. */
export function planAiClips(t0: number, t1: number) {
  const max = VIDEO_LIMITS.maxSeconds;
  const n = Math.ceil((t1 - t0) / max);
  const d = (t1 - t0) / n;
  return Array.from({ length: n }, (_, i) => ({ t0: t0 + i * d, t1: t0 + (i + 1) * d, numFrames: Math.min(81, 4 * Math.ceil((d * VIDEO_LIMITS.fps) / 4) + 1) }));
}
