import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db, j, now, uid } from "../db.js";
import { projectDir, VENDOR_DIR, ROOT } from "../paths.js";
import { ScriptDoc, ChannelProfile } from "../contracts.js";
import { structured } from "../providers/anthropic.js";
import { getConfig } from "../providers/config.js";
import { effectiveStyle } from "../catalog/catalog.js";
import { hookFormulas, rankHooks } from "../editorial/yt-tools.js";
import { getProject } from "./narration.js";
import { UserError } from "../util.js";

/* ----------------------------- Direção do canal ----------------------------- */
export function channelProfile(): { version: number; data: ChannelProfile } {
  const r = db().prepare("SELECT * FROM channel_profiles ORDER BY version DESC LIMIT 1").get() as any;
  if (r) return { version: r.version, data: ChannelProfile.parse(j(r.data_json, {})) };
  let voice = "";
  try { voice = fs.readFileSync(path.join(VENDOR_DIR, "youtube-agent-skill", "templates", "voice.md"), "utf8"); } catch {}
  const data = ChannelProfile.parse({
    proposal: "Histórias hipotéticas narradas em segunda pessoa: 'E se...?' com consequências concretas.",
    audience: "Jovens e adultos que gostam de suspense, sobrevivência e ficção científica.",
    tone: "Íntimo, tenso, com humor seco ocasional.", themes: ["sobrevivência", "mistério", "dilemas morais"],
    rules: ["Sem saudação antes do gancho", "Sem números ou fatos reais inventados", "Cada decisão tem consequência visível"],
    qualityCriteria: ["Gancho concreto nos primeiros 3–8 s", "Novo motivo de interesse a cada 20–40 s", "Regras do mundo coerentes"],
    editorialVoice: voice,
  });
  db().prepare("INSERT INTO channel_profiles(version,data_json,created_at) VALUES(1,?,?)").run(JSON.stringify(data), now());
  return { version: 1, data };
}
/** Nova versão da direção do canal. NÃO reescreve projetos existentes — só orienta novas gerações. */
export function saveChannelProfile(patch: Partial<ChannelProfile>) {
  const cur = channelProfile();
  const data = ChannelProfile.parse({ ...cur.data, ...patch });
  const version = cur.version + 1;
  db().prepare("INSERT INTO channel_profiles(version,data_json,created_at) VALUES(?,?,?)").run(version, JSON.stringify(data), now());
  return { version, data };
}

/* --------------------------------- Brief --------------------------------- */
export function wordTarget(seconds: number, wpm: number) {
  // ~8% do tempo vai para pausas dramáticas e respirações
  return Math.round((seconds * 0.92 * wpm) / 60);
}

export function buildScriptBrief(projectId: string, opts: { revisionNote?: string } = {}) {
  const p = getProject(projectId);
  const s = p.settings;
  const lock = j<any>(p.style_lock_json, {});
  const style = s.styleId ? effectiveStyle(s.styleId, lock.hash, s.styleVariantId) : null;
  const ch = channelProfile();
  const words = wordTarget(s.targetSeconds, s.voice?.wpm ?? 150);
  let ytScript = "";
  try { ytScript = fs.readFileSync(path.join(VENDOR_DIR, "youtube-agent-skill", "skills", "yt-script", "SKILL.md"), "utf8"); } catch {}
  const formulas = hookFormulas().map((f) => `- ${f.name}: ${f.shape} (falha quando: ${f.fails_when})`).join("\n");
  let previous = "";
  if (s.mode === "serie" && s.seriesId) {
    const eps = db().prepare("SELECT e.number, e.recap, e.audience_choice, e.audience_choice_source FROM episodes e WHERE series_id=? ORDER BY season, number").all(s.seriesId) as any[];
    previous = eps.map((e) => `Ep. ${e.number}: ${e.recap ?? "(sem resumo)"}${e.audience_choice ? ` | escolha do público (${e.audience_choice_source}): ${e.audience_choice}` : ""}`).join("\n");
  }
  const chars = db().prepare("SELECT stable_key, data_json FROM characters WHERE project_id=? OR (series_id IS NOT NULL AND series_id=?)").all(projectId, s.seriesId ?? "-") as any[];
  const system = [
    "Você é o roteirista-chefe de um canal de histórias hipotéticas animadas narradas. Escreva em português do Brasil natural e narrável (salvo outro idioma indicado).",
    "Regras narrativas obrigatórias:",
    "1. Nos primeiros 3–8 segundos, uma situação concreta que desperte curiosidade ou perigo. Sem saudação, sem vinheta antes do gancho.",
    "2. Protagonista com objetivo compreensível e algo relevante a perder.",
    "3. Regras do universo estabelecidas e coerentes; decisões com consequências, preparação e recompensa narrativa.",
    "4. Alternar descoberta, dificuldade, tentativa e consequência. Reviravoltas justificadas, nunca aleatórias.",
    "5. Novo motivo de interesse a cada 20–40 segundos, adaptando o ritmo à cena.",
    "6. Falas naturais, frases narráveis, descrições visuais realizáveis por animação 2D/camadas (sem exigir multidões complexas em close).",
    "7. Encerrar resolvendo o conflito principal (ou dilema intencional no modo série). Cliffhanger não substitui desenvolvimento.",
    "8. CTA curta, ligada à história, no final.",
    "9. Nunca invente números, fatos reais ou fontes. Personagens e cenários próprios, sem copiar obras ou canais de referência.",
    "Use o método da skill yt-script (abaixo) para produzir CINCO ganchos com fórmulas diferentes.",
    "Faça uma autorrevisão honesta: repetições, contradições, exposição excessiva e promessas não cumpridas.",
    "\n--- Método yt-script (youtube-agent-skill, MIT) ---\n" + ytScript.slice(0, 6000),
    "\n--- 21 fórmulas de gancho (hooks.json) ---\n" + formulas,
  ].join("\n");
  const user = [
    `PREMISSA: ${s.premise}`,
    `Gênero: ${s.genre} | Público: ${s.audience} | Idioma: ${s.language} | Perspectiva: ${s.perspective}`,
    `Formato: ${p.kind === "short" ? "curto vertical 9:16" : "longo 16:9"} | Duração de narração-alvo: ${s.targetSeconds} s (tolerância ±${s.toleranceSeconds} s)`,
    `Meta de palavras faladas: cerca de ${words} palavras (voz a ~${s.voice?.wpm ?? 150} palavras/min; o áudio real será medido e o roteiro ajustado).`,
    `Suspense: ${s.suspense}/10 | Violência: ${s.violence}/10 (mostre perigo por sugestão; nada gráfico acima do nível pedido)`,
    `Música desejada: ${s.music}`,
    style ? `ESTILO VISUAL: ${style.nameOriginal} (${style.namePt}). Família de render: ${style.renderFamily}. Essência (resumo do STYLE.md):\n${(style.stylePrompt ?? "").slice(0, 2500)}` : "Estilo visual ainda não escolhido.",
    "Cada cena deve ter: key estável (s01, s02...), ato, objetivo, cenário (id da lista de settings), personagens (ids), ações visíveis, emoção, falas (narrador e personagens com emoção e pausa após), intenção visual, câmera, necessidades de mídia, momentos sonoros e duração estimada.",
    `DIREÇÃO DO CANAL (v${ch.version}): ${JSON.stringify({ ...ch.data, editorialVoice: undefined })}`,
    ch.data.editorialVoice ? `VOZ EDITORIAL (maneira de escrever, não timbre):\n${ch.data.editorialVoice.slice(0, 2500)}` : "",
    s.freeText ? `Observações do usuário: ${s.freeText}` : "",
    s.referenceLinks?.length ? `Links de referência fornecidos (estude só recursos narrativos; não copie): ${s.referenceLinks.join(", ")}` : "",
    previous ? `CONTINUIDADE DA SÉRIE:\n${previous}` : "",
    chars.length ? `PERSONAGENS JÁ EXISTENTES (mantenha ids e aparência): ${chars.map((c) => `${c.stable_key}: ${c.data_json}`).join("\n")}` : "",
    opts.revisionNote ? `PEDIDO DE REVISÃO: ${opts.revisionNote}` : "",
  ].filter(Boolean).join("\n\n");
  return { system, user, wordTarget: words, channelVersion: ch.version };
}

/* -------------------------- Salvar versão de roteiro -------------------------- */
export function scriptText(doc: ScriptDoc) {
  return doc.scenes.map((sc) => `## ${sc.key} — ${sc.goal}\n` + sc.lines.map((l) => `${l.speaker.toUpperCase()} (${l.emotion}): ${l.text}`).join("\n")).join("\n\n");
}

export function reviewScript(doc: ScriptDoc, targetWords: number, wpm: number) {
  const spoken = doc.scenes.flatMap((s) => s.lines.map((l) => l.text)).join(" ");
  const nWords = spoken.split(/\s+/).filter(Boolean).length;
  const first = doc.scenes[0]?.lines[0]?.text ?? "";
  const firstSec = (first.split(/\s+/).length / wpm) * 60;
  const greeting = /^(olá|oi|e aí|fala,? galera|bem-vindos?|hey|hello|welcome)/i.test(first.trim());
  const freq = new Map<string, number>();
  for (const w of spoken.toLowerCase().match(/[a-zà-ú]{6,}/g) ?? []) freq.set(w, (freq.get(w) ?? 0) + 1);
  const repeated = [...freq.entries()].filter(([, n]) => n >= 6).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const lastScene = doc.scenes[doc.scenes.length - 1];
  const issues: string[] = [];
  if (greeting) issues.push("A primeira fala é uma saudação — o gancho deve vir antes.");
  if (firstSec > 8.5) issues.push(`A primeira fala dura ~${firstSec.toFixed(1)} s; o gancho deve caber em 3–8 s.`);
  if (Math.abs(nWords - targetWords) / targetWords > 0.15) issues.push(`Palavras faladas: ${nWords} (meta ~${targetWords}).`);
  const cumulative: number[] = []; let acc = 0;
  for (const sc of doc.scenes) { acc += sc.estimatedSeconds; cumulative.push(acc); }
  return { words: nWords, targetWords, estimatedSeconds: (nWords / wpm) * 60, hookSeconds: firstSec, repeatedWords: repeated, issues, ctaAtEnd: /inscrev|coment|próximo|e você/i.test(lastScene?.lines.map((l) => l.text).join(" ") ?? "") || !!doc.cta, modelSelfReview: doc.selfReview };
}

export function saveScriptVersion(projectId: string, raw: unknown, origin: "api" | "claude-code" | "manual", model: string | null) {
  const parsed = ScriptDoc.safeParse(raw);
  if (!parsed.success) throw new UserError("Roteiro inválido: " + parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 422);
  const doc = parsed.data;
  const p = getProject(projectId);
  const last = db().prepare("SELECT MAX(version) v FROM script_versions WHERE project_id=?").get(projectId) as any;
  const version = (last?.v ?? 0) + 1;
  const hooks = rankHooks(doc.hookOptions.map((h) => h.text));
  const wpm = p.settings.voice?.wpm ?? 150;
  const report = reviewScript(doc, wordTarget(p.settings.targetSeconds, wpm), wpm);
  const ch = channelProfile();
  db().transaction(() => {
    db().prepare("INSERT INTO script_versions(id,project_id,version,origin,model,data_json,text,hooks_json,report_json,channel_direction_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(uid("scr_"), projectId, version, origin, model, JSON.stringify(doc), scriptText(doc), JSON.stringify(hooks), JSON.stringify(report), ch.version, now());
    for (const c of doc.characters) {
      const ex = db().prepare("SELECT id FROM characters WHERE project_id=? AND stable_key=?").get(projectId, c.id) as any;
      if (ex) db().prepare("UPDATE characters SET data_json=?, updated_at=? WHERE id=?").run(JSON.stringify(c), now(), ex.id);
      else db().prepare("INSERT INTO characters(id,project_id,series_id,stable_key,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(uid("chr_"), projectId, p.settings.seriesId ?? null, c.id, JSON.stringify(c), now(), now());
    }
    db().prepare("UPDATE projects SET bible_json=?, title=?, status='roteiro em revisão', updated_at=? WHERE id=?")
      .run(JSON.stringify({ ...p.bible, worldRules: doc.worldRules, settings: doc.settings }), doc.title, now(), projectId);
  })();
  return { version, hooks, report };
}

export function latestScript(projectId: string) {
  const r = db().prepare("SELECT * FROM script_versions WHERE project_id=? ORDER BY version DESC LIMIT 1").get(projectId) as any;
  return r ? { ...r, data: j<ScriptDoc>(r.data_json, null as any), hooks: j(r.hooks_json, []), report: j(r.report_json, {}) } : null;
}

/** Caminho A: geração automática pela API Anthropic (modelo configurado, padrão claude-opus-5-5). */
export async function generateScriptViaApi(projectId: string, jobId?: string, revisionNote?: string) {
  const brief = buildScriptBrief(projectId, { revisionNote });
  const r = await structured({ system: brief.system, user: brief.user, schema: ScriptDoc, projectId, jobId, maxTokens: 32000 });
  return { ...saveScriptVersion(projectId, r.data, "api", r.model), model: r.model, usage: r.usage, costUsd: r.costUsd };
}

/* -------------------- Caminho B: preparar para Claude Code -------------------- */
export function claudeCodeDir(projectId: string) {
  return path.join(projectDir(projectId), "claude-code");
}

export function prepareForClaudeCode(projectId: string, task: "roteiro" | "revisao" = "roteiro", note?: string) {
  const dir = claudeCodeDir(projectId);
  fs.mkdirSync(path.join(dir, "resultados"), { recursive: true });
  const brief = buildScriptBrief(projectId, { revisionNote: note });
  const schema = z.toJSONSchema(ScriptDoc);
  const p = getProject(projectId);
  fs.writeFileSync(path.join(dir, "roteiro.schema.json"), JSON.stringify(schema, null, 1));
  fs.writeFileSync(path.join(dir, "contexto.json"), JSON.stringify({ projeto: { id: projectId, titulo: p.title, tipo: p.kind, configuracoes: p.settings }, metaDePalavras: brief.wordTarget, direcaoDoCanalVersao: brief.channelVersion, modeloRecomendado: getConfig("anthropic").model }, null, 1));
  fs.writeFileSync(path.join(dir, "INSTRUCOES_DO_SISTEMA.md"), brief.system);
  fs.writeFileSync(path.join(dir, "BRIEF.md"), brief.user);
  const claudeMd = `# Tarefa do E Se? Studio — ${task === "roteiro" ? "roteiro do episódio" : "revisão do roteiro"}

Você está na pasta preparada pelo E Se? Studio para o projeto **${p.title}** (\`${projectId}\`).
Use a sua instalação oficial do Claude Code, com a sua conta. Este aplicativo não intermedeia login.

1. Leia \`INSTRUCOES_DO_SISTEMA.md\` (regras narrativas e método yt-script) e \`BRIEF.md\` (premissa, estilo, direção do canal).
2. Escreva o roteiro como JSON **válido** segundo \`roteiro.schema.json\` em \`resultados/roteiro.json\`.
   - cinco ganchos em \`hookOptions\`, com a fórmula usada;
   - cenas com \`key\` estável (s01, s02, …), falas narráveis, pausas e emoções;
   - cerca de ${brief.wordTarget} palavras faladas.
3. Opcional: rode as skills do projeto em \`.claude/skills/\` (yt-script) para avaliar os ganchos.
4. Volte ao aplicativo e clique em **Importar resultados**. O arquivo será validado; se houver erro, ele mostra o campo.

Recomendado: modelo \`${getConfig("anthropic").model}\` (no Claude Code: \`/model\`). Registre no campo opcional \`"_modelo"\` do JSON o modelo usado.
`;
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), claudeMd);
  // skills do projeto disponíveis também nesta pasta
  const skillsSrc = path.join(ROOT, ".claude", "skills");
  if (fs.existsSync(skillsSrc)) fs.cpSync(skillsSrc, path.join(dir, ".claude", "skills"), { recursive: true });
  const instruction = `Leia CLAUDE.md nesta pasta e execute a tarefa: escreva resultados/roteiro.json validando contra roteiro.schema.json.`;
  return { dir, instruction, terminal: `cd "${dir}" && claude`, files: fs.readdirSync(dir) };
}

export function importFromClaudeCode(projectId: string) {
  const f = path.join(claudeCodeDir(projectId), "resultados", "roteiro.json");
  if (!fs.existsSync(f)) throw new UserError("Nenhum resultado encontrado em claude-code/resultados/roteiro.json", 404);
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e: any) { throw new UserError("roteiro.json não é JSON válido: " + e.message, 422); }
  const model = typeof raw._modelo === "string" ? raw._modelo : "não informado (Claude Code)";
  delete raw._modelo;
  const r = saveScriptVersion(projectId, raw, "claude-code", `claude-code:${model}`);
  fs.renameSync(f, f.replace(/roteiro\.json$/, `roteiro_importado_v${r.version}.json`));
  return r;
}
