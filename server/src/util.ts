import { spawn, type SpawnOptions } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

/** Executa um binário com argumentos validados — nunca via shell, nunca interpolando texto. */
export function run(cmd: string, args: string[], opts: SpawnOptions & { input?: Buffer | string; timeoutMs?: number; onStderr?: (s: string) => void; signal?: AbortSignal } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (/[;&|`$<>]/.test(cmd)) return reject(new Error("Executável inválido"));
    const p = spawn(cmd, args, { ...opts, shell: false });
    let stdout = "", stderr = "";
    p.stdout?.on("data", (d) => (stdout += d));
    p.stderr?.on("data", (d) => {
      const s = String(d);
      stderr += s;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
      opts.onStderr?.(s);
    });
    const t = opts.timeoutMs ? setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs) : null;
    opts.signal?.addEventListener("abort", () => p.kill("SIGTERM"), { once: true });
    p.on("error", reject);
    p.on("close", (code) => {
      if (t) clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input != null) p.stdin?.end(opts.input);
  });
}

export async function sha256File(file: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}
export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

export interface ProbeInfo {
  duration: number;
  streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number; duration?: string; nb_frames?: string }[];
  format: { format_name: string; duration: string; size: string };
}
export async function ffprobe(file: string): Promise<ProbeInfo> {
  const r = await run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file]);
  if (r.code !== 0) throw new Error(`ffprobe falhou: ${r.stderr.slice(0, 300)}`);
  const o = JSON.parse(r.stdout);
  return { duration: Number(o.format?.duration ?? 0), streams: o.streams ?? [], format: o.format };
}

/** Lê áudio como PCM float32 mono (ou estéreo) via ffmpeg. */
export async function decodePcm(file: string, sampleRate = 48000, channels = 1): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-acodec", "pcm_f32le", "-ac", String(channels), "-ar", String(sampleRate), "-"], { shell: false });
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`decodificação falhou: ${err.slice(0, 300)}`));
      const b = Buffer.concat(chunks);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)));
    });
  });
}

export interface EbuR128 { integrated: number; truePeak: number; lra: number }
/** Mede loudness integrado e true peak (ebur128 do ffmpeg). */
export async function measureLoudness(file: string, mono = false): Promise<EbuR128> {
  const args = ["-nostats", "-i", file, "-vn"];
  if (mono) args.push("-ac", "1");
  args.push("-af", "ebur128=peak=true", "-f", "null", "-");
  const r = await run("ffmpeg", args);
  const s = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = s.match(re);
    return m ? Number(m[1]) : NaN;
  };
  return { integrated: num(/I:\s+(-?[\d.]+|-inf) LUFS/), truePeak: num(/Peak:\s+(-?[\d.]+|-inf) dBFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/) };
}

export function writeJson(file: string, o: unknown) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(o, null, 1));
  fs.renameSync(tmp, file);
}

export function fmtTime(t: number, sep = ",") {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
}
export function mmss(t: number) {
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export class UserError extends Error {
  constructor(message: string, public status = 400, public nextAction?: string) {
    super(message);
  }
}

/** Como run(), mas devolve stdout em bytes (para quadros/áudio brutos). */
export function runBuffer(cmd: string, args: string[], timeoutMs = 120_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { shell: false });
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("error", reject);
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.slice(0, 300))); });
  });
}
