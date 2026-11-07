import { db, j } from "./db.js";
import { latestMaster, approvedMaster, staleReport } from "./pipeline/audio-gate.js";
import { latestAlignment } from "./pipeline/align.js";

/** Etapas do fluxo guiado com estado (concluída / atual / bloqueada) e a próxima ação em linguagem simples. */
export function projectSteps(projectId: string) {
  const p = db().prepare("SELECT * FROM projects WHERE id=?").get(projectId) as any;
  const s = j<any>(p.settings_json, {});
  const script = db().prepare("SELECT version FROM script_versions WHERE project_id=? ORDER BY version DESC LIMIT 1").get(projectId) as any;
  const segs = script ? (db().prepare("SELECT COUNT(*) n, SUM(chosen_take_id IS NOT NULL) t FROM speech_segments WHERE project_id=? AND script_version=?").get(projectId, script.version) as any) : { n: 0, t: 0 };
  const master = latestMaster(projectId);
  const approved = approvedMaster(projectId);
  const aligned = approved ? !!latestAlignment(approved) : false;
  const scenes = db().prepare("SELECT COUNT(*) n, SUM(stale) st, SUM(render_hash IS NOT NULL) r FROM scenes WHERE project_id=?").get(projectId) as any;
  const exp = db().prepare("SELECT id, status FROM exports WHERE project_id=? ORDER BY created_at DESC LIMIT 1").get(projectId) as any;
  const clips = exp ? (db().prepare("SELECT COUNT(*) n FROM review_clips WHERE export_id=?").get(exp.id) as any).n : 0;
  const masterIsCurrentForScript = master && script && master.script_version === script.version;
  const steps = [
    { key: "ideia", label: "Ideia e configurações", done: true },
    { key: "estilo", label: "Formato e estilo", done: !!s.styleId },
    { key: "roteiro", label: "Roteiro", done: !!script },
    { key: "voz", label: "Estúdio de voz", done: segs.n > 0 },
    { key: "narracao", label: "Narração completa", done: !!masterIsCurrentForScript && segs.n > 0 && segs.t === segs.n },
    { key: "aprovacao", label: "Aprovação do áudio", done: !!approved && approved.id === master?.id },
    { key: "alinhamento", label: "Transcrição e tempos", done: aligned },
    { key: "storyboard", label: "Storyboard sincronizado", done: scenes.n > 0 && !scenes.st },
    { key: "cenas", label: "Personagens, mídia e cenas", done: scenes.n > 0 && scenes.r === scenes.n },
    { key: "som", label: "Som e revisão", done: clips === 5 },
    { key: "exportacao", label: "Exportação", done: exp?.status === "concluído" },
  ];
  const audioGate = steps.findIndex((x) => x.key === "aprovacao");
  let current = steps.findIndex((x) => !x.done);
  if (current < 0) current = steps.length;
  const out = steps.map((st, i) => ({ ...st, state: st.done ? "concluída" : i === current ? "atual" : i > audioGate && !steps[audioGate].done ? "bloqueada" : "pendente" }));
  const next: Record<string, string> = {
    estilo: "Escolher estilo visual", roteiro: "Gerar roteiro", voz: "Preparar trechos de fala", narracao: "Gerar narração completa",
    aprovacao: "Gerar e aprovar narração", alinhamento: "Alinhar narração aprovada", storyboard: "Gerar storyboard", cenas: "Renderizar cena piloto",
    som: "Montar vídeo e trechos de revisão", exportacao: "Exportar",
  };
  return { steps: out, nextAction: steps[current] ? next[steps[current].key] : "Concluído", visualUnlocked: !!approved && approved.id === master?.id, stale: staleReport(projectId) };
}
