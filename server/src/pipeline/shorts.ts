import { db, j, now, uid } from "../db.js";
import { ScriptDoc, ProjectSettings } from "../contracts.js";
import { requireApprovedAudio, masterIntervals } from "./audio-gate.js";
import { getProject, setVoiceCast, voiceCast } from "./narration.js";
import { hookScore } from "../editorial/yt-tools.js";
import { assembleLong, type Ctx } from "../render/assemble.js";
import { UserError } from "../util.js";

/**
 * Curtos derivados. Cada curto é um PROJETO PRÓPRIO (kind=short, 9:16) com seu master de áudio e
 * sua aprovação. Trechos reaproveitados usam os takes já aprovados do episódio; um gancho novo é
 * um trecho novo que precisa ser sintetizado e aprovado antes de qualquer cena vertical.
 */
export function suggestShorts(parentId: string, count = 3, minS = 45, maxS = 60) {
  const m = requireApprovedAudio(parentId);
  const ivs = masterIntervals(m) as any[];
  const keys: string[] = [];
  for (const iv of ivs) if (!keys.includes(iv.sceneKey)) keys.push(iv.sceneKey);
  const cands: any[] = [];
  for (let a = 0; a < ivs.length; a++) {
    if (a > 0 && ivs[a].sceneKey === ivs[a - 1].sceneKey && ivs[a - 1].pauseAfterMs < 500) continue; // começa em fronteira natural
    let b = a;
    while (b + 1 < ivs.length && ivs[b + 1].t1 - ivs[a].t0 <= maxS) b++;
    const dur = ivs[b].t1 - ivs[a].t0;
    if (dur < minS) continue;
    const text = ivs.slice(a, b + 1).map((x) => x.text).join(" ");
    const hook = hookScore(ivs[a].text);
    const intensity = (text.match(/corr|grit|zumbi|sangue|porta|escuro|revela|de repente|silêncio|mordid|fug/gi) ?? []).length;
    const endsResolved = /\.$/.test(ivs[b].text) && b === ivs.length - 1;
    cands.push({ t0: ivs[a].t0, t1: ivs[b].t1 + Math.min(0.6, (ivs[b].pauseAfterMs ?? 0) / 1000), duration: dur, firstLine: ivs[a].text, hook, intensity, score: hook.verdict + intensity * 6, kind: endsResolved ? "história completa" : "trecho com gancho", segmentIds: ivs.slice(a, b + 1).map((x) => x.segmentId) });
  }
  cands.sort((x, y) => y.score - x.score);
  const picked: any[] = [];
  for (const c of cands) { if (picked.length >= count) break; if (picked.every((p) => c.t1 <= p.t0 || c.t0 >= p.t1)) picked.push(c); }
  return { suggestions: picked.sort((a, b) => a.t0 - b.t0), note: "Sugestões heurísticas (gancho + intensidade). O usuário escolhe quantidade, duração e trechos; a skill yt-shorts pode refinar via Claude." };
}

export function createDerivedShort(parentId: string, o: { segmentIds: string[]; newHook?: string; kind: "história completa" | "teaser" | "trecho com gancho"; destination?: string; title?: string }) {
  const parent = getProject(parentId);
  const m = requireApprovedAudio(parentId);
  if (o.kind === "teaser" && !o.destination) throw new UserError("Teaser precisa indicar o destino editorial (ex.: episódio completo no canal).", 400);
  const segs = o.segmentIds.map((id) => db().prepare("SELECT * FROM speech_segments WHERE id=? AND project_id=?").get(id, parentId) as any).filter(Boolean).sort((a, b) => a.idx - b.idx);
  if (!segs.length) throw new UserError("Selecione trechos do episódio", 400);
  const doc = j<ScriptDoc>((db().prepare("SELECT data_json FROM script_versions WHERE project_id=? AND version=?").get(parentId, m.script_version) as any).data_json, null as any);
  const id = uid("").slice(0, 16).replace(/^/, "c");
  const settings = ProjectSettings.parse({ ...parent.settings, format: "9:16", targetSeconds: Math.min(90, Math.max(15, Math.round(segs.reduce((s, x) => s + x.text.split(/\s+/).length, 0) / 2.5) + (o.newHook ? 4 : 0))), toleranceSeconds: 15, shortsCount: 0 });
  const sceneKeys = [...new Set(segs.map((s) => s.scene_key))];
  const shortDoc: ScriptDoc = {
    ...doc, title: o.title ?? `${parent.title} — curto`, hook: o.newHook ?? segs[0].text,
    scenes: [
      ...(o.newHook ? [{ key: "h00", act: 1, goal: "gancho do curto", setting: doc.scenes.find((s) => s.key === sceneKeys[0])?.setting ?? "", characters: doc.scenes.find((s) => s.key === sceneKeys[0])?.characters ?? [], actions: ["reação imediata"], emotion: "suspense", lines: [{ speaker: "narrador", text: o.newHook, emotion: "suspense", pauseAfterMs: 250 }], visualIntent: doc.scenes.find((s) => s.key === sceneKeys[0])?.visualIntent ?? "", camera: "push-in", mediaNeeds: [], soundMoments: [], estimatedSeconds: 4 }] : []),
      ...sceneKeys.map((k) => ({ ...doc.scenes.find((s) => s.key === k)!, lines: segs.filter((s) => s.scene_key === k).map((s) => ({ speaker: s.speaker, text: s.text, emotion: j<any>(s.direction_json, {}).emotion ?? "", pauseAfterMs: s.pause_after_ms })) })),
    ],
  };
  db().transaction(() => {
    db().prepare("INSERT INTO projects(id,title,kind,parent_id,settings_json,style_lock_json,bible_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, shortDoc.title, "short", parentId, JSON.stringify(settings), parent.style_lock_json, JSON.stringify({ ...parent.bible, shortKind: o.kind, destination: o.destination ?? null, sourceMaster: { id: m.id, sha256: m.sha256 } }), "rascunho", now(), now());
    db().prepare("INSERT INTO script_versions(id,project_id,version,origin,model,data_json,text,created_at) VALUES(?,?,1,'manual','derivado do episódio',?,?,?)").run(uid("scr_"), id, JSON.stringify(shortDoc), shortDoc.scenes.map((s) => s.lines.map((l) => l.text).join(" ")).join("\n"), now());
    let idx = 0;
    for (const sc of shortDoc.scenes) for (const l of sc.lines) {
      const src = segs.find((s) => s.text === l.text && s.scene_key === sc.key);
      const sid = uid("seg_");
      let takeId: string | null = null;
      if (src?.chosen_take_id) {
        const t = db().prepare("SELECT * FROM voice_tracks WHERE id=?").get(src.chosen_take_id) as any;
        takeId = uid("take_");
        db().prepare("INSERT INTO speech_segments(id,project_id,script_version,idx,scene_key,speaker,text,direction_json,pause_after_ms,status) VALUES(?,?,?,?,?,?,?,?,?,?)").run(sid, id, 1, idx++, sc.key, l.speaker, l.text, JSON.stringify({ emotion: l.emotion, reusedFrom: src.id }), l.pauseAfterMs, "gerado");
        db().prepare("INSERT INTO voice_tracks(id,segment_id,path,sha256,duration,engine,request_json,created_at) VALUES(?,?,?,?,?,?,?,?)").run(takeId, sid, t.path, t.sha256, t.duration, t.engine, JSON.stringify({ ...j<any>(t.request_json, {}), reusedFromApprovedMaster: m.id }), now());
        db().prepare("UPDATE speech_segments SET chosen_take_id=? WHERE id=?").run(takeId, sid);
      } else {
        db().prepare("INSERT INTO speech_segments(id,project_id,script_version,idx,scene_key,speaker,text,direction_json,pause_after_ms,status) VALUES(?,?,?,?,?,?,?,?,?,?)").run(sid, id, 1, idx++, sc.key, l.speaker, l.text, JSON.stringify({ emotion: l.emotion, newForShort: true }), l.pauseAfterMs, "pendente");
      }
    }
  })();
  setVoiceCast(id, voiceCast(parentId));
  return { shortId: id, needsNewSpeech: !!o.newHook, next: o.newHook ? "Gerar a fala do novo gancho, montar e aprovar o master do curto" : "Montar e aprovar o master do curto" };
}

export async function assembleShort(projectId: string, ctx: Ctx, payload: { music?: string | null }) {
  const p = getProject(projectId);
  if (p.kind !== "short") throw new UserError("Projeto não é um curto", 400);
  return assembleLong(projectId, ctx, { format: "9:16", music: payload.music ?? null });
}
