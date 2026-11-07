import { db, j, now, uid } from "../db.js";
import { sha256File, UserError } from "../util.js";

/**
 * REGRA CENTRAL — ÁUDIO PRIMEIRO.
 * O master de narração aprovado é o relógio do projeto. Nada visual de produção é aceito sem
 * uma aprovação válida (não revogada) vinculada ao hash do master MAIS RECENTE do projeto.
 * Isto é verificado no backend: ao enfileirar, ao iniciar e ao gravar o resultado de cada job.
 */

export const VISUAL_JOB_TYPES = new Set([
  "storyboard", "image", "scene_render", "ai_scene", "assemble", "sound_pass",
  "review_clips", "thumbnail", "short_assemble", "editorial_package_images",
]);

export const NEXT_ACTION_AUDIO = "Gerar e aprovar narração";

export interface Master {
  id: string; project_id: string; version: number; script_version: number; path: string;
  sha256: string; duration: number; sample_rate: number; status: string; origin: string;
  speakers_json: string; intervals_json: string; recipe_json: string; created_at: string;
}

export function latestMaster(projectId: string): Master | null {
  return (db().prepare("SELECT * FROM narration_masters WHERE project_id=? ORDER BY version DESC LIMIT 1").get(projectId) as Master) ?? null;
}

export function validApproval(projectId: string, masterId: string) {
  return db().prepare(
    `SELECT a.* FROM audio_approvals a JOIN narration_masters m ON m.id=a.master_id
     WHERE a.project_id=? AND a.master_id=? AND a.revoked_at IS NULL AND a.master_sha256=m.sha256
     ORDER BY a.approved_at DESC LIMIT 1`).get(projectId, masterId) as any | undefined;
}

/** Master aprovado atual, ou null. Um master mais novo sem aprovação bloqueia a produção. */
export function approvedMaster(projectId: string): Master | null {
  const m = latestMaster(projectId);
  if (!m) return null;
  return validApproval(projectId, m.id) ? m : null;
}

export function requireApprovedAudio(projectId: string): Master {
  const m = approvedMaster(projectId);
  if (!m) {
    const latest = latestMaster(projectId);
    const why = !latest
      ? "Este projeto ainda não tem narração completa."
      : `A narração v${latest.version} ainda não foi aprovada.`;
    throw new UserError(`${why} A produção visual fica bloqueada até a aprovação do áudio.`, 409, NEXT_ACTION_AUDIO);
  }
  return m;
}

/** Aprova um master específico. Recalcula o hash do arquivo para garantir que é o mesmo ouvido. */
export async function approveMaster(projectId: string, masterId: string, by: string, notes = "") {
  const m = db().prepare("SELECT * FROM narration_masters WHERE id=? AND project_id=?").get(masterId, projectId) as Master | undefined;
  if (!m) throw new UserError("Master não encontrado", 404);
  const latest = latestMaster(projectId)!;
  if (latest.id !== m.id) throw new UserError(`Existe uma versão mais nova (v${latest.version}). Aprove a versão atual.`, 409);
  const actual = await sha256File(m.path);
  if (actual !== m.sha256) throw new UserError("O arquivo do master mudou desde a geração; gere novamente.", 409);
  const pending = db().prepare("SELECT COUNT(*) n FROM speech_segments WHERE project_id=? AND script_version=? AND chosen_take_id IS NULL").get(projectId, m.script_version) as { n: number };
  if (pending.n > 0) throw new UserError(`${pending.n} trecho(s) ainda sem take escolhido.`, 409);
  const id = uid("apr_");
  db().transaction(() => {
    db().prepare("INSERT INTO audio_approvals(id,project_id,master_id,master_sha256,approved_at,approved_by,notes) VALUES(?,?,?,?,?,?,?)")
      .run(id, projectId, m.id, m.sha256, now(), by, notes);
    db().prepare("UPDATE narration_masters SET status='aprovado' WHERE id=?").run(m.id);
    db().prepare("UPDATE projects SET status='áudio aprovado', updated_at=? WHERE id=?").run(now(), projectId);
  })();
  return { approvalId: id, master: m };
}

/**
 * Chamado sempre que um novo master é gravado (texto, voz, velocidade, pausas ou emoção mudaram).
 * Não apaga nada: cenas/legendas da versão anterior ficam marcadas como desatualizadas e seus
 * arquivos continuam disponíveis até a nova versão ficar pronta.
 */
export function markDependentsStale(projectId: string, newMasterId: string, reason: string) {
  const d = db();
  const scenes = d.prepare("UPDATE scenes SET stale=1, stale_reason=?, updated_at=? WHERE project_id=? AND master_id<>? AND stale=0").run(reason, now(), projectId, newMasterId);
  const subs = d.prepare("UPDATE subtitle_tracks SET status='desatualizada' WHERE project_id=? AND master_id<>?").run(projectId, newMasterId);
  const cues = d.prepare("UPDATE sound_cues SET status='desatualizado' WHERE project_id=? AND status<>'desatualizado'").run(projectId);
  return { scenes: scenes.changes, subtitles: subs.changes, cues: cues.changes };
}

/** Lista o que ficou desatualizado em relação ao master aprovado atual. */
export function staleReport(projectId: string) {
  const scenes = db().prepare("SELECT stable_key, idx, stale_reason, master_id FROM scenes WHERE project_id=? AND stale=1 ORDER BY idx").all(projectId);
  const subs = db().prepare("SELECT id, kind, master_id FROM subtitle_tracks WHERE project_id=? AND status='desatualizada'").all(projectId);
  return { scenes, subtitles: subs };
}

/**
 * Transição atômica: só grava o resultado se o master que originou o job ainda é o aprovado atual.
 * Callbacks de versões antigas são descartados como "obsoletos".
 */
export function commitIfCurrent<T>(projectId: string, masterId: string, fn: () => T): { committed: true; value: T } | { committed: false; reason: string } {
  const d = db();
  return d.transaction(() => {
    const cur = approvedMaster(projectId);
    if (!cur || cur.id !== masterId) return { committed: false as const, reason: "resultado de uma versão de áudio que não é mais a aprovada" };
    return { committed: true as const, value: fn() };
  })();
}

export function masterIntervals(m: Master) {
  return j<{ segmentId: string; speaker: string; t0: number; t1: number; text: string }[]>(m.intervals_json, []);
}
