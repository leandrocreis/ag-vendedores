import fs from "node:fs";
import path from "node:path";
import { db, j, now, uid } from "../db.js";
import { projectDir } from "../paths.js";
import { engine, applyPronunciation, translateRecipe, type RecipePart } from "../providers/tts.js";
import { decodePcm, ffprobe, measureLoudness, run, sha256, sha256File, UserError, fmtTime } from "../util.js";
import { latestMaster, markDependentsStale, type Master } from "./audio-gate.js";
import type { ScriptDoc } from "../contracts.js";

export interface VoiceSetting { engine: string; voice: string; speed: number; language: string; recipe?: RecipePart[]; instruction?: string }
export type VoiceCast = Record<string, VoiceSetting>; // "narrador" | id de personagem

const LANG_TTS: Record<string, string> = { "pt-BR": "pt-br", "en-US": "en-us", es: "es", "fr-FR": "fr-fr", it: "it" };

export function getProject(id: string) {
  const p = db().prepare("SELECT * FROM projects WHERE id=?").get(id) as any;
  if (!p) throw new UserError("Projeto não encontrado", 404);
  return { ...p, settings: j<any>(p.settings_json, {}), bible: j<any>(p.bible_json, {}) };
}

export function voiceCast(projectId: string): VoiceCast {
  const p = getProject(projectId);
  const lang = LANG_TTS[p.settings.language] ?? "pt-br";
  const cast: VoiceCast = p.bible.voiceCast ?? {};
  if (!cast.narrador) cast.narrador = { engine: "kokoro", voice: "pm_alex", speed: 1.0, language: lang };
  return cast;
}
export function setVoiceCast(projectId: string, cast: VoiceCast) {
  const p = getProject(projectId);
  db().prepare("UPDATE projects SET bible_json=?, updated_at=? WHERE id=?").run(JSON.stringify({ ...p.bible, voiceCast: cast }), now(), projectId);
}

function pronunciations(projectId: string) {
  return db().prepare("SELECT term, say FROM pronunciations WHERE project_id=? OR project_id IS NULL").all(projectId) as { term: string; say: string }[];
}

/** Divide o roteiro em trechos de fala por locutor e intenção (antes de qualquer cena visual). */
export function splitIntoSegments(projectId: string, scriptVersion: number) {
  const sv = db().prepare("SELECT data_json FROM script_versions WHERE project_id=? AND version=?").get(projectId, scriptVersion) as any;
  if (!sv) throw new UserError("Versão de roteiro não encontrada", 404);
  const doc = j<ScriptDoc>(sv.data_json, null as any);
  const d = db();
  const existing = d.prepare("SELECT COUNT(*) n FROM speech_segments WHERE project_id=? AND script_version=?").get(projectId, scriptVersion) as any;
  if (existing.n > 0) return listSegments(projectId, scriptVersion);
  let idx = 0;
  d.transaction(() => {
    for (const sc of doc.scenes) {
      for (const line of sc.lines) {
        // frases muito longas viram trechos menores para permitir "refazer trecho"
        const parts = line.text.length > 260 ? line.text.match(/[^.!?…]+[.!?…]+["”»]?\s*|[^.!?…]+$/g) ?? [line.text] : [line.text];
        parts.forEach((t, k) => {
          d.prepare("INSERT INTO speech_segments(id,project_id,script_version,idx,scene_key,speaker,text,direction_json,pause_after_ms) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(uid("seg_"), projectId, scriptVersion, idx++, sc.key, line.speaker, t.trim(), JSON.stringify({ emotion: line.emotion }), k === parts.length - 1 ? line.pauseAfterMs : 120);
        });
      }
    }
  })();
  return listSegments(projectId, scriptVersion);
}

export function listSegments(projectId: string, scriptVersion: number) {
  return (db().prepare("SELECT * FROM speech_segments WHERE project_id=? AND script_version=? ORDER BY idx").all(projectId, scriptVersion) as any[]).map((s) => ({
    ...s, direction: j(s.direction_json, {}),
    takes: db().prepare("SELECT id, path, duration, engine, request_json, created_at FROM voice_tracks WHERE segment_id=? ORDER BY created_at").all(s.id).map((t: any) => ({ ...t, request: j(t.request_json, {}) })),
  }));
}

async function speakWith(setting: VoiceSetting, text: string, out: string, projectId: string, emotion?: string) {
  const e = engine(setting.engine);
  let blend: { voice: string; weight: number }[] | undefined;
  let instruction = setting.instruction;
  if (setting.recipe?.length) {
    const tr = await translateRecipe(setting.engine, setting.recipe);
    blend = tr.blend;
    instruction = [instruction, tr.instruction].filter(Boolean).join(" ") || undefined;
  }
  const ctrl = await e.controls();
  if (emotion && ctrl["emoção"].support === "instrução textual") instruction = [instruction, `Emoção: ${emotion}.`].filter(Boolean).join(" ");
  const spoken = applyPronunciation(text, pronunciations(projectId));
  return e.speak({ text: spoken, voice: setting.voice, speed: setting.speed, language: setting.language, instruction, blend, emotion }, out);
}

/** "Ouvir com meu texto": amostra curta gerada com EXATAMENTE a configuração atual. */
export async function sampleVoice(projectId: string, setting: VoiceSetting, text: string) {
  const dir = path.join(projectDir(projectId), "voz", "amostras");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `amostra_${Date.now()}.wav`);
  const r = await speakWith(setting, text.slice(0, 400), out, projectId);
  return { ...r, setting };
}

export async function synthSegment(projectId: string, segmentId: string, override?: VoiceSetting, force = false) {
  const s = db().prepare("SELECT * FROM speech_segments WHERE id=? AND project_id=?").get(segmentId, projectId) as any;
  if (!s) throw new UserError("Trecho não encontrado", 404);
  const cast = voiceCast(projectId);
  const setting = override ?? cast[s.speaker] ?? cast.narrador;
  const dir = path.join(projectDir(projectId), "voz", `roteiro_v${s.script_version}`, "takes");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${String(s.idx).padStart(4, "0")}_${Date.now()}.wav`);
  const dirn = j<any>(s.direction_json, {});
  // Cache por conteúdo: mesmo texto falado + mesma configuração de voz + mesma emoção ⇒ reaproveita o take
  // (regenera só os trechos que mudaram). "Refazer trecho" força um take novo.
  const cacheKey = sha256(JSON.stringify([applyPronunciation(s.text, pronunciations(projectId)), setting, dirn.emotion ?? null]));
  const cacheFile = path.join(projectDir(projectId), "voz", "cache", `${cacheKey}.wav`);
  if (!force && fs.existsSync(cacheFile)) {
    fs.copyFileSync(cacheFile, out);
    const info = await ffprobe(out);
    const id = uid("take_");
    db().prepare("INSERT INTO voice_tracks(id,segment_id,path,sha256,duration,engine,request_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, segmentId, out, await sha256File(out), info.duration, setting.engine, JSON.stringify({ setting, reusedFromCache: cacheKey }), now());
    if (!s.chosen_take_id) db().prepare("UPDATE speech_segments SET chosen_take_id=?, status='gerado' WHERE id=?").run(id, segmentId);
    return { takeId: id, path: out, duration: info.duration, sampleRate: 0, request: { setting }, engine: setting.engine, controlsApplied: {}, cached: true };
  }
  const r = await speakWith(setting, s.text, out, projectId, dirn.emotion);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.copyFileSync(out, cacheFile);
  const id = uid("take_");
  db().prepare("INSERT INTO voice_tracks(id,segment_id,path,sha256,duration,engine,request_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, segmentId, out, await sha256File(out), r.duration, r.engine, JSON.stringify({ ...r.request, setting, controlsApplied: r.controlsApplied }), now());
  if (!s.chosen_take_id) db().prepare("UPDATE speech_segments SET chosen_take_id=?, status='gerado' WHERE id=?").run(id, segmentId);
  return { takeId: id, ...r };
}

export function chooseTake(segmentId: string, takeId: string) {
  const t = db().prepare("SELECT 1 FROM voice_tracks WHERE id=? AND segment_id=?").get(takeId, segmentId);
  if (!t) throw new UserError("Take não pertence ao trecho", 400);
  db().prepare("UPDATE speech_segments SET chosen_take_id=?, status='gerado' WHERE id=?").run(takeId, segmentId);
}

export function updateSegment(segmentId: string, patch: { text?: string; pauseAfterMs?: number; emotion?: string; speaker?: string }) {
  const s = db().prepare("SELECT * FROM speech_segments WHERE id=?").get(segmentId) as any;
  if (!s) throw new UserError("Trecho não encontrado", 404);
  const dir = { ...j<any>(s.direction_json, {}), ...(patch.emotion ? { emotion: patch.emotion } : {}) };
  const textChanged = patch.text != null && patch.text !== s.text;
  const speakerChanged = patch.speaker != null && patch.speaker !== s.speaker;
  db().prepare("UPDATE speech_segments SET text=?, pause_after_ms=?, direction_json=?, speaker=?, chosen_take_id=CASE WHEN ? THEN NULL ELSE chosen_take_id END, status=CASE WHEN ? THEN 'pendente' ELSE status END WHERE id=?")
    .run(patch.text ?? s.text, patch.pauseAfterMs ?? s.pause_after_ms, JSON.stringify(dir), patch.speaker ?? s.speaker, textChanged || speakerChanged ? 1 : 0, textChanged || speakerChanged ? 1 : 0, segmentId);
  return { needsNewTake: textChanged || speakerChanged, needsNewMaster: true };
}

/**
 * Monta o MASTER de narração: takes escolhidos, em ordem, com as pausas definidas, nivelados
 * para a mesma loudness (sem saltos entre trechos), micro-fades de 6 ms contra cliques,
 * WAV 48 kHz 24-bit (formato intermediário sem compressão). Cada montagem = nova versão.
 */
export async function buildMaster(projectId: string, scriptVersion: number, onProgress?: (p: number, l: string) => void) {
  const segs = listSegments(projectId, scriptVersion);
  if (!segs.length) throw new UserError("Sem trechos de fala", 400);
  const missing = segs.filter((s) => !s.chosen_take_id);
  if (missing.length) throw new UserError(`${missing.length} trecho(s) sem take: gere a narração completa primeiro.`, 409);
  const prev = latestMaster(projectId);
  const version = (prev?.version ?? 0) + 1;
  const dir = path.join(projectDir(projectId), "voz", "masters");
  fs.mkdirSync(dir, { recursive: true });
  const SR = 48000;
  const parts: Float32Array[] = [];
  const intervals: { segmentId: string; speaker: string; t0: number; t1: number; text: string; sceneKey: string; pauseAfterMs: number }[] = [];
  let cursor = 0;
  const TARGET_LUFS = -20;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const take = s.takes.find((t: any) => t.id === s.chosen_take_id);
    onProgress?.(i / segs.length, `Nivelando trecho ${i + 1}/${segs.length}`);
    const pcm = await decodePcm(take.path, SR, 1);
    const L = await measureLoudness(take.path);
    const gain = Number.isFinite(L.integrated) ? Math.pow(10, Math.max(-12, Math.min(12, TARGET_LUFS - L.integrated)) / 20) : 1;
    const fade = Math.round(0.006 * SR);
    for (let k = 0; k < pcm.length; k++) {
      let g = gain;
      if (k < fade) g *= k / fade;
      if (k > pcm.length - fade) g *= (pcm.length - k) / fade;
      pcm[k] = Math.max(-0.98, Math.min(0.98, pcm[k] * g));
    }
    const t0 = cursor / SR;
    parts.push(pcm);
    cursor += pcm.length;
    intervals.push({ segmentId: s.id, speaker: s.speaker, t0, t1: cursor / SR, text: s.text, sceneKey: s.scene_key, pauseAfterMs: s.pause_after_ms });
    const pause = Math.round((s.pause_after_ms / 1000) * SR);
    parts.push(new Float32Array(pause));
    cursor += pause;
  }
  const all = new Float32Array(cursor);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const raw = path.join(dir, `master_v${version}.f32`);
  fs.writeFileSync(raw, Buffer.from(all.buffer));
  const out = path.join(dir, `narracao_master_v${version}.wav`);
  const r = await run("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", raw, "-c:a", "pcm_s24le", out]);
  fs.unlinkSync(raw);
  if (r.code !== 0) throw new Error("ffmpeg falhou ao gravar master: " + r.stderr.slice(0, 300));
  const info = await ffprobe(out);
  const hash = await sha256File(out);
  const cast = voiceCast(projectId);
  const speakers = [...new Set(segs.map((s) => s.speaker))].map((sp) => ({ speaker: sp, ...(cast[sp] ?? cast.narrador) }));
  const id = uid("mst_");
  const recipe = { cast, segments: segs.map((s) => ({ id: s.id, take: s.chosen_take_id, pauseAfterMs: s.pause_after_ms, emotion: s.direction?.emotion })), levelingLufs: TARGET_LUFS, sampleRate: SR, format: "WAV PCM 24-bit mono" };
  db().prepare(`INSERT INTO narration_masters(id,project_id,version,script_version,path,sha256,duration,sample_rate,speakers_json,intervals_json,recipe_json,origin,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, version, scriptVersion, out, hash, info.duration, SR, JSON.stringify(speakers), JSON.stringify(intervals), JSON.stringify(recipe), "tts", "aguardando revisão", now());
  const stale = markDependentsStale(projectId, id, `Narração mudou (nova versão v${version}); refaça só o que depende dela.`);
  db().prepare("UPDATE projects SET status='aguardando aprovação do áudio', updated_at=? WHERE id=?").run(now(), projectId);
  return { masterId: id, version, duration: info.duration, sha256: hash, path: out, stale, durationCheck: durationCheck(projectId, info.duration) };
}

/** A duração é ajustada pelo ROTEIRO (nunca esticando imagem ou acelerando a voz). */
export function durationCheck(projectId: string, duration: number) {
  const p = getProject(projectId);
  const target = p.settings.targetSeconds as number, tol = p.settings.toleranceSeconds as number;
  const diff = duration - target;
  const within = Math.abs(diff) <= tol;
  let longRange: string | null = null;
  if (p.kind === "long" && (duration < 300 || duration > 600)) longRange = "O vídeo longo precisa ficar entre 300 e 600 segundos.";
  return {
    target, tolerance: tol, duration, diff, within: within && !longRange, longRange,
    advice: within && !longRange ? "Duração dentro da meta." : diff > 0
      ? `Narração ${Math.round(diff)} s acima da meta: encurte cenas no roteiro e regenere os trechos afetados (ou altere a meta).`
      : `Narração ${Math.round(-diff)} s abaixo da meta: desenvolva cenas no roteiro e regenere (ou altere a meta). Não esticamos imagens nem desaceleramos a voz.`,
  };
}

/** Upload de narração própria: vira um master (origin=upload) com um único intervalo por enquanto. */
export async function masterFromUpload(projectId: string, scriptVersion: number, file: string) {
  const prev = latestMaster(projectId);
  const version = (prev?.version ?? 0) + 1;
  const dir = path.join(projectDir(projectId), "voz", "masters");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `narracao_master_v${version}.wav`);
  const r = await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s24le", out]);
  if (r.code !== 0) throw new UserError("Arquivo de áudio inválido: " + r.stderr.slice(0, 200));
  const info = await ffprobe(out);
  const id = uid("mst_");
  db().prepare(`INSERT INTO narration_masters(id,project_id,version,script_version,path,sha256,duration,sample_rate,speakers_json,intervals_json,recipe_json,origin,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, version, scriptVersion, out, await sha256File(out), info.duration, 48000, JSON.stringify([{ speaker: "upload" }]), JSON.stringify([]), JSON.stringify({ upload: path.basename(file) }), "upload", "aguardando revisão", now());
  // trechos do roteiro são marcados com o take "upload" para permitir aprovação
  db().prepare("UPDATE speech_segments SET chosen_take_id='upload', status='upload' WHERE project_id=? AND script_version=?").run(projectId, scriptVersion);
  markDependentsStale(projectId, id, `Narração enviada (v${version}).`);
  return { masterId: id, version, duration: info.duration };
}

/* ----------------------- Qualidade da amostra de clonagem ----------------------- */
export async function analyzeReference(file: string) {
  const info = await ffprobe(file);
  const pcm = await decodePcm(file, 16000, 1);
  let peak = 0, clip = 0;
  for (const v of pcm) { const a = Math.abs(v); if (a > peak) peak = a; if (a > 0.995) clip++; }
  const win = 800; // 50 ms
  const rms: number[] = [];
  for (let i = 0; i + win <= pcm.length; i += win) { let s = 0; for (let k = i; k < i + win; k++) s += pcm[k] * pcm[k]; rms.push(Math.sqrt(s / win)); }
  const sorted = [...rms].sort((a, b) => a - b);
  const db_ = (x: number) => 20 * Math.log10(Math.max(1e-9, x));
  const floor = db_(sorted[Math.floor(sorted.length * 0.1)] ?? 0), speech = db_(sorted[Math.floor(sorted.length * 0.9)] ?? 0);
  const silentRatio = rms.filter((r) => db_(r) < -45).length / Math.max(1, rms.length);
  const issues: string[] = [];
  if (info.duration < 5) issues.push("Muito curta (<5 s). A maioria dos motores pede 6–30 s de fala limpa.");
  if (info.duration > 60) issues.push("Muito longa (>60 s); recorte um trecho limpo.");
  if (clip / pcm.length > 0.0005) issues.push("Clipping detectado: grave com ganho menor.");
  if (speech - floor < 25) issues.push(`Ruído de fundo alto (relação fala/ruído ≈ ${Math.round(speech - floor)} dB).`);
  if (silentRatio > 0.4) issues.push("Muito silêncio na amostra.");
  return { duration: info.duration, peakDb: db_(peak), noiseFloorDb: floor, speechLevelDb: speech, snrDb: speech - floor, silentRatio, clippingRatio: clip / pcm.length, issues, multiSpeaker: "não verificado (sem detector de locutores instalado; o VoiceStudio tem diarização opcional)" };
}

/* ------------------------------- legendas SRT ------------------------------- */
export function buildSrt(intervals: { t0: number; t1: number; text: string }[], words: { t0: number; t1: number; word: string }[] | null, maxChars = 84) {
  const cues: { t0: number; t1: number; text: string; estimated: boolean }[] = [];
  for (const iv of intervals) {
    const chunks: string[] = [];
    let cur = "";
    for (const w of iv.text.split(/\s+/)) {
      if ((cur + " " + w).trim().length > maxChars && cur) { chunks.push(cur.trim()); cur = w; } else cur += " " + w;
    }
    if (cur.trim()) chunks.push(cur.trim());
    const total = chunks.reduce((s, c) => s + c.length, 0) || 1;
    let t = iv.t0;
    const ivWords = words?.filter((w) => w.t0 >= iv.t0 - 0.15 && w.t1 <= iv.t1 + 0.3) ?? [];
    let wi = 0;
    for (const c of chunks) {
      const n = c.split(/\s+/).length;
      let t0 = t, t1 = t + ((iv.t1 - iv.t0) * c.length) / total, est = true;
      if (ivWords.length >= wi + n) { t0 = ivWords[wi].t0; t1 = ivWords[wi + n - 1].t1; est = false; }
      wi += n;
      cues.push({ t0: Math.max(iv.t0, t0), t1: Math.min(iv.t1 + 0.25, Math.max(t1, t0 + 0.8)), text: c, estimated: est });
      t = t1;
    }
  }
  const srt = cues.map((c, i) => `${i + 1}\n${fmtTime(c.t0)} --> ${fmtTime(c.t1)}\n${wrap2(c.text)}\n`).join("\n");
  return { srt, cues };
}
function wrap2(t: string) {
  if (t.length <= 42) return t;
  const mid = t.lastIndexOf(" ", Math.ceil(t.length / 2) + 4);
  return mid > 0 ? t.slice(0, mid) + "\n" + t.slice(mid + 1) : t;
}

export type { Master };
