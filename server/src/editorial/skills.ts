import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db, j, now, uid } from "../db.js";
import { VENDOR_DIR } from "../paths.js";
import { getSecret } from "../secrets.js";
import { structured } from "../providers/anthropic.js";
import { channelProfile, latestScript } from "../pipeline/script.js";
import { approvedMaster } from "../pipeline/audio-gate.js";
import { latestAlignment } from "../pipeline/align.js";
import { suggestShorts } from "../pipeline/shorts.js";
import { currentCues } from "../sound/cues.js";
import { getStyleVersion } from "../catalog/catalog.js";
import { chapters, deadAir, hookScore, parseRetentionCsv, parseSrt, rankHooks, retention, swipe, titleLint, type Cue } from "./yt-tools.js";
import { UserError } from "../util.js";

/**
 * As ONZE skills da youtube-agent-skill mapeadas para ações do painel. Ferramentas locais portadas
 * rodam sempre; partes de redação usam o Claude via API (modelo configurado) com o SKILL.md como
 * método. Sem chave, a parte de redação fica "pendente" com o caminho do Claude Code indicado.
 * Nada é publicado, enviado ou fixado: tudo vira relatório revisável.
 */
export const SKILLS = {
  "yt-script": { acao: "Elaborar roteiro e comparar ganchos", entrada: "roteiro do projeto", local: "hookscore (portado)" },
  "yt-package": { acao: "Revisar conjunto título e thumbnail", entrada: "título(s) e texto da thumbnail", local: "title.py (portado)" },
  "yt-edit": { acao: "Preparar decisões de edição", entrada: "alinhamento do master aprovado", local: "deadair.py (portado; respeita pausas dramáticas)" },
  "yt-comment": { acao: "Analisar comentários e rascunhar respostas", entrada: "comentários colados/importados", local: "agrupamento de perguntas" },
  "yt-plan": { acao: "Montar calendário editorial", entrada: "perfil do canal + projetos", local: "esqueleto de calendário" },
  "yt-viral": { acao: "Investigar ideias de outros canais", entrada: "JSON importado [{channel,title,views,url}]", local: "swipe.py (portado)" },
  "yt-retention": { acao: "Examinar dados de retenção", entrada: "CSV do YouTube Studio + duração", local: "retention.py (portado)" },
  "yt-shorts": { acao: "Propor versões curtas", entrada: "master aprovado", local: "seleção por fronteiras reais + hookscore" },
  "yt-seo": { acao: "Preparar descrição e palavras-chave", entrada: "roteiro + créditos + capítulos", local: "montagem ≤ 5.000 caracteres com créditos" },
  "yt-chapters": { acao: "Produzir capítulos", entrada: "legendas da versão final", local: "chapters.py (portado)" },
  "yt-audit": { acao: "Diagnosticar o canal", entrada: "CSV/JSON de vídeos do canal", local: "medianas e outliers" },
} as const;
export type SkillId = keyof typeof SKILLS;

export function discoverSkillCatalog() {
  const dir = path.join(VENDOR_DIR, "youtube-agent-skill", "skills");
  const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "SKILL.md"))) : [];
  return { required: Object.keys(SKILLS), found, missing: Object.keys(SKILLS).filter((s) => !found.includes(s)), extra: found.filter((s) => !(s in SKILLS)) };
}
function skillMd(id: string) { try { return fs.readFileSync(path.join(VENDOR_DIR, "youtube-agent-skill", "skills", id, "SKILL.md"), "utf8"); } catch { return ""; } }

async function claude<S extends z.ZodType>(id: string, task: string, schema: S, projectId: string | null, jobId?: string) {
  if (!getSecret("anthropic")) return { pending: "Redação pendente: configure a chave Anthropic ou use “Preparar projeto para Claude Code”." } as const;
  const ch = channelProfile();
  const r = await structured({ system: `Você executa a skill ${id} da youtube-agent-skill para um canal brasileiro de histórias hipotéticas animadas. Responda em português do Brasil. Nunca invente métricas, visualizações, CTR ou dados ausentes; diferencie correlação, hipótese editorial e evidência.\n\n--- SKILL.md ---\n${skillMd(id).slice(0, 7000)}\n\n--- Perfil do canal v${ch.version} ---\n${JSON.stringify({ ...ch.data, editorialVoice: undefined })}\nVoz editorial (maneira de escrever, não timbre):\n${ch.data.editorialVoice.slice(0, 2000)}`, user: task, schema, projectId: projectId ?? undefined, jobId });
  return { data: r.data, model: r.model } as const;
}

/* ------------------------------- descrição ------------------------------- */
export const YT_DESC_LIMIT = 5000;
export function creditsBlock(projectId: string) {
  const lines: string[] = [];
  const p = db().prepare("SELECT settings_json, style_lock_json FROM projects WHERE id=?").get(projectId) as any;
  const s = j<any>(p?.settings_json, {}), lock = j<any>(p?.style_lock_json, {});
  const style = s.styleId ? getStyleVersion(s.styleId, lock.hash) : null;
  if (style && style.source !== "autoral") lines.push(`Estilo visual inspirado em: ${style.license.attribution}${style.source === "lemo-opuscar" ? " (CC BY 4.0) — adaptado" : ""}`);
  const used = new Map<string, string>();
  for (const c of currentCues(projectId)) if (c.file) used.set(c.file, `${path.basename(c.file)}: ${c.license} — ${c.source}`);
  const kit = path.join(path.dirname(VENDOR_DIR), "sons", "openverse_manifest.json");
  if (fs.existsSync(kit)) for (const it of j<any>(fs.readFileSync(kit, "utf8"), { items: [] }).items) for (const f of used.keys()) if (f.endsWith(it.local)) used.set(f, `"${it.openverse.title}" por ${it.openverse.creator} — ${it.openverse.foreign_landing_url} — ${it.openverse.license === "cc0" ? "CC0" : "CC BY"} ${it.openverse.license_version}`);
  if (used.size) lines.push("Efeitos sonoros:", ...[...used.values()].map((v) => `• ${v}`));
  lines.push("Narração: voz sintética gerada localmente (Kokoro-82M, Apache-2.0).");
  return lines.join("\n");
}
export function buildDescription(o: { summary: string; chapters?: string; hashtags?: string[]; credits: string; extra?: string }) {
  const tail = [o.chapters ? `Capítulos:\n${o.chapters}` : "", o.hashtags?.length ? o.hashtags.map((h) => (h.startsWith("#") ? h : "#" + h.replace(/\s+/g, ""))).join(" ") : "", `Créditos:\n${o.credits}`].filter(Boolean).join("\n\n");
  const len = (s: string) => [...s].length;
  if (len(tail) > YT_DESC_LIMIT - 200) throw new UserError(`Os créditos e capítulos obrigatórios já ocupam ${len(tail)} caracteres; reduza capítulos ou hashtags.`, 422);
  let head = [o.summary, o.extra].filter(Boolean).join("\n\n");
  const room = YT_DESC_LIMIT - 150 - len(tail) - 2; // margem abaixo do limite
  if (len(head) > room) head = [...head].slice(0, room - 1).join("").replace(/\s+\S*$/, "") + "…";
  const text = `${head}\n\n${tail}`;
  return { text, chars: len(text), limit: YT_DESC_LIMIT, margin: YT_DESC_LIMIT - len(text), truncatedSummary: len([o.summary, o.extra].filter(Boolean).join("\n\n")) > room };
}

function finalCues(projectId: string): Cue[] {
  const m = approvedMaster(projectId);
  if (!m) throw new UserError("Requer o master aprovado e alinhado.", 409, "Gerar e aprovar narração");
  const a = latestAlignment(m);
  if (!a) throw new UserError("Alinhe a narração aprovada primeiro.", 409);
  return a.cues;
}

/* ------------------------------- execução ------------------------------- */
export async function runEditorialSkill(projectId: string | null, skill: SkillId, input: any, jobId?: string) {
  if (!(skill in SKILLS)) throw new UserError("Skill desconhecida", 400);
  let data: any;
  const pid = projectId ?? null;
  switch (skill) {
    case "yt-script": {
      const sc = pid ? latestScript(pid) : null;
      const hooks = input.hooks ?? sc?.data.hookOptions.map((h: any) => h.text) ?? [];
      data = { ranking: rankHooks(hooks), recommended: rankHooks(hooks)[0] ?? null, scriptVersion: sc?.version ?? null };
      break;
    }
    case "yt-package": {
      const titles: string[] = input.titles ?? [];
      const lint = titles.map((t) => titleLint(t, input.thumbText));
      const gen = pid && input.generate ? await claude("yt-package", `Proponha 5 pares título + texto curto de thumbnail (≤3 palavras) para o vídeo: ${latestScript(pid)?.data.logline}. A promessa deve ser coerente com a história. Título em PT-BR.`, z.object({ pairs: z.array(z.object({ title: z.string(), thumbText: z.string(), thumbVisual: z.string(), rationale: z.string() })) }), pid, jobId) : null;
      data = { lint: lint.sort((a, b) => b.score - a.score), generated: gen, note: "Imagens de thumbnail são geradas via OpenAI somente depois da aprovação do áudio." };
      break;
    }
    case "yt-edit": {
      const m = pid ? approvedMaster(pid) : null;
      const cues = finalCues(pid!);
      const ivs = j<any[]>(m!.intervals_json, []);
      const pauses = ivs.filter((iv) => iv.pauseAfterMs >= 350).map((iv) => ({ t0: iv.t1, t1: iv.t1 + iv.pauseAfterMs / 1000 }));
      data = deadAir(cues, input.floor ?? 0.35, pauses);
      break;
    }
    case "yt-comment": {
      const comments: string[] = (input.text ?? "").split(/\n+/).map((s: string) => s.trim()).filter(Boolean);
      const questions = comments.filter((c) => c.includes("?"));
      const gen = comments.length ? await claude("yt-comment", `Comentários (um por linha):\n${comments.slice(0, 300).join("\n")}\n\nAgrupe temas, liste perguntas e rascunhe respostas curtas. NÃO publique nada.`, z.object({ themes: z.array(z.object({ theme: z.string(), count: z.number(), examples: z.array(z.string()) })), questions: z.array(z.string()), drafts: z.array(z.object({ comment: z.string(), reply: z.string() })), ideas: z.array(z.string()) }), pid, jobId) : null;
      data = { total: comments.length, questions, analysis: gen, note: "Rascunhos apenas: nenhuma resposta é enviada ou fixada." };
      break;
    }
    case "yt-plan": {
      const projects = db().prepare("SELECT id,title,kind,status FROM projects WHERE is_test=0 ORDER BY created_at DESC LIMIT 30").all();
      const gen = await claude("yt-plan", `Monte um calendário editorial de ${input.weeks ?? 4} semanas a partir de ${input.start ?? "hoje"}, com ${input.perWeek ?? 1} longo(s) e curtos derivados por semana. Projetos existentes: ${JSON.stringify(projects)}. Disponibilidade: ${channelProfile().data.productionAvailability}.`, z.object({ items: z.array(z.object({ date: z.string(), format: z.string(), premise: z.string(), projectId: z.string().nullable(), notes: z.string() })) }), pid, jobId);
      data = { calendar: gen, note: "Planejamento editável; não publica nada." };
      break;
    }
    case "yt-viral": {
      if (!Array.isArray(input.videos)) throw new UserError("Importe uma lista JSON de vídeos com channel, title, views (fonte e data obrigatórias).", 400);
      data = { source: input.source ?? "não informada", collectedAt: input.collectedAt ?? null, ...swipe(input.videos, input.min ?? 2) };
      break;
    }
    case "yt-retention": {
      const rows = parseRetentionCsv(input.csv ?? "");
      let cues: Cue[] | undefined;
      try { cues = pid ? finalCues(pid) : undefined; } catch { cues = undefined; }
      data = { ...retention(rows, input.durationSec, cues), linkedTo: cues ? "legendas da versão publicada (master aprovado)" : "sem transcrição vinculada" };
      break;
    }
    case "yt-shorts": data = suggestShorts(pid!, input.count ?? 3, input.minS ?? 45, input.maxS ?? 60); break;
    case "yt-chapters": {
      const ch = chapters(finalCues(pid!), input.target ?? 7);
      data = { ...ch, text: ch.chapters.map((c) => `${c.label} ${c.draftTitle}`).join("\n") };
      break;
    }
    case "yt-seo": {
      const sc = latestScript(pid!);
      let chText = "";
      try { const ch = chapters(finalCues(pid!), 7); if (ch.valid) chText = ch.chapters.map((c) => `${c.label} ${input.chapterTitles?.[c.start] ?? c.draftTitle}`).join("\n"); } catch {}
      const gen = await claude("yt-seo", `Escreva o resumo de descrição (máx. 900 caracteres, sem spoiler do final), 8 hashtags e 15 palavras-chave para: ${sc?.data.title} — ${sc?.data.logline}.`, z.object({ summary: z.string(), hashtags: z.array(z.string()), keywords: z.array(z.string()) }), pid, jobId);
      const g: any = "data" in gen ? gen.data : null;
      const desc = buildDescription({ summary: input.summary ?? g?.summary ?? sc?.data.logline ?? "", chapters: chText, hashtags: input.hashtags ?? g?.hashtags ?? [], credits: creditsBlock(pid!) });
      data = { description: desc, keywords: (input.keywords ?? g?.keywords ?? []).join(", "), generated: gen, chaptersNote: chText ? "Capítulos gerados dos tempos reais do master aprovado (= vídeo final)." : "Capítulos indisponíveis (inválidos ou sem alinhamento)." };
      break;
    }
    case "yt-audit": {
      if (!Array.isArray(input.videos)) throw new UserError("Importe os dados reais do canal (CSV/JSON exportado do YouTube Studio).", 400);
      const views = input.videos.map((v: any) => Number(v.views)).filter((n: number) => Number.isFinite(n)).sort((a: number, b: number) => a - b);
      const median = views.length ? views[Math.floor(views.length / 2)] : null;
      data = { source: input.source ?? "não informada", videos: views.length, medianViews: median, outliers: input.videos.filter((v: any) => median && v.views >= median * 2).map((v: any) => v.title), titleLint: input.videos.slice(0, 20).map((v: any) => titleLint(v.title)), note: "Métricas calculadas só a partir dos dados importados." };
      break;
    }
  }
  const id = uid("rep_");
  const version = pid ? (approvedMaster(pid)?.version ?? null) : null;
  db().prepare("INSERT INTO editorial_reports(id,project_id,skill,project_version,input_json,data_json,created_at) VALUES(?,?,?,?,?,?,?)").run(id, pid, skill, version != null ? `master v${version}` : null, JSON.stringify(input).slice(0, 20000), JSON.stringify(data), now());
  return { reportId: id, skill, action: SKILLS[skill].acao, data, analyzedAt: now() };
}

export { hookScore };
