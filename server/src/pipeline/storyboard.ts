import fs from "node:fs";
import path from "node:path";
import { db, j, now, uid } from "../db.js";
import { projectDir } from "../paths.js";
import { SceneData, type ShotPlan, type ScriptDoc } from "../contracts.js";
import { requireAlignment } from "./align.js";
import { commitIfCurrent, masterIntervals, type Master } from "./audio-gate.js";
import { effectiveStyle } from "../catalog/catalog.js";
import { getProject } from "./narration.js";
import type { EngineScene } from "../render/renderer.js";
import { UserError } from "../util.js";

/* ------------ tradução heurística (determinística) texto → plano visual ------------ */
const has = (t: string, re: RegExp) => re.test(t.toLowerCase());
export function guessSetPiece(text: string): string {
  if (has(text, /cabana|casa|porta|janela|quarto|sala|dentro/)) return "cabana-interior";
  if (has(text, /estrada|rodovia|carro|asfalto|caminhonete|posto/)) return "estrada";
  if (has(text, /cidade|prédio|rua|vila|bairro/)) return "cidade";
  if (has(text, /lago|rio|margem|água/)) return "lago";
  if (has(text, /barraca|acampa|fogueira|camping/)) return "acampamento";
  return "floresta";
}
function guessLight(text: string): ShotPlan["light"] {
  if (has(text, /lanterna/)) return "lanterna";
  if (has(text, /fogueira|fogo|brasa/)) return "fogueira";
  if (has(text, /alarme|sirene|emergência|vermelh/)) return "alerta";
  if (has(text, /amanhec|manhã|sol nasc|dia claro|meio-dia/)) return "dia";
  if (has(text, /entardecer|pôr do sol|crepúsculo/)) return "entardecer";
  return "noite";
}
function guessAction(text: string) {
  if (has(text, /corr|fug|dispar|sprint/)) return "run";
  if (has(text, /lanterna/)) return "flashlight";
  if (has(text, /escond|agach|abaix|rasteja/)) return "crouch";
  if (has(text, /cai|tropeç|desaba/)) return "fall";
  if (has(text, /estend|alcanç|agarr|pega/)) return "reach";
  if (has(text, /anda|caminh|segue|avança/)) return "walk";
  if (has(text, /olha|observa|escuta|ouve|procura/)) return "look";
  return "idle";
}
function guessCamera(text: string, i: number, n: number, emotion: string): ShotPlan["camera"] {
  const e = (emotion + " " + text).toLowerCase();
  if (/explos|impacto|bate|trem|grito|ataque/.test(e)) return { move: "tremor", shot: "medio", intensity: 0.7 };
  if (/revela|percebe|descobre|surpresa|silêncio/.test(e)) return { move: "push-in", shot: i === n - 1 ? "close" : "medio", intensity: 0.9 };
  if (/corr|fug|persegu/.test(e)) return { move: "travelling", shot: "medio", intensity: 0.8 };
  if (/medo|tens|suspense/.test(e)) return { move: "push-in", shot: "medio", intensity: 0.5 };
  const cycle: ShotPlan["camera"]["move"][] = ["push-in", "pan-dir", "pull-out", "pan-esq"];
  return { move: cycle[i % 4], shot: i === 0 ? "geral" : "medio", intensity: 0.4 };
}
function guessFx(text: string, light: string) {
  const f: string[] = [];
  if (has(text, /chuva|tempestade/)) f.push("chuva");
  if (has(text, /neblina|névoa|nevoeiro/)) f.push("neblina");
  if (light === "fogueira") f.push("brasas");
  if (has(text, /olhos|vulto|sombra|algo no escuro/)) f.push("olhos");
  if (has(text, /vento|folhas/)) f.push("folhas");
  return f;
}
function guessProps(text: string, setPiece: string) {
  const p: string[] = [];
  if (setPiece === "acampamento" || has(text, /barraca/)) p.push("barraca");
  if (setPiece === "acampamento" || has(text, /fogueira/)) p.push("fogueira");
  if (has(text, /carro|caminhonete/)) p.push("carro");
  if (has(text, /mochila/)) p.push("mochila");
  if (has(text, /rádio|radio/)) p.push("radio");
  return [...new Set(p)];
}
const ZOMBIE = /zumbi|morto-vivo|mortos|infectad|criatura|coisa|aquilo/;

export function planShots(sceneText: string, sc: ScriptDoc["scenes"][number] | undefined, t0: number, t1: number, cuts: number[], characters: string[], first: boolean): ShotPlan[] {
  // planos de 3–8 s, cortados em fronteiras REAIS de frases do master
  const bounds = [t0];
  for (const c of cuts) if (c - bounds[bounds.length - 1] >= 3 && t1 - c >= 3) bounds.push(c);
  const merged: number[] = [bounds[0]];
  for (let i = 1; i < bounds.length; i++) if (bounds[i] - merged[merged.length - 1] >= 3) merged.push(bounds[i]);
  // divide planos longos (>8 s) ao meio
  const final: number[] = [];
  const all = [...merged, t1];
  for (let i = 0; i < all.length - 1; i++) { final.push(all[i]); let d = all[i + 1] - all[i]; let k = Math.ceil(d / 8); for (let m = 1; m < k; m++) final.push(all[i] + (d * m) / k); }
  final.push(t1);
  const text = (sc ? [sc.visualIntent, sc.camera, sc.emotion, ...sc.actions].join(" ") : "") + " " + sceneText;
  const setPiece = guessSetPiece((sc?.setting ?? "") + " " + text);
  const light = guessLight(text);
  const protagonist = characters[0] ?? "voce";
  const zombieScene = ZOMBIE.test(text.toLowerCase());
  const n = final.length - 1;
  return Array.from({ length: n }, (_, i) => {
    const a = final[i], b = final[i + 1];
    const actText = sc?.actions[Math.min(i, (sc?.actions.length ?? 1) - 1)] ?? sceneText;
    const action = guessAction(actText);
    const actors: ShotPlan["actors"] = [{ id: protagonist, action, x: action === "run" ? 0.38 : 0.42, facing: "dir" }];
    if (zombieScene && (i > 0 || n === 1)) actors.push({ id: "zumbi", action: "lurch", x: action === "run" ? 0.1 : 0.78, facing: action === "run" ? "dir" : "esq" });
    return {
      t0: a, t1: b, setPiece, camera: guessCamera(actText, i, n, sc?.emotion ?? ""), actors, props: guessProps(text, setPiece), fx: guessFx(text, light), light,
      transitionIn: i === 0 ? (first ? "escuro" : /corr|fug/.test(actText) ? "whip" : "corte") : "corte", caption: null,
    } as ShotPlan;
  });
}

/* ------------------------------ storyboard ------------------------------ */
export function buildStoryboard(projectId: string) {
  const { master, alignment } = requireAlignment(projectId);
  const p = getProject(projectId);
  const sv = db().prepare("SELECT data_json FROM script_versions WHERE project_id=? AND version=?").get(projectId, master.script_version) as any;
  const doc = j<ScriptDoc>(sv?.data_json, null as any);
  const ivs = masterIntervals(master);
  const lock = j<any>(p.style_lock_json, {});
  const style = effectiveStyle(p.settings.styleId ?? "autoral:cartoon-narrativo", lock.hash, p.settings.styleVariantId);
  const keys: string[] = [];
  for (const iv of ivs) if (!keys.includes((iv as any).sceneKey)) keys.push((iv as any).sceneKey);
  const scenesOut: any[] = [];
  const res = commitIfCurrent(projectId, master.id, () => {
    keys.forEach((key, idx) => {
      const mine = ivs.filter((iv: any) => iv.sceneKey === key);
      const t0 = idx === 0 ? 0 : mine[0].t0;
      const nextKey = keys[idx + 1];
      const t1 = nextKey ? ivs.find((iv: any) => iv.sceneKey === nextKey)!.t0 : master.duration;
      const sc = doc?.scenes.find((s) => s.key === key);
      const narration = mine.map((m) => m.text).join(" ");
      const ex = db().prepare("SELECT * FROM scenes WHERE project_id=? AND stable_key=?").get(projectId, key) as any;
      const prev = ex ? j<any>(ex.data_json, null) : null;
      // mesma narração ⇒ preserva edições visuais e mídias; só os tempos acompanham o novo master
      const sameText = prev && prev.narration === narration;
      let shots: ShotPlan[];
      if (sameText && prev.shots?.length && prev.userEdited) {
        const k = (t1 - t0) / ((ex.t1 - ex.t0) || 1);
        shots = prev.shots.map((s: ShotPlan) => ({ ...s, t0: t0 + (s.t0 - ex.t0) * k, t1: t0 + (s.t1 - ex.t0) * k }));
      } else shots = planShots(narration, sc, t0, t1, mine.map((m) => m.t0), sc?.characters ?? [], idx === 0);
      if (idx === keys.length - 1) shots[shots.length - 1] = { ...shots[shots.length - 1], fadeOut: true } as any;
      const data = SceneData.parse({
        title: sc?.goal ?? key, narration, segmentIds: mine.map((m) => m.segmentId), characters: sc?.characters ?? [], setting: sc?.setting ?? "", actions: sc?.actions ?? [],
        visualIntent: sc?.visualIntent ?? "", styleId: style.id, styleHash: lock.hash ?? "", visualMode: p.settings.visualMode ?? "codigo", shots,
        media: sameText && prev?.media ? prev.media : [], ai: sameText && prev?.ai ? prev.ai : { use: false }, sound: sc?.soundMoments ?? [], subtitleIds: [],
      });
      const full = { ...data, userEdited: sameText ? !!prev?.userEdited : false };
      if (ex) db().prepare("UPDATE scenes SET idx=?, master_id=?, t0=?, t1=?, data_json=?, stale=0, stale_reason=NULL, state=CASE WHEN ? THEN state ELSE 'rascunho' END, approved=CASE WHEN ? THEN approved ELSE 0 END, version=version+1, updated_at=? WHERE id=?")
        .run(idx, master.id, t0, t1, JSON.stringify(full), sameText ? 1 : 0, sameText ? 1 : 0, now(), ex.id);
      else db().prepare("INSERT INTO scenes(id,project_id,stable_key,idx,master_id,t0,t1,data_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(uid("scn_"), projectId, key, idx, master.id, t0, t1, JSON.stringify(full), "rascunho", now(), now());
      scenesOut.push({ key, t0, t1, shots: shots.length, preserved: !!sameText });
    });
    // cenas que não existem mais no roteiro ficam marcadas (arquivos preservados)
    db().prepare(`UPDATE scenes SET stale=1, stale_reason='cena removida do roteiro' WHERE project_id=? AND stable_key NOT IN (${keys.map(() => "?").join(",")})`).run(projectId, ...keys);
    db().prepare("UPDATE projects SET status='storyboard', updated_at=? WHERE id=?").run(now(), projectId);
    return scenesOut;
  });
  if (!res.committed) throw new UserError(res.reason, 409);
  return { master: master.id, alignment: alignment.engine, scenes: scenesOut };
}

export function listScenes(projectId: string) {
  return (db().prepare("SELECT * FROM scenes WHERE project_id=? ORDER BY idx").all(projectId) as any[]).map((s) => ({ ...s, data: j<any>(s.data_json, {}) }));
}

/** Edição visual de uma cena: NÃO toca no áudio nem regenera a narração. */
export function editScene(projectId: string, key: string, patch: { shots?: ShotPlan[]; media?: any[]; ai?: any; approved?: boolean }) {
  const s = db().prepare("SELECT * FROM scenes WHERE project_id=? AND stable_key=?").get(projectId, key) as any;
  if (!s) throw new UserError("Cena não encontrada", 404);
  const data = { ...j<any>(s.data_json, {}), ...(patch.shots ? { shots: patch.shots.map((sh) => ({ ...sh, t0: Math.max(s.t0, sh.t0), t1: Math.min(s.t1, sh.t1) })) } : {}), ...(patch.media ? { media: patch.media } : {}), ...(patch.ai ? { ai: patch.ai } : {}), userEdited: true };
  if (patch.shots) {
    // os planos precisam cobrir exatamente o intervalo da cena no master
    const sh = data.shots as ShotPlan[];
    sh[0].t0 = s.t0; sh[sh.length - 1].t1 = s.t1;
  }
  db().prepare("UPDATE scenes SET data_json=?, approved=?, state=CASE WHEN ? THEN 'concluído' ELSE 'rascunho' END, render_hash=CASE WHEN ? THEN render_hash ELSE NULL END, version=version+1, updated_at=? WHERE id=?")
    .run(JSON.stringify(data), patch.approved ? 1 : 0, patch.approved ? 1 : 0, patch.approved && !patch.shots && !patch.media ? 1 : 0, now(), s.id);
  return { key, invalidated: patch.shots || patch.media ? ["render desta cena", "montagem final", "cues sonoros desta cena"] : [] };
}

/* ------------------------- cena → entrada do motor ------------------------- */
export function frameAt(t: number, fps: { num: number; den: number }) { return Math.round((t * fps.num) / fps.den); }

export function engineSceneFor(projectId: string, scene: any, master: Master, format: "16:9" | "9:16", subtitles: { t0: number; t1: number; text: string }[], burn = true): EngineScene {
  const p = getProject(projectId);
  const fps = p.settings.fps ?? { num: 24, den: 1 };
  const lock = j<any>(p.style_lock_json, {});
  const style = effectiveStyle(scene.data.styleId, lock.hash, p.settings.styleVariantId);
  const chars = Object.fromEntries((db().prepare("SELECT stable_key, data_json FROM characters WHERE project_id=?").all(projectId) as any[]).map((c) => [c.stable_key, j<any>(c.data_json, {})]));
  const f0 = frameAt(scene.t0, fps), f1 = frameAt(scene.t1, fps);
  const vertical = format === "9:16";
  const media = scene.data.media ?? [];
  const layerFor = (role: string) => media.filter((m: any) => m.assetId && m.role === role).map((m: any) => {
    const a = db().prepare("SELECT path FROM assets WHERE id=? AND approved=1").get(m.assetId) as any;
    return a && fs.existsSync(a.path) ? { src: "file://" + a.path, depth: role === "fundo" ? 0.3 : role === "personagem" ? 1 : 0.7, role, x: m.x } : null;
  }).filter(Boolean);
  const mode = scene.data.visualMode;
  const shots = scene.data.shots.map((sh: any) => ({
    ...sh,
    actors: sh.actors.map((a: any) => {
      const c = chars[a.id];
      const colors = (c?.colors ?? []).filter((x: string) => /^#[0-9a-f]{3,8}$/i.test(x));
      // 9:16: recompõe horizontalmente (aproxima personagens do centro) em vez de cortar o centro do 16:9
      const x = vertical ? 0.5 + (a.x - 0.5) * 0.55 : a.x;
      return { ...a, x, kind: a.id === "zumbi" || /zumbi/.test(c?.role ?? "") ? "zumbi" : "pessoa", colors, emotion: "" };
    }),
    layers: mode === "codigo" ? [] : [...layerFor("fundo"), ...(mode === "camadas" ? layerFor("personagem") : [])],
  }));
  return {
    w: vertical ? 1080 : 1920, h: vertical ? 1920 : 1080, fps, frameStart: f0, frameCount: f1 - f0,
    style: { family: style.renderFamily, palette: style.palette }, shots, subtitles, burnSubtitles: burn,
    safeArea: vertical ? { bottom: p.settings.safeBottom ?? 0.22 } : undefined,
  };
}

export function sceneRenderDir(projectId: string) {
  const d = path.join(projectDir(projectId), "cenas");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
