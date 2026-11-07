import fs from "node:fs";
import path from "node:path";
import { db, j, now, uid } from "../db.js";
import { SOUNDS_DIR, VENDOR_DIR, projectDir } from "../paths.js";
import { SoundCue } from "../contracts.js";
import { analyzeSound, type SoundFeatures } from "./openverse.js";
import { frameAt } from "../pipeline/storyboard.js";
import { sha256, writeJson } from "../util.js";

/**
 * Mapa de momentos sonoros — método da skill `sound-effects` (motion-graphics, MIT; abordagem do
 * sound pass atribuída a Vox/@Voxyz_ai): lista de cues, um som real por cue, sem sintetizar bipes,
 * pontos de sincronismo MEDIDOS no arquivo, mixagem e prova com 5 trechos para fone.
 * Regra de sincronismo: tempo_alvo = frame·den/num ; início_do_arquivo = tempo_alvo − offset_do_ponto.
 */
const SFX_LIB = path.join(VENDOR_DIR, "motion-graphics", "skills", "sound-effects", "sfx");

export interface LibSound { file: string; category: string; source: string; license: string; credit: string; features?: SoundFeatures }

export function libraryIndex(): LibSound[] {
  const out: LibSound[] = [];
  const kit = path.join(SOUNDS_DIR, "openverse_manifest.json");
  if (fs.existsSync(kit)) for (const it of j<any>(fs.readFileSync(kit, "utf8"), { items: [] }).items) out.push({ file: path.join(SOUNDS_DIR, it.local), category: `whoosh-${it.role}`, source: it.openverse.foreign_landing_url, license: `${it.openverse.license.toUpperCase()} ${it.openverse.license_version}`, credit: `${it.openverse.title} — ${it.openverse.creator}` });
  const man = path.join(SFX_LIB, "manifest.json");
  if (fs.existsSync(man)) {
    const m = j<any>(fs.readFileSync(man, "utf8"), {});
    for (const e of m.bundled ?? []) {
      if (!e.file || /mixkit|runtime/i.test(String(e.license))) continue;
      out.push({ file: path.join(SFX_LIB, e.file), category: e.category, source: e.source_url ?? "", license: e.license ?? "CC0", credit: e.attribution ?? e.author ?? "" });
    }
  }
  return out.filter((s) => fs.existsSync(s.file));
}

const featCache = new Map<string, SoundFeatures>();
async function feat(file: string) { if (!featCache.has(file)) featCache.set(file, await analyzeSound(file)); return featCache.get(file)!; }

interface Moment { t: number; sceneKey: string; event: string; fn: string; category: string; sync: SoundCue["syncType"]; gainDb: number; shiftMs?: number }

/** Deriva os momentos do storyboard da versão atual (sem whoosh em todo corte). */
export function momentsFrom(scenes: any[]): Moment[] {
  const m: Moment[] = [];
  let lastWhoosh = -999, usedRoles = new Set<string>();
  for (const sc of scenes) {
    const shots = sc.data.shots as any[];
    shots.forEach((sh, i) => {
      const t = sh.t0;
      const text = `${sc.data.narration} ${sc.data.visualIntent}`.toLowerCase();
      if (sh.transitionIn === "whip" && t - lastWhoosh > 12) { m.push({ t, sceneKey: sc.stable_key, event: "corte em chicote (whip) para ação rápida", fn: "passagem rápida que conduz o olhar", category: "whoosh-passagem", sync: "pico", gainDb: -9 }); lastWhoosh = t; usedRoles.add("passagem"); }
      else if (i === 0 && sc.idx > 0 && t - lastWhoosh > 20 && /fug|corr|carro|estrada|de repente/.test(text) && !usedRoles.has("passagem")) { m.push({ t, sceneKey: sc.stable_key, event: "mudança de cena com movimento", fn: "passagem rápida", category: "whoosh-passagem", sync: "pico", gainDb: -10 }); lastWhoosh = t; usedRoles.add("passagem"); }
      else if (i === 0 && sc.idx > 0 && sh.setPiece !== scenes[sc.idx - 1]?.data.shots.at(-1)?.setPiece && t - lastWhoosh > 20) { m.push({ t, sceneKey: sc.stable_key, event: `mudança de ambiente para ${sh.setPiece}`, fn: "transição pesada que marca novo lugar", category: "whoosh-pesada", sync: "pico", gainDb: -11 }); lastWhoosh = t; usedRoles.add("pesada"); }
      if (sh.camera.move === "push-in" && sh.camera.intensity >= 0.85 && /revela|percebe|descobre|surpresa|então|aquilo|olhos/.test(text)) {
        m.push({ t: Math.max(sh.t0, sh.t1 - 1.0), sceneKey: sc.stable_key, event: "revelação no fim do push-in", fn: "movimento crescente para revelação", category: "whoosh-revelacao", sync: "pico", gainDb: -9 });
        m.push({ t: Math.max(sh.t0, sh.t1 - 2.2), sceneKey: sc.stable_key, event: "silêncio antes da revelação", fn: "silêncio intencional (sem efeito, trilha recua)", category: "silencio", sync: "silencio", gainDb: 0 });
        usedRoles.add("revelacao");
      }
      if (sh.camera.move === "tremor") m.push({ t: sh.t0 + 0.05, sceneKey: sc.stable_key, event: "impacto/susto", fn: "impacto que sustenta o tremor de câmera", category: "impact", sync: "ataque", gainDb: -12 });
    });
  }
  // garante pelo menos um uso de cada whoosh do kit (as três funções pedidas), em momentos reais
  const firstScene = scenes[1] ?? scenes[0];
  if (!m.some((x) => x.category === "whoosh-passagem") && firstScene) m.push({ t: firstScene.t0, sceneKey: firstScene.stable_key, event: "primeira virada da história", fn: "passagem rápida", category: "whoosh-passagem", sync: "pico", gainDb: -10 });
  const mid = scenes[Math.floor(scenes.length / 2)];
  if (!m.some((x) => x.category === "whoosh-pesada") && mid) m.push({ t: mid.t0, sceneKey: mid.stable_key, event: "virada do meio", fn: "transição pesada", category: "whoosh-pesada", sync: "pico", gainDb: -11 });
  const late = scenes[Math.max(0, scenes.length - 2)];
  if (!m.some((x) => x.category === "whoosh-revelacao") && late) m.push({ t: Math.max(late.t0, late.t1 - 1.5), sceneKey: late.stable_key, event: "revelação do clímax", fn: "movimento crescente", category: "whoosh-revelacao", sync: "pico", gainDb: -9 });
  return m.sort((a, b) => a.t - b.t);
}

export async function buildCues(projectId: string, scenes: any[], fps: { num: number; den: number }, masterDuration: number, timelineVersion: string) {
  const lib = libraryIndex();
  const moments = momentsFrom(scenes);
  const cues: SoundCue[] = [];
  let n = 0, impactAlt = 0;
  for (const mo of moments) {
    const frame = frameAt(mo.t, fps);
    const target = (frame * fps.den) / fps.num;
    if (mo.category === "silencio") {
      cues.push(SoundCue.parse({ id: `cue_${String(++n).padStart(3, "0")}`, sceneKey: mo.sceneKey, timelineVersion, event: mo.event, narrativeFunction: mo.fn, category: "silencio", file: null, source: "—", license: "—", fps, frame, targetTime: target, syncType: "silencio", syncOffset: 0, fileStart: target, duration: 1.2, gainDb: 0, fadeInMs: 0, fadeOutMs: 0, pan: 0, relation: "trilha recua 6 dB; fala intacta" }));
      continue;
    }
    let cands = lib.filter((s) => s.category === mo.category);
    if (mo.category === "impact") cands = cands.filter((s) => /cinematic|dramatic|heavy|explosion|524817/i.test(s.file));
    if (!cands.length) continue;
    const pick = mo.category === "impact" ? cands[impactAlt++ % cands.length] : cands[0];
    const f = await feat(pick.file);
    const offset = mo.sync === "pico" ? f.peakTime : mo.sync === "ataque" ? f.onsetTime : 0;
    let fileStart = target - offset;
    let shift = 0;
    let review: SoundCue["review"] = "proposto";
    if (fileStart < 0) { review = "ajustar"; shift = 0; } // não cortamos a preparação: marcado para ajuste de edição ou troca de som
    if (fileStart + f.duration > masterDuration + 2) review = "ajustar";
    cues.push(SoundCue.parse({
      id: `cue_${String(++n).padStart(3, "0")}`, sceneKey: mo.sceneKey, timelineVersion, event: mo.event, narrativeFunction: mo.fn, category: mo.category,
      file: pick.file, source: pick.source, license: pick.license, fps, frame, targetTime: target, syncType: mo.sync, syncOffset: offset, fileStart: Math.max(0, fileStart), duration: f.duration,
      intentionalShiftMs: shift, gainDb: mo.gainDb, fadeInMs: 0, fadeOutMs: Math.min(120, f.tailMs), pan: 0, relation: "abaixo da fala; não mascara a voz", review,
    }));
  }
  db().transaction(() => {
    db().prepare("UPDATE sound_cues SET status='desatualizado' WHERE project_id=?").run(projectId);
    for (const c of cues) db().prepare("INSERT INTO sound_cues(id,project_id,timeline_version,scene_key,data_json,status,created_at) VALUES(?,?,?,?,?,?,?)").run(uid("sc_"), projectId, timelineVersion, c.sceneKey, JSON.stringify(c), c.review, now());
  })();
  writeCueFiles(projectId, cues);
  return cues;
}

export function currentCues(projectId: string): SoundCue[] {
  return (db().prepare("SELECT data_json FROM sound_cues WHERE project_id=? AND status<>'desatualizado' ORDER BY created_at").all(projectId) as any[]).map((r) => j<SoundCue>(r.data_json, null as any));
}

/** Desloca um cue por N quadros (ferramenta do relatório). Recalcula tempos a partir do frame. */
export function shiftCue(projectId: string, cueId: string, frames: number) {
  const rows = db().prepare("SELECT id, data_json FROM sound_cues WHERE project_id=? AND status<>'desatualizado'").all(projectId) as any[];
  const row = rows.find((r) => j<any>(r.data_json, {}).id === cueId);
  if (!row) throw new Error("cue não encontrado");
  const c = j<SoundCue>(row.data_json, null as any);
  c.frame = Math.max(0, c.frame + frames);
  c.targetTime = (c.frame * c.fps.den) / c.fps.num;
  c.fileStart = Math.max(0, c.targetTime - c.syncOffset);
  c.review = "proposto";
  db().prepare("UPDATE sound_cues SET data_json=?, status='proposto' WHERE id=?").run(JSON.stringify(c), row.id);
  writeCueFiles(projectId, currentCues(projectId));
  return c;
}

export function writeCueFiles(projectId: string, cues: SoundCue[]) {
  const dir = path.join(projectDir(projectId), "sons");
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "CUES.json"), { generatedAt: new Date().toISOString(), quantization: "mixagem por amostra a 48 kHz: erro de posicionamento ≤ 1/96000 s (arredondamento ao inteiro mais próximo)", cues });
  const head = ["id", "cena", "versao_timeline", "evento", "funcao", "categoria", "arquivo", "fonte", "licenca", "fps", "frame", "tempo_alvo_s", "sincronismo", "offset_ponto_s", "inicio_arquivo_s", "duracao_s", "deslocamento_intencional_ms", "ganho_db", "fade_in_ms", "fade_out_ms", "pan", "relacao", "revisao"];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = cues.map((c) => [c.id, c.sceneKey, c.timelineVersion, c.event, c.narrativeFunction, c.category, c.file ? path.basename(c.file) : "", c.source, c.license, `${c.fps.num}/${c.fps.den}`, c.frame, c.targetTime.toFixed(6), c.syncType, c.syncOffset.toFixed(4), c.fileStart.toFixed(6), c.duration.toFixed(3), c.intentionalShiftMs, c.gainDb, c.fadeInMs, c.fadeOutMs, c.pan, c.relation, c.review].map(esc).join(","));
  fs.writeFileSync(path.join(dir, "CUES.csv"), "﻿" + [head.join(","), ...rows].join("\n"));
}

export const timelineVersionOf = (scenes: any[], masterId: string) => sha256(JSON.stringify([masterId, scenes.map((s) => [s.stable_key, s.t0, s.t1, s.data.shots])])).slice(0, 12);
