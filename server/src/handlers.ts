import fs from "node:fs";
import path from "node:path";
import { db, j, now, uid } from "./db.js";
import { projectDir } from "./paths.js";
import type { JobRow } from "./jobs.js";
import { generateScriptViaApi } from "./pipeline/script.js";
import { listSegments, synthSegment, buildMaster, getProject } from "./pipeline/narration.js";
import { alignApproved } from "./pipeline/align.js";
import { buildStoryboard, listScenes } from "./pipeline/storyboard.js";
import { requireApprovedAudio, commitIfCurrent } from "./pipeline/audio-gate.js";
import { assembleLong, renderScenes, reviewClips } from "./render/assemble.js";
import { refreshCatalog, getStyleVersion } from "./catalog/catalog.js";
import { ensureStyleDemo } from "./render/demo.js";
import { fetchWhooshes, writeKit } from "./sound/openverse.js";
import { generateImage, sizeFor, estimateImages } from "./providers/openai-images.js";
import { assertBudget } from "./budget.js";
import { localGenerate, runpodGenerate, planAiClips, VIDEO_LIMITS } from "./providers/video.js";
import { assembleShort } from "./pipeline/shorts.js";
import { runEditorialSkill } from "./editorial/skills.js";
import { sha256File, UserError } from "./util.js";

export interface HCtx { job: JobRow; payload: any; progress: (p: number, label: string, estimated?: boolean) => void; log: (s: string) => void; signal: AbortSignal }
type Handler = (c: HCtx) => Promise<unknown>;

export const HANDLERS: Record<string, Handler> = {
  async catalog_refresh() { return refreshCatalog(); },
  async style_demo({ payload }) {
    const s = getStyleVersion(payload.styleId);
    if (!s) throw new UserError("Estilo não encontrado", 404);
    return { path: await ensureStyleDemo(s) };
  },
  async openverse_kit({ log }) {
    const r = await fetchWhooshes(log);
    if (r.chosen.length < 3) throw new UserError("Menos de três candidatos válidos no Openverse; etapa pendente (configure credenciais ou importe manualmente).");
    return { items: (await writeKit(r.chosen)).map((m: any) => m.local) };
  },
  async script_generate({ job, payload }) {
    return generateScriptViaApi(job.project_id!, job.id, payload.revisionNote);
  },
  /** Narração completa: sintetiza todos os trechos sem take e monta o master (nova versão). */
  async narration_full({ job, payload, progress, signal, log }) {
    const pid = job.project_id!;
    const segs = listSegments(pid, payload.scriptVersion);
    const todo = segs.filter((s) => !s.chosen_take_id || payload.regenerateAll);
    let i = 0;
    for (const s of todo) {
      if (signal.aborted) throw new Error("cancelado");
      progress(i / Math.max(1, todo.length) * 0.85, `Voz: trecho ${i + 1}/${todo.length}`);
      await synthSegment(pid, s.id);
      i++;
    }
    log(`${todo.length} trecho(s) sintetizados`);
    const r = await buildMaster(pid, payload.scriptVersion, (p, l) => progress(0.85 + p * 0.15, l));
    return r;
  },
  async segment_take({ job, payload }) { return synthSegment(job.project_id!, payload.segmentId, payload.override, true); },
  async master_build({ job, payload, progress }) { return buildMaster(job.project_id!, payload.scriptVersion, (p, l) => progress(p, l)); },
  async align({ job, progress }) { return alignApproved(job.project_id!, (p, l) => progress(p, l)); },
  async storyboard({ job }) { return buildStoryboard(job.project_id!); },
  async scene_render({ job, payload, progress, signal, log }) {
    return renderScenes(job.project_id!, { progress, signal, log }, payload.keys, payload.format ?? "16:9");
  },
  async assemble({ job, payload, progress, signal, log }) {
    const r = await assembleLong(job.project_id!, { progress, signal, log }, { format: payload.format, music: payload.music });
    progress(0.96, "Cortando os cinco trechos de revisão");
    const clips = await reviewClips(job.project_id!, r.exportId);
    return { ...r, reviewClips: clips.map((c) => c.file) };
  },
  async review_clips({ job, payload }) { return reviewClips(job.project_id!, payload.exportId); },
  async short_assemble({ job, payload, progress, signal, log }) { return assembleShort(job.project_id!, { progress, signal, log }, payload); },
  /** Imagens OpenAI só das cenas escolhidas; ativos válidos não são gerados de novo. */
  async image({ job, payload, progress, log }) {
    const pid = job.project_id!;
    const m = requireApprovedAudio(pid);
    const p = getProject(pid);
    const scenes = listScenes(pid).filter((s) => payload.keys.includes(s.stable_key));
    const out: any[] = [];
    let i = 0;
    for (const s of scenes) {
      for (const role of payload.roles ?? ["fundo"]) {
        const media = (s.data.media ?? []) as any[];
        const exists = media.find((x) => x.role === role && x.assetId && db().prepare("SELECT 1 FROM assets WHERE id=?").get(x.assetId));
        if (exists && !payload.force) { log(`${s.stable_key}/${role}: imagem válida existente, não regenerada`); continue; }
        const est = estimateImages(1);
        assertBudget(pid, est.usd, "imagem OpenAI");
        progress(i++ / (scenes.length * (payload.roles?.length ?? 1)), `Imagem ${s.stable_key} (${role})`);
        const prompt = imagePrompt(p, s, role);
        const file = path.join(projectDir(pid), "imagens", `${s.stable_key}_${role}_${Date.now()}.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const refs = role === "personagem" ? characterRefs(pid, s.data.characters) : [];
        const r = await generateImage({ prompt, size: sizeFor(p.settings.format, role === "personagem" ? "personagem" : "fundo"), outPath: file, references: refs, projectId: pid, jobId: job.id });
        const aid = uid("ast_");
        const c = commitIfCurrent(pid, m.id, () => {
          db().prepare("INSERT INTO assets(id,project_id,kind,path,sha256,mime,provenance_json,scene_key,approved,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(aid, pid, `imagem-${role}`, file, "", "image/png", JSON.stringify({ provider: "openai", model: r.model, size: r.size, quality: r.quality, prompt, references: refs }), s.stable_key, 1, now());
          const data = { ...s.data, media: [...media.filter((x) => x.role !== role), { role, assetId: aid, prompt }] };
          db().prepare("UPDATE scenes SET data_json=?, render_hash=NULL, updated_at=? WHERE id=?").run(JSON.stringify(data), now(), s.id);
        });
        if (!c.committed) throw new UserError(c.reason, 409);
        db().prepare("UPDATE assets SET sha256=? WHERE id=?").run(await sha256File(file), aid);
        out.push({ scene: s.stable_key, role, asset: aid });
      }
    }
    return out;
  },
  /** Cenas por IA: somente as cenas selecionadas; clipes ≤ limite do modelo; áudio embutido descartado. */
  async ai_scene({ job, payload, progress, signal }) {
    const pid = job.project_id!;
    const m = requireApprovedAudio(pid);
    const p = getProject(pid);
    if (!p.settings.aiScenes?.enabled) throw new UserError("Cenas por IA estão desligadas neste projeto.", 409);
    const where = p.settings.aiScenes.where;
    const scenes = listScenes(pid).filter((s) => payload.keys.includes(s.stable_key));
    const results: any[] = [];
    for (const s of scenes) {
      const plan = planAiClips(s.t0, s.t1);
      const clips: any[] = [];
      for (let k = 0; k < plan.length; k++) {
        progress((results.length + k / plan.length) / scenes.length, `IA ${where}: ${s.stable_key} clipe ${k + 1}/${plan.length}`, true);
        const vertical = p.settings.format === "9:16";
        const req = { prompt: s.data.ai?.prompt || aiPrompt(p, s), width: vertical ? 480 : 832, height: vertical ? 832 : 480, numFrames: plan[k].numFrames, fps: VIDEO_LIMITS.fps, seed: (s.data.ai?.seed ?? 42) + k, model: p.settings.aiScenes.model };
        const out = path.join(projectDir(pid), "ia", `${s.stable_key}_${k}_${Date.now()}.mp4`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const r = where === "runpod" ? await runpodGenerate(job.id, req, out, { signal, projectId: pid }) : await localGenerate(req, out, signal);
        clips.push({ ...plan[k], path: r.path, duration: r.duration, audioDiscarded: r.audioDiscarded });
      }
      const c = commitIfCurrent(pid, m.id, () => {
        db().prepare("UPDATE scenes SET data_json=?, render_hash=NULL, updated_at=? WHERE id=?").run(JSON.stringify({ ...s.data, ai: { ...s.data.ai, use: true, where, status: "pronto", clips } }), now(), s.id);
      });
      if (!c.committed) throw new UserError(c.reason, 409);
      results.push({ scene: s.stable_key, clips: clips.length });
    }
    return results;
  },
  async editorial({ job, payload }) { return runEditorialSkill(job.project_id, payload.skill, payload.input ?? {}, job.id); },
};

function imagePrompt(p: any, s: any, role: string) {
  const lock = j<any>(p.style_lock_json, {});
  const style = getStyleVersion(p.settings.styleId ?? "autoral:cartoon-narrativo", lock.hash);
  const chars = (db().prepare("SELECT stable_key, data_json FROM characters WHERE project_id=?").all(p.id) as any[]).filter((c) => s.data.characters.includes(c.stable_key)).map((c) => j<any>(c.data_json, {}));
  return [
    `${role === "fundo" ? "Cenário de fundo SEM personagens e SEM texto" : "Personagem de corpo inteiro, fundo liso neutro para recorte, sem texto"} para uma animação em camadas.`,
    `Estilo: ${style?.nameOriginal ?? "Cartoon narrativo cinematográfico"}. ${(style?.stylePrompt ?? "").slice(0, 900)}`,
    style?.palette?.length ? `Paleta: ${style.palette.join(", ")}.` : "",
    `Cena: ${s.data.visualIntent}. Ambiente: ${s.data.setting}. Luz: ${s.data.shots[0]?.light}.`,
    role === "personagem" ? chars.map((c) => `${c.name}: ${c.physical}; roupas: ${c.clothes}; cores: ${c.colors?.join(", ")}; proporções: ${c.proportions}; acessórios: ${c.accessories?.join(", ")}`).join(" | ") : "",
    "Composição com espaço para movimento de câmera (margens amplas), sem legendas nem letreiros.",
  ].filter(Boolean).join("\n");
}
function aiPrompt(p: any, s: any) {
  return `${s.data.visualIntent}. ${s.data.actions.join(". ")}. Estilo ${p.settings.styleId}. Câmera: ${s.data.shots[0]?.camera.move}. Sem texto na tela.`;
}
function characterRefs(pid: string, keys: string[]) {
  return (db().prepare(`SELECT a.path FROM characters c JOIN assets a ON a.id=c.ref_asset_id WHERE c.project_id=? AND c.stable_key IN (${keys.map(() => "?").join(",") || "''"})`).all(pid, ...keys) as any[]).map((r) => r.path).filter((f) => fs.existsSync(f));
}
