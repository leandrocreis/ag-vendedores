import fs from "node:fs";
import path from "node:path";
import { db, j, now, uid } from "../db.js";
import { projectDir, ENGINE_DIR } from "../paths.js";
import { decodePcm, ffprobe, measureLoudness, run, runBuffer, sha256, UserError, fmtTime, writeJson } from "../util.js";
import { requireApprovedAudio, commitIfCurrent, type Master } from "../pipeline/audio-gate.js";
import { listScenes, engineSceneFor, sceneRenderDir, frameAt } from "../pipeline/storyboard.js";
import { latestAlignment } from "../pipeline/align.js";
import { getProject } from "../pipeline/narration.js";
import { renderScene } from "./renderer.js";
import { buildCues, currentCues, timelineVersionOf } from "../sound/cues.js";
import type { SoundCue } from "../contracts.js";

const SR = 48000;
const engineHash = () => sha256(fs.readFileSync(path.join(ENGINE_DIR, "engine.js"))).slice(0, 12);

export interface Ctx { progress: (p: number, label: string, estimated?: boolean) => void; signal?: AbortSignal; log: (s: string) => void }

function subtitleCues(m: Master) {
  const a = latestAlignment(m);
  return (a?.cues ?? []).map((c: any) => ({ t0: c.t0, t1: c.t1, text: c.text }));
}

/** Renderiza as cenas pedidas (ou todas). Cache por conteúdo: cena idêntica não é renderizada de novo. */
export async function renderScenes(projectId: string, ctx: Ctx, onlyKeys?: string[], format: "16:9" | "9:16" = "16:9") {
  const m = requireApprovedAudio(projectId);
  const scenes = listScenes(projectId).filter((s) => !s.stale && s.master_id === m.id && (!onlyKeys || onlyKeys.includes(s.stable_key)));
  if (!scenes.length) throw new UserError("Nenhuma cena atual para renderizar. Gere o storyboard primeiro.", 409, "Gerar storyboard");
  const subs = subtitleCues(m);
  const eh = engineHash();
  const out: { key: string; path: string; cached: boolean }[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const es = engineSceneFor(projectId, s, m, format, subs, true);
    const h = sha256(JSON.stringify([es, eh, format])).slice(0, 16);
    const file = path.join(sceneRenderDir(projectId), `${s.stable_key}_${format === "9:16" ? "v" : "h"}_${h}.mp4`);
    if (fs.existsSync(file)) { out.push({ key: s.stable_key, path: file, cached: true }); continue; }
    ctx.log(`Renderizando cena ${s.stable_key} (${es.frameCount} quadros)`);
    await renderScene(es, file, { signal: ctx.signal, onProgress: (d, t) => ctx.progress((i + d / t) / scenes.length, `Cena ${i + 1}/${scenes.length} · quadro ${d}/${t}`) });
    const r = commitIfCurrent(projectId, m.id, () => {
      if (format === "16:9") db().prepare("UPDATE scenes SET render_path=?, render_hash=?, state='concluído', updated_at=? WHERE id=?").run(file, h, now(), s.id);
      db().prepare("INSERT INTO assets(id,project_id,kind,path,sha256,mime,provenance_json,scene_key,approved,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(uid("ast_"), projectId, "render-cena", file, h, "video/mp4", JSON.stringify({ engine: eh, masterId: m.id, masterSha: m.sha256, format }), s.stable_key, 1, now());
    });
    if (!r.committed) throw new UserError(r.reason, 409);
    out.push({ key: s.stable_key, path: file, cached: false });
  }
  return out;
}

/* --------------------------------- mixagem --------------------------------- */
/**
 * Mixa por AMOSTRA a 48 kHz: narração aprovada (relógio) + efeitos (posição = round(início·48000))
 * + trilha opcional com ducking sob a voz. Depois loudness em duas passagens + limitador de true peak.
 * withFx=false produz a versão B do A/B, com a MESMA cadeia de normalização da versão A.
 */
export async function mixAudio(projectId: string, m: Master, cues: SoundCue[], outWav: string, opts: { withFx: boolean; music?: string | null; lufs: number; tp: number; gainFromA?: number }) {
  const inputs = ["-i", m.path];
  const parts: string[] = ["[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0dB[voz]"];
  const mixIn = ["[voz]"];
  let idx = 1;
  if (opts.music && fs.existsSync(opts.music)) {
    inputs.push("-stream_loop", "-1", "-i", opts.music);
    parts.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${m.duration.toFixed(3)},volume=-20dB[mus]`, `[voz]asplit=2[voz1][vozsc]`, `[mus][vozsc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[musd]`);
    mixIn[0] = "[voz1]"; mixIn.push("[musd]"); idx++;
  }
  if (opts.withFx) for (const c of cues) {
    if (!c.file) continue;
    inputs.push("-i", c.file);
    const startSamples = Math.round((c.fileStart + c.intentionalShiftMs / 1000) * SR);
    const fo = c.fadeOutMs > 0 ? `,afade=t=out:st=${Math.max(0, c.duration - c.fadeOutMs / 1000).toFixed(3)}:d=${(c.fadeOutMs / 1000).toFixed(3)}` : "";
    parts.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${c.gainDb}dB${fo},adelay=${startSamples}S:all=1[fx${idx}]`);
    mixIn.push(`[fx${idx}]`); idx++;
  }
  parts.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=first[mix]`);
  const pre = outWav.replace(/\.wav$/, ".pre.wav");
  let r = await run("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", parts.join(";"), "-map", "[mix]", "-c:a", "pcm_s24le", "-ar", "48000", pre], { timeoutMs: 1_800_000 });
  if (r.code !== 0) throw new Error("mixagem falhou: " + r.stderr.slice(0, 500));
  // ganho: A mede e normaliza; B reutiliza o MESMO ganho de A (comparação justa, sem normalização separada)
  let gain = opts.gainFromA;
  if (gain == null) { const L = await measureLoudness(pre); gain = opts.lufs - L.integrated; }
  r = await run("ffmpeg", ["-v", "error", "-y", "-i", pre, "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=${Math.pow(10, (opts.tp - 0.5) / 20).toFixed(4)}:attack=1:release=60:level=disabled:asc=1,aresample=48000`, "-c:a", "pcm_s24le", outWav]);
  fs.rmSync(pre, { force: true });
  if (r.code !== 0) throw new Error("limitador falhou: " + r.stderr.slice(0, 300));
  return { gainDb: gain };
}

/* ------------------------------ montagem final ------------------------------ */
export async function assembleLong(projectId: string, ctx: Ctx, opts: { format?: "16:9" | "9:16"; music?: string | null } = {}) {
  const m = requireApprovedAudio(projectId);
  const p = getProject(projectId);
  const format = opts.format ?? (p.settings.format as "16:9" | "9:16");
  const fps = p.settings.fps ?? { num: 24, den: 1 };
  ctx.progress(0, "Renderizando cenas", true);
  const rendered = await renderScenes(projectId, { ...ctx, progress: (q, l) => ctx.progress(q * 0.7, l, true) }, undefined, format);
  const scenes = listScenes(projectId).filter((s) => !s.stale && s.master_id === m.id);
  const totalFrames = frameAt(m.duration, fps);
  const sumFrames = scenes.reduce((s, sc) => s + frameAt(sc.t1, fps) - frameAt(sc.t0, fps), 0);
  if (sumFrames !== totalFrames) throw new Error(`Cenas somam ${sumFrames} quadros, master pede ${totalFrames}`);
  const dir = path.join(projectDir(projectId), "exportacao");
  fs.mkdirSync(dir, { recursive: true });
  const list = path.join(dir, "concat.txt");
  fs.writeFileSync(list, rendered.map((r) => `file '${r.path.replace(/'/g, "'\\''")}'`).join("\n"));
  const videoOnly = path.join(dir, `video_${format === "9:16" ? "vertical" : "horizontal"}.mp4`);
  ctx.progress(0.72, "Concatenando cenas");
  let r = await run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", videoOnly]);
  if (r.code !== 0) throw new Error("concat falhou: " + r.stderr.slice(0, 300));
  // sound pass
  ctx.progress(0.76, "Mapa de cues sonoros");
  const tv = timelineVersionOf(scenes, m.id);
  let cues = currentCues(projectId).filter((c) => c.timelineVersion === tv);
  if (!cues.length) cues = await buildCues(projectId, scenes, fps, m.duration, tv);
  const lufs = p.settings.loudness?.lufs ?? -16, tp = p.settings.loudness?.truePeak ?? -4;
  ctx.progress(0.8, "Mixando (com efeitos)");
  const mixA = path.join(dir, "mix_com_efeitos.wav"), mixB = path.join(dir, "mix_sem_efeitos.wav");
  const a = await mixAudio(projectId, m, cues, mixA, { withFx: true, music: opts.music ?? null, lufs, tp });
  await mixAudio(projectId, m, cues, mixB, { withFx: false, music: opts.music ?? null, lufs, tp, gainFromA: a.gainDb });
  ctx.progress(0.88, "Gerando MP4");
  const base = (p.title as string).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "_").slice(0, 40) || "video";
  const outA = path.join(dir, `${base}_${format === "9:16" ? "1080x1920" : "1920x1080"}.mp4`);
  const outB = path.join(dir, `${base}_sem_efeitos_AB.mp4`);
  for (const [wav, out] of [[mixA, outA], [mixB, outB]]) {
    r = await run("ffmpeg", ["-v", "error", "-y", "-i", videoOnly, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", (totalFrames * fps.den / fps.num).toFixed(6), "-movflags", "+faststart", out]);
    if (r.code !== 0) throw new Error("mux falhou: " + r.stderr.slice(0, 300));
  }
  ctx.progress(0.92, "Validando MP4");
  const validation = await validateMp4(outA, { expectedDuration: totalFrames * fps.den / fps.num, w: format === "9:16" ? 1080 : 1920, h: format === "9:16" ? 1920 : 1080, fps, masterPath: m.path, lufs, tp, scenes, intentionalDark: scenes.flatMap((s) => s.data.shots.filter((x: any) => x.transitionIn === "escuro").map((x: any) => [x.t0, x.t0 + 0.6])).concat(scenes.flatMap((s) => s.data.shots.filter((x: any) => x.fadeOut).map((x: any) => [x.t1 - 0.6, x.t1]))) });
  const cueCheck = await measureCuePlacement(outA, outB, cues);
  const exportId = uid("exp_");
  const res = commitIfCurrent(projectId, m.id, () => {
    db().prepare("INSERT INTO exports(id,project_id,kind,path,master_id,validation_json,status,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(exportId, projectId, format === "9:16" ? "curto" : "longo", outA, m.id, JSON.stringify({ ...validation, cueCheck, abPath: outB, timelineVersion: tv }), validation.ok ? "concluído" : "falhou", now());
  });
  if (!res.committed) throw new UserError(res.reason, 409);
  if (!validation.ok) throw new UserError("Exportação gerada mas reprovada na validação: " + validation.problems.join("; "), 422);
  return { exportId, path: outA, abPath: outB, validation, cueCheck, cues: cues.length };
}

/* -------------------------------- validação -------------------------------- */
export async function validateMp4(file: string, exp: { expectedDuration: number; w: number; h: number; fps: { num: number; den: number }; masterPath?: string; lufs: number; tp: number; scenes?: any[]; intentionalDark?: number[][] }) {
  const problems: string[] = [], notes: string[] = [];
  if (!fs.existsSync(file)) return { ok: false, problems: ["arquivo ausente"], notes };
  const info = await ffprobe(file);
  const v = info.streams.find((s) => s.codec_type === "video"), a = info.streams.find((s) => s.codec_type === "audio");
  if (!v) problems.push("sem stream de vídeo"); if (!a) problems.push("sem stream de áudio");
  if (v && v.codec_name !== "h264") problems.push(`vídeo ${v.codec_name} ≠ h264`);
  if (a && a.codec_name !== "aac") problems.push(`áudio ${a.codec_name} ≠ aac`);
  if (v && (v.width !== exp.w || v.height !== exp.h)) problems.push(`resolução ${v.width}×${v.height} ≠ ${exp.w}×${exp.h}`);
  const [rn, rd] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  if (v && rn * exp.fps.den !== rd * exp.fps.num) problems.push(`FPS ${v.r_frame_rate} ≠ ${exp.fps.num}/${exp.fps.den}`);
  const frame = exp.fps.den / exp.fps.num;
  const vdur = Number(v?.duration ?? info.duration);
  if (Math.abs(vdur - exp.expectedDuration) > frame + 1e-3) problems.push(`duração do vídeo ${vdur.toFixed(3)} s ≠ ${exp.expectedDuration.toFixed(3)} s`);
  const adur = Number(a?.duration ?? 0);
  if (a && Math.abs(adur - vdur) > 0.05) problems.push(`áudio ${adur.toFixed(3)} s × vídeo ${vdur.toFixed(3)} s`);
  // faststart: moov antes de mdat
  const head = Buffer.alloc(65536); const fd = fs.openSync(file, "r"); fs.readSync(fd, head, 0, 65536, 0); fs.closeSync(fd);
  const moov = head.indexOf("moov"), mdat = head.indexOf("mdat");
  if (!(moov >= 0 && (mdat < 0 || moov < mdat))) problems.push("sem faststart (moov depois de mdat)");
  // loudness medido no MP4 exportado (estéreo e mono)
  const L = await measureLoudness(file), Lm = await measureLoudness(file, true);
  if (Math.abs(L.integrated - exp.lufs) > 1.5) problems.push(`loudness ${L.integrated} LUFS fora de ${exp.lufs}±1,5`);
  if (L.truePeak > exp.tp + 0.5) problems.push(`true peak ${L.truePeak} dBTP acima de ${exp.tp}`);
  if (Lm.truePeak > 0) problems.push(`downmix mono clipa (${Lm.truePeak} dBTP)`);
  // quadros: início, meio, fim e início de cada cena; preto proposital × falha
  const samples = [0.1, vdur / 2, Math.max(0, vdur - 0.2), ...(exp.scenes ?? []).map((s) => s.t0 + 0.7)];
  const frames: { t: number; yavg: number; dark: boolean; intentional: boolean }[] = [];
  for (const t of samples) {
    const buf = await runBuffer("ffmpeg", ["-v", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"]);
    let s = 0; for (const b of buf) s += b; const yavg = buf.length ? s / buf.length : 0;
    const intentional = (exp.intentionalDark ?? []).some(([a0, a1]) => t >= a0 - 0.05 && t <= a1 + 0.05);
    frames.push({ t, yavg, dark: yavg < 6, intentional });
  }
  const badDark = frames.filter((f) => f.dark && !f.intentional);
  if (badDark.length) problems.push(`quadro(s) preto(s) não intencionais em ${badDark.map((f) => f.t.toFixed(1)).join(", ")} s`);
  // sincronismo: início da primeira fala no MP4 × no master
  let syncMs: number | null = null;
  if (exp.masterPath) {
    const onset = async (f: string) => { const x = await decodePcm(f, 8000, 1); const win = 40; for (let i = 0; i + win < x.length; i += win) { let e = 0; for (let k = i; k < i + win; k++) e += x[k] * x[k]; if (Math.sqrt(e / win) > 0.02) return i / 8000; } return null; };
    const o1 = await onset(exp.masterPath), o2 = await onset(file);
    if (o1 != null && o2 != null) { syncMs = (o2 - o1) * 1000; if (Math.abs(syncMs) > 45) problems.push(`fala deslocada ${syncMs.toFixed(0)} ms em relação ao master`); }
    notes.push("Sincronismo medido pelo início da primeira fala; efeitos/trilha podem antecipar levemente o limiar.");
  }
  return { ok: problems.length === 0, problems, notes, video: { codec: v?.codec_name, w: v?.width, h: v?.height, fps: v?.r_frame_rate, duration: vdur, frames: v?.nb_frames }, audio: { codec: a?.codec_name, duration: adur, sampleRate: a?.sample_rate, channels: a?.channels }, loudness: { stereo: L, mono: Lm }, frames, syncMs, measuredAt: now() };
}

/** Mede no MP4 exportado onde o efeito realmente caiu: diferença A−B, pico do envelope perto do alvo. */
export async function measureCuePlacement(fileA: string, fileB: string, cues: SoundCue[]) {
  const SRm = 16000;
  const A = await decodePcm(fileA, SRm, 1), B = await decodePcm(fileB, SRm, 1);
  return cues.filter((c) => c.file).map((c) => {
    const target = c.targetTime + c.intentionalShiftMs / 1000;
    const i0 = Math.max(0, Math.floor((c.fileStart - 0.05) * SRm)), i1 = Math.min(A.length, Math.ceil((c.fileStart + c.duration + 0.05) * SRm));
    const win = 32; // 2 ms
    let best = -1, bt = 0, onsetT: number | null = null, peakE = 0;
    const env: number[] = [];
    for (let i = i0; i + win < i1; i += win) { let e = 0; for (let k = i; k < i + win; k++) { const d = A[k] - B[k]; e += d * d; } env.push(e); if (e > best) { best = e; bt = (i + win / 2) / SRm; } }
    peakE = best;
    for (let k = 0; k < env.length; k++) if (env[k] > peakE * 0.1) { onsetT = (i0 + k * win) / SRm; break; }
    const measured = c.syncType === "pico" ? bt : c.syncType === "ataque" ? onsetT ?? bt : onsetT ?? bt;
    return { id: c.id, frame: c.frame, targetTime: +target.toFixed(4), measuredTime: +measured.toFixed(4), deviationMs: +((measured - target) * 1000).toFixed(1), method: "envelope da diferença com/sem efeitos (janelas de 2 ms) no áudio AAC exportado", audible: best > 1e-6 };
  });
}

/* -------------------------- 5 trechos para fone -------------------------- */
export async function reviewClips(projectId: string, exportId: string) {
  const e = db().prepare("SELECT * FROM exports WHERE id=? AND project_id=?").get(exportId, projectId) as any;
  if (!e) throw new UserError("Exportação não encontrada", 404);
  const val = j<any>(e.validation_json, {});
  const cues = currentCues(projectId).filter((c) => c.timelineVersion === val.timelineVersion);
  const dur = val.video.duration as number;
  const byCat = (cat: string) => cues.find((c) => c.category === cat && c.file);
  const scenes = listScenes(projectId);
  const climax = scenes[Math.max(0, scenes.length - 1)];
  type Pick = { idx: number; name: string; t: number; why: string; cue?: SoundCue; check: string };
  const picks: Pick[] = [
    { idx: 1, name: "01_abertura", t: 0, why: "Gancho de abertura com entrada do ambiente e da narração", check: "A primeira frase é inteligível? O ambiente entra sem competir com a voz?" },
    { idx: 2, name: "02_passagem_rapida", t: byCat("whoosh-passagem")?.targetTime ?? dur * 0.25, cue: byCat("whoosh-passagem"), why: "Passagem rápida com o primeiro whoosh", check: "O pico do whoosh cai no corte? Soa natural ou adiantado?" },
    { idx: 3, name: "03_transicao_pesada", t: byCat("whoosh-pesada")?.targetTime ?? dur * 0.45, cue: byCat("whoosh-pesada"), why: "Transição pesada/impacto com o segundo whoosh", check: "O grave pesa sem embolar a fala? Há cauda cortada?" },
    { idx: 4, name: "04_revelacao", t: byCat("whoosh-revelacao")?.targetTime ?? dur * 0.7, cue: byCat("whoosh-revelacao"), why: "Suspense/revelação com o terceiro whoosh e o silêncio antes", check: "O silêncio antes da revelação funciona? O crescente chega no momento certo?" },
    { idx: 5, name: "05_encerramento", t: Math.max(0, (climax?.t1 ?? dur) - 6), why: "Clímax/encerramento com todas as camadas", check: "Final sem clipping, fala clara, caudas preservadas até o fim." },
  ];
  const dir = path.join(projectDir(projectId), "revisao_fone");
  fs.mkdirSync(dir, { recursive: true });
  const out: any[] = [];
  for (const p of picks) {
    const t0 = Math.max(0, p.idx === 1 ? 0 : p.t - 5), t1 = Math.min(dur, p.idx === 5 ? dur : p.t + 7);
    const name = `${p.name}.mp4`;
    for (const [src, f] of [[e.path, path.join(dir, name)], [val.abPath, path.join(dir, `${p.name}_sem_efeitos.mp4`)]]) {
      const r = await run("ffmpeg", ["-v", "error", "-y", "-ss", t0.toFixed(3), "-i", src, "-t", (t1 - t0).toFixed(3), "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-c:a", "aac", "-b:a", "192k", "-metadata", `comment=E Se? Studio · trecho ${p.idx} · master ${fmtTime(t0, ".")}–${fmtTime(t1, ".")} · export ${exportId}`, "-movflags", "+faststart", f]);
      if (r.code !== 0) throw new Error("recorte falhou: " + r.stderr.slice(0, 200));
    }
    const wave = path.join(dir, `${p.name}_onda.png`);
    await run("ffmpeg", ["-v", "error", "-y", "-i", path.join(dir, name), "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=900x160:colors=0x7dd3fc", "-frames:v", "1", wave]);
    const still = path.join(dir, `${p.name}_quadro.jpg`);
    await run("ffmpeg", ["-v", "error", "-y", "-ss", Math.min(dur - 0.05, p.t).toFixed(3), "-i", e.path, "-frames:v", "1", "-vf", "scale=480:-2", still]);
    const L = await measureLoudness(path.join(dir, name));
    out.push({ ...p, t0, t1, file: name, abFile: `${p.name}_sem_efeitos.mp4`, wave: path.basename(wave), still: path.basename(still), loudness: L, cueFrame: p.cue?.frame ?? null, cueLicense: p.cue ? `${p.cue.license} — ${p.cue.source}` : null, cueId: p.cue?.id ?? null, missingCue: p.idx >= 2 && p.idx <= 4 && !p.cue });
  }
  db().prepare("DELETE FROM review_clips WHERE project_id=? AND export_id=?").run(projectId, exportId);
  for (const c of out) db().prepare("INSERT INTO review_clips(id,project_id,export_id,idx,data_json,created_at) VALUES(?,?,?,?,?,?)").run(uid("rc_"), projectId, exportId, c.idx, JSON.stringify(c), now());
  writeJson(path.join(dir, "RELATORIO_TRECHOS.json"), { exportId, video: e.path, clips: out, note: "Intervalos em segundos do vídeo final, que coincide com o relógio do master aprovado." });
  writeSoundReport(projectId, exportId, out, cues, val);
  return out;
}

function writeSoundReport(projectId: string, exportId: string, clips: any[], cues: SoundCue[], val: any) {
  const dir = path.join(projectDir(projectId), "sons");
  fs.mkdirSync(dir, { recursive: true });
  const rel = (f: string) => `../revisao_fone/${f}`;
  const esc = (s: any) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const cueRows = cues.map((c) => {
    const m = (val.cueCheck ?? []).find((x: any) => x.id === c.id);
    return `<tr><td>${c.id}</td><td>${esc(c.sceneKey)}</td><td>${esc(c.event)}</td><td>${esc(c.category)}</td><td>${c.frame}</td><td>${c.targetTime.toFixed(3)}</td><td>${c.syncType}</td><td>${c.syncOffset.toFixed(3)}</td><td>${m ? m.deviationMs + " ms" : "—"}</td><td>${esc(c.license)}<br><a href="${esc(c.source)}">fonte</a></td><td>${c.review}</td>
      <td><button data-cue="${c.id}" data-d="-1">−1 quadro</button><button data-cue="${c.id}" data-d="1">+1 quadro</button></td></tr>`;
  }).join("");
  const clipCards = clips.map((c) => `<section class="clip"><h3>${c.idx}. ${esc(c.why)}</h3>
    <p>Vídeo final ${c.t0.toFixed(2)}–${c.t1.toFixed(2)} s ${c.cueFrame != null ? `· cue no quadro ${c.cueFrame}` : ""} · ${Number.isFinite(c.loudness.integrated) ? c.loudness.integrated.toFixed(1) : "—"} LUFS · TP ${c.loudness.truePeak.toFixed(1)} dBTP</p>
    ${c.missingCue ? `<p class="warn">Não há cue desta categoria nesta timeline; trecho escolhido por posição.</p>` : ""}
    <div class="ab"><div><b>A — com efeitos</b><video controls preload="none" src="${rel(c.file)}" poster="${rel(c.still)}"></video></div><div><b>B — sem efeitos</b><video controls preload="none" src="${rel(c.abFile)}"></video></div></div>
    <img class="wave" src="${rel(c.wave)}" alt="forma de onda">
    <p><b>Confira:</b> ${esc(c.check)}</p>${c.cueLicense ? `<p class="lic">${esc(c.cueLicense)}</p>` : ""}
    <p><button data-clip="${c.idx}" data-v="aprovado">Aprovar</button> <button data-clip="${c.idx}" data-v="ajustar">Pedir ajuste</button> <input data-note="${c.idx}" placeholder="nota"></p></section>`).join("");
  const L = val.loudness;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de som</title><style>
  body{font:15px system-ui;background:#0f1117;color:#e7e9ee;margin:0;padding:24px;max-width:1200px}h1{margin-top:0}a{color:#7dd3fc}
  .clip{background:#181b24;border-radius:12px;padding:16px;margin:16px 0}.ab{display:grid;grid-template-columns:1fr 1fr;gap:12px}video{width:100%;border-radius:8px;background:#000}
  .wave{width:100%;max-width:900px;display:block;margin-top:8px}.warn{color:#fbbf24}.lic{color:#9aa3b2;font-size:13px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #2a2f3c;padding:6px;text-align:left}
  button{background:#2a3242;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;margin:2px}input{background:#11141b;border:1px solid #333;color:#fff;padding:5px;border-radius:6px}</style></head><body>
  <h1>Relatório de som</h1>
  <p>Exportação <code>${exportId}</code> · medido no MP4 exportado: ${L.stereo.integrated} LUFS integrados, true peak ${L.stereo.truePeak} dBTP (estéreo) · mono: ${L.mono.integrated} LUFS, ${L.mono.truePeak} dBTP · LRA ${L.stereo.lra} LU.</p>
  <p>Nenhuma afirmação de qualidade auditiva: ouça os trechos com fone e aprove ou peça ajuste. Desvios de cue medidos pela diferença A−B no áudio exportado.</p>
  <h2>Cinco trechos para conferir de fone</h2>${clipCards}
  <h2>Cues</h2><table><tr><th>id</th><th>cena</th><th>evento</th><th>categoria</th><th>quadro</th><th>alvo (s)</th><th>sincronismo</th><th>offset no arquivo (s)</th><th>desvio medido</th><th>licença/origem</th><th>revisão</th><th>deslocar</th></tr>${cueRows}</table>
  <p><small>Ações (aprovar, ajustar, deslocar) funcionam quando este relatório é aberto pelo aplicativo (Projeto → Som). Aberto direto do disco, ele é só leitura.</small></p>
  <script>const api=location.protocol.startsWith('http')?'/api/projects/${projectId}/som':null;
  document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||!api)return;
  if(b.dataset.cue){const r=await fetch(api+'/cues/'+b.dataset.cue+'/deslocar',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({frames:+b.dataset.d})});b.textContent=r.ok?'ok — reexporte para ouvir':'erro';}
  if(b.dataset.clip){const note=document.querySelector('[data-note="'+b.dataset.clip+'"]').value;const r=await fetch(api+'/trechos/${exportId}/'+b.dataset.clip,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({verdict:b.dataset.v,note})});b.textContent=r.ok?'registrado':'erro';}});</script>
  </body></html>`;
  fs.writeFileSync(path.join(dir, "RELATORIO_SOM.html"), html);
}
