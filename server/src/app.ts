import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fstatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db, j, now, uid } from "./db.js";
import { DATA_DIR, PROJECTS_DIR, SOUNDS_DIR, WEB_DIST, projectDir, safeJoin } from "./paths.js";
import { ProjectSettings, ChannelProfile, ShotPlan } from "./contracts.js";
import { UserError, sha256File, measureLoudness } from "./util.js";
import { enqueue, getJob, listJobs, jobEvents, requestCancel, retryJob } from "./jobs.js";
import { projectSteps } from "./steps.js";
import { refreshCatalog, listStyles, getStyleVersion, styleHash, createVariant, AUTHORIAL_STYLE } from "./catalog/catalog.js";
import { latestScript, saveScriptVersion, prepareForClaudeCode, importFromClaudeCode, channelProfile, saveChannelProfile, buildScriptBrief } from "./pipeline/script.js";
import { ENGINES, engine, translateRecipe } from "./providers/tts.js";
import { voiceCast, setVoiceCast, splitIntoSegments, listSegments, updateSegment, chooseTake, sampleVoice, masterFromUpload, analyzeReference, durationCheck, getProject } from "./pipeline/narration.js";
import { approveMaster, latestMaster, staleReport, NEXT_ACTION_AUDIO, VISUAL_JOB_TYPES } from "./pipeline/audio-gate.js";
import { listScenes, editScene } from "./pipeline/storyboard.js";
import { currentCues, shiftCue } from "./sound/cues.js";
import { suggestShorts, createDerivedShort } from "./pipeline/shorts.js";
import { SKILLS, discoverSkillCatalog, runEditorialSkill, type SkillId } from "./editorial/skills.js";
import { planCommand, applyCommand } from "./commands.js";
import { DEFAULTS, getConfig, setConfig, getStatus, costSummary } from "./providers/config.js";
import { SECRET_NAMES, getSecret, setSecret, deleteSecret, mask, secretBackend, keyringAvailable, type SecretName } from "./secrets.js";
import { testAnthropic, listAnthropicModels } from "./providers/anthropic.js";
import { testOpenAI, listImageModels, estimateImages, IMAGE_QUALITIES } from "./providers/openai-images.js";
import { localStatus, runpodStatus, muapiStatus, planAiClips, VIDEO_LIMITS } from "./providers/video.js";
import { doctor } from "./diagnostics.js";
import { SERVER_MODE, initAuth, checkPassword, makeCookie, clearCookie, validSession, loginAllowed, registerFailure } from "./auth.js";

export async function buildApp(opts: { port: number; devOrigins?: string[] }) {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, trustProxy: process.env.ESE_MODO === "servidor" });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, files: 1 } });

  /* ------------------------ proteção da API local ------------------------ */
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${opts.port}`, `http://localhost:${opts.port}`, ...(opts.devOrigins ?? [])]);
  // Modo prévia (ESE_PREVIEW=1): só para visualizar a interface por um proxy de pré-visualização.
  // Desliga a checagem de host/origem, mantém o cabeçalho anti-CSRF e BLOQUEIA o cadastro de chaves.
  const preview = process.env.ESE_PREVIEW === "1";
  initAuth();
  const domain = process.env.ESE_DOMINIO ?? "";
  app.post("/api/login", async (req, reply) => {
    if (!SERVER_MODE) return { ok: true, mode: "local" };
    const ip = req.ip;
    if (!loginAllowed(ip)) return reply.code(429).send({ error: "Muitas tentativas. Aguarde 15 minutos." });
    if (!checkPassword((req.body as any)?.senha)) { registerFailure(ip); return reply.code(401).send({ error: "Senha incorreta" }); }
    reply.header("set-cookie", makeCookie());
    return { ok: true };
  });
  app.post("/api/logout", async (_req, reply) => { reply.header("set-cookie", clearCookie()); return { ok: true }; });
  app.addHook("onRequest", async (req, reply) => {
    if (SERVER_MODE) {
      // servidor: só o domínio configurado, via HTTPS (Caddy), com sessão válida
      if (domain && String(req.headers.host ?? "") !== domain) return reply.code(403).send({ error: "Host não permitido" });
      const origin = req.headers.origin;
      if (origin && domain && origin !== `https://${domain}`) return reply.code(403).send({ error: "Origem não permitida" });
      const isApi = req.url.startsWith("/api/");
      if (isApi && req.url !== "/api/login" && req.url !== "/api/health" && !validSession(req.headers.cookie)) return reply.code(401).send({ error: "Faça login", nextAction: "Entrar" });
      if (isApi && !["GET", "HEAD"].includes(req.method) && req.headers["x-ese"] !== "1") return reply.code(403).send({ error: "Cabeçalho x-ese ausente (proteção CSRF)" });
      return;
    }
    if (preview) {
      if (req.url.startsWith("/api/segredos")) return reply.code(403).send({ error: "Modo prévia: cadastro de chaves desativado. Rode o sistema no seu computador para configurar as chaves." });
      if (req.url.startsWith("/api/") && !["GET", "HEAD"].includes(req.method) && req.headers["x-ese"] !== "1") return reply.code(403).send({ error: "Cabeçalho x-ese ausente (proteção CSRF)" });
      return;
    }
    const host = String(req.headers.host ?? "");
    if (!allowedHosts.has(host) && !(opts.devOrigins?.length && /^(127\.0\.0\.1|localhost):\d+$/.test(host))) return reply.code(403).send({ error: "Host não permitido (proteção contra DNS rebinding)" });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: "Origem não permitida" });
    if (req.url.startsWith("/api/") && !["GET", "HEAD"].includes(req.method) && req.headers["x-ese"] !== "1") return reply.code(403).send({ error: "Cabeçalho x-ese ausente (proteção CSRF)" });
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof UserError) return reply.code(err.status).send({ error: err.message, nextAction: err.nextAction ?? null });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: "Dados inválidos", issues: err.issues.slice(0, 10) });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    console.error(err);
    return reply.code(500).send({ error: String(err.message ?? err) });
  });
  const P = (req: FastifyRequest) => (req.params as any);
  const B = (req: FastifyRequest) => (req.body as any) ?? {};
  const Q = (req: FastifyRequest) => (req.query as any) ?? {};
  const pid = (req: FastifyRequest) => { const id = P(req).id; getProject(id); return id as string; };

  /* --------------------------------- geral --------------------------------- */
  app.get("/api/health", async () => ({ ok: true, at: now(), mode: SERVER_MODE ? "servidor" : "local" }));
  app.get("/api/diagnostico", async () => doctor());
  app.get("/api/painel", async () => {
    const projects = db().prepare("SELECT id,title,kind,status,updated_at,is_demo FROM projects WHERE is_test=0 ORDER BY updated_at DESC LIMIT 12").all();
    const running = listJobs({ status: "produzindo" });
    const queued = listJobs({ status: "em fila" });
    const failed = db().prepare("SELECT * FROM jobs WHERE status='falhou' AND finished_at > datetime('now','-7 days') ORDER BY finished_at DESC LIMIT 10").all();
    const du = (d: string): number => { let s = 0; if (!fs.existsSync(d)) return 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); s += e.isDirectory() ? du(f) : e.isFile() ? fs.statSync(f).size : 0; } return s; };
    return { projects, running, queued, failed, storage: { projetosBytes: du(PROJECTS_DIR), cacheBytes: du(path.join(DATA_DIR, "cache")), modelosBytes: du(path.join(DATA_DIR, "modelos")) }, costs: costSummary() };
  });
  app.get("/api/custos", async (req) => ({ rows: costSummary(Q(req).projectId), note: "estimado = calculado a partir do uso medido e preços informados; confirmado = valor do provedor; indisponível = sem dado confiável" }));

  /* -------------------------------- projetos -------------------------------- */
  app.get("/api/projects", async () => db().prepare("SELECT id,title,kind,parent_id,status,is_demo,is_test,created_at,updated_at FROM projects ORDER BY updated_at DESC").all());
  app.post("/api/projects", async (req) => {
    const b = B(req);
    const kind = z.enum(["long", "short", "package"]).parse(b.kind ?? "long");
    const settings = ProjectSettings.parse({ ...b.settings, format: kind === "short" ? "9:16" : "16:9" });
    if (kind !== "short" && (settings.targetSeconds < 300 || settings.targetSeconds > 600)) throw new UserError("Vídeo longo: duração entre 300 e 600 segundos.");
    if (kind === "short" && settings.targetSeconds > 90) throw new UserError("Curto: até 90 segundos.");
    if (settings.aiScenes.enabled && !settings.aiScenes.where) throw new UserError("Escolha onde gerar as cenas por IA: Minha máquina ou RunPod.");
    const styleId = settings.styleId ?? AUTHORIAL_STYLE.id;
    const hash = styleHash(styleId);
    if (settings.styleId && !hash) throw new UserError("Estilo não encontrado no catálogo");
    const id = "p" + uid("").slice(0, 15);
    db().prepare("INSERT INTO projects(id,title,kind,settings_json,style_lock_json,bible_json,status,is_demo,is_test,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, b.title ?? settings.premise.slice(0, 80), kind, JSON.stringify({ ...settings, styleId }), JSON.stringify({ styleId, hash, lockedAt: now() }), "{}", "rascunho", b.isDemo ? 1 : 0, b.isTest ? 1 : 0, now(), now());
    projectDir(id);
    return { id };
  });
  app.get("/api/projects/:id", async (req) => {
    const id = pid(req);
    const p = getProject(id);
    const script = latestScript(id);
    const masters = db().prepare("SELECT id,version,script_version,sha256,duration,status,origin,created_at,speakers_json FROM narration_masters WHERE project_id=? ORDER BY version DESC").all(id);
    const approvals = db().prepare("SELECT * FROM audio_approvals WHERE project_id=? ORDER BY approved_at DESC").all(id);
    const latest = latestMaster(id);
    return {
      project: { ...p, style: getStyleVersion(j<any>(p.style_lock_json, {}).styleId, j<any>(p.style_lock_json, {}).hash) },
      steps: projectSteps(id), script, masters, approvals, durationCheck: latest ? durationCheck(id, latest.duration) : null,
      segments: script ? listSegments(id, script.version) : [], cast: voiceCast(id), scenes: listScenes(id),
      exports: db().prepare("SELECT * FROM exports WHERE project_id=? ORDER BY created_at DESC").all(id).map((e: any) => ({ ...e, validation: j(e.validation_json, null) })),
      reviewClips: db().prepare("SELECT * FROM review_clips WHERE project_id=? ORDER BY created_at DESC, idx LIMIT 5").all(id).map((r: any) => ({ ...r, data: j(r.data_json, {}) })),
      jobs: listJobs({ projectId: id, limit: 30 }), costs: costSummary(id), stale: staleReport(id),
      children: db().prepare("SELECT id,title,kind,status FROM projects WHERE parent_id=?").all(id),
    };
  });
  app.patch("/api/projects/:id/settings", async (req) => {
    const id = pid(req);
    const p = getProject(id);
    const patch = B(req);
    const audioKeys = ["premise", "language", "perspective", "targetSeconds", "voice"];
    const next = ProjectSettings.parse({ ...p.settings, ...patch });
    if (patch.styleId && patch.styleId !== p.settings.styleId) {
      const hash = styleHash(patch.styleId);
      if (!hash) throw new UserError("Estilo não encontrado");
      db().prepare("UPDATE projects SET style_lock_json=? WHERE id=?").run(JSON.stringify({ styleId: patch.styleId, hash, lockedAt: now() }), id);
      db().prepare("UPDATE scenes SET render_hash=NULL WHERE project_id=?").run(id);
    }
    db().prepare("UPDATE projects SET settings_json=?, updated_at=? WHERE id=?").run(JSON.stringify(next), now(), id);
    return { ok: true, affectsAudio: audioKeys.filter((k) => k in patch), note: "Mudanças só visuais não regeneram a narração." };
  });

  /* -------------------------------- roteiro -------------------------------- */
  app.post("/api/projects/:id/roteiro/gerar", async (req) => ({ job: enqueue("script_generate", pid(req), { revisionNote: B(req).revisionNote }, { paid: true }) }));
  app.get("/api/projects/:id/roteiro/brief", async (req) => buildScriptBrief(pid(req)));
  app.put("/api/projects/:id/roteiro", async (req) => saveScriptVersion(pid(req), B(req).doc, "manual", null));
  app.get("/api/projects/:id/roteiro/versoes", async (req) => db().prepare("SELECT version,origin,model,created_at,report_json FROM script_versions WHERE project_id=? ORDER BY version DESC").all(pid(req)).map((r: any) => ({ ...r, report: j(r.report_json, {}) })));
  app.post("/api/projects/:id/claude-code/preparar", async (req) => prepareForClaudeCode(pid(req), B(req).task ?? "roteiro", B(req).note));
  app.post("/api/projects/:id/claude-code/importar", async (req) => importFromClaudeCode(pid(req)));
  app.post("/api/projects/:id/claude-code/abrir-pasta", async (req) => {
    const dir = path.join(projectDir(pid(req)), "claude-code");
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    try { spawn(cmd, [dir], { detached: true, stdio: "ignore", shell: false }).unref(); return { ok: true, dir }; } catch { return { ok: false, dir }; }
  });

  /* ---------------------------------- voz ---------------------------------- */
  app.get("/api/voz/motores", async () => Promise.all(Object.values(ENGINES).map(async (e) => ({ id: e.id, name: e.name, local: e.local, license: e.license, weightsLicense: e.weightsLicense, status: await e.status(), controls: await e.controls() }))));
  app.get("/api/voz/vozes", async (req) => engine(Q(req).engine ?? "kokoro").voices());
  /** Amostra fora de projeto ("Ouvir com meu texto" no Estúdio de voz). Mede loudness para A/B com volume equivalente. */
  app.post("/api/voz/amostra", async (req) => {
    const b = B(req);
    const text = String(b.text ?? "").slice(0, 400);
    if (!text.trim()) throw new UserError("Digite um texto");
    const dir = path.join(DATA_DIR, "cache", "amostras"); fs.mkdirSync(dir, { recursive: true });
    const name = `amostra_${Date.now()}_${Math.random().toString(16).slice(2, 6)}.wav`;
    const setting = b.setting;
    let blend: any, instruction = setting.instruction;
    if (setting.recipe?.length) { const tr = await translateRecipe(setting.engine, setting.recipe); blend = tr.blend; instruction = [instruction, tr.instruction].filter(Boolean).join(" ") || undefined; }
    const r = await engine(setting.engine).speak({ text, voice: setting.voice, speed: setting.speed ?? 1, language: setting.language ?? "pt-br", instruction, blend }, path.join(dir, name));
    const L = await measureLoudness(r.path);
    return { url: `/api/voz/amostras/${name}`, duration: r.duration, engine: r.engine, controlsApplied: r.controlsApplied, loudness: L.integrated, setting };
  });
  app.get("/api/voz/amostras/:name", async (req, reply) => sendFile(reply, safeJoin(path.join(DATA_DIR, "cache", "amostras"), P(req).name), req));
  app.post("/api/voz/receita/traduzir", async (req) => translateRecipe(B(req).engine, B(req).parts));
  app.post("/api/projects/:id/voz/amostra", async (req) => { const r = await sampleVoice(pid(req), B(req).setting, B(req).text); return { ...r, url: `/api/projects/${P(req).id}/arquivo/${path.relative(projectDir(P(req).id), r.path)}` }; });
  app.get("/api/projects/:id/voz/elenco", async (req) => voiceCast(pid(req)));
  app.put("/api/projects/:id/voz/elenco", async (req) => { setVoiceCast(pid(req), B(req)); return { ok: true, note: "Mudar voz, velocidade ou receita exige gerar e aprovar uma nova narração." }; });
  app.post("/api/projects/:id/voz/segmentos", async (req) => splitIntoSegments(pid(req), B(req).scriptVersion ?? latestScript(P(req).id)?.version));
  app.patch("/api/segmentos/:sid", async (req) => updateSegment(P(req).sid, B(req)));
  app.post("/api/segmentos/:sid/take", async (req) => {
    const s = db().prepare("SELECT project_id FROM speech_segments WHERE id=?").get(P(req).sid) as any;
    if (!s) throw new UserError("Trecho não encontrado", 404);
    return { job: enqueue("segment_take", s.project_id, { segmentId: P(req).sid, override: B(req).override }) };
  });
  app.post("/api/segmentos/:sid/escolher", async (req) => { chooseTake(P(req).sid, B(req).takeId); return { ok: true }; });
  app.post("/api/projects/:id/narracao/gerar", async (req) => ({ job: enqueue("narration_full", pid(req), { scriptVersion: B(req).scriptVersion ?? latestScript(P(req).id)?.version, regenerateAll: !!B(req).regenerateAll }) }));
  app.post("/api/projects/:id/narracao/montar", async (req) => ({ job: enqueue("master_build", pid(req), { scriptVersion: B(req).scriptVersion ?? latestScript(P(req).id)?.version }) }));
  app.post("/api/projects/:id/narracao/upload", async (req) => {
    const id = pid(req);
    const f = await (req as any).file();
    if (!f) throw new UserError("Envie um arquivo de áudio");
    const dest = path.join(projectDir(id), "voz", "uploads", `${Date.now()}_${path.basename(f.filename).replace(/[^\w.-]/g, "_")}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, await f.toBuffer());
    const sv = latestScript(id)?.version;
    if (!sv) throw new UserError("Crie ou importe o roteiro antes de enviar a narração (o texto é usado no alinhamento).");
    splitIntoSegments(id, sv);
    return masterFromUpload(id, sv, dest);
  });
  app.post("/api/projects/:id/narracao/aprovar", async (req) => {
    const b = B(req);
    if (!b.confirm) throw new UserError("Confirme que ouviu a narração completa.");
    return approveMaster(pid(req), b.masterId, b.by ?? "usuário local", b.notes ?? "");
  });
  app.post("/api/projects/:id/narracao/alinhar", async (req) => ({ job: enqueue("align", pid(req), {}) }));
  app.get("/api/projects/:id/narracao/:mid/audio", async (req, reply) => {
    const m = db().prepare("SELECT path FROM narration_masters WHERE id=? AND project_id=?").get(P(req).mid, P(req).id) as any;
    if (!m) throw new UserError("Master não encontrado", 404);
    return sendFile(reply, m.path, req);
  });
  app.post("/api/voz/clonar", async (req) => {
    const parts = (req as any).parts();
    const fields: any = {}; let file: string | null = null;
    for await (const part of parts) {
      if (part.type === "file") { file = path.join(DATA_DIR, "vozes", `${Date.now()}_${path.basename(part.filename).replace(/[^\w.-]/g, "_")}`); fs.mkdirSync(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, await part.toBuffer()); }
      else fields[part.fieldname] = part.value;
    }
    if (!file) throw new UserError("Envie ou grave uma amostra");
    if (fields.authorized !== "true") throw new UserError("Confirme que a voz é sua ou que você tem autorização do titular.", 400);
    const quality = await analyzeReference(file);
    const consent = { authorized: true, statement: fields.statement ?? "Declaro que tenho autorização para clonar esta voz.", origin: fields.origin ?? "gravação própria", owner: fields.owner ?? "", at: now(), sampleSha256: await sha256File(file) };
    const e = fields.engine ?? "voicestudio";
    let engineResult: any = null, state = "amostra salva localmente";
    if (e === "voicestudio") {
      const st = await ENGINES.voicestudio.status();
      if (st.state === "disponível") { engineResult = await (ENGINES.voicestudio as any).clone({ name: fields.name, file, refText: fields.refText ?? "", language: fields.language ?? "Auto" }); state = "clonada no VoiceStudio (local)"; }
      else state = `pendente: ${st.detail}`;
    } else throw new UserError(`O motor ${e} não suporta clonagem.`, 400);
    const id = uid("vp_");
    db().prepare("INSERT INTO voice_profiles(id,name,engine,engine_voice,kind,language,data_json,consent_json,sample_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, fields.name ?? "Minha voz", e, engineResult?.id ?? null, "clone", fields.language ?? "pt-BR", JSON.stringify({ quality, engineResult, state }), JSON.stringify(consent), file, now());
    return { id, quality, state, note: "A amostra permanece no seu computador. O VoiceStudio roda localmente; nada é enviado a serviços remotos por este aplicativo." };
  });
  app.post("/api/voz/analisar-referencia", async (req) => {
    const f = await (req as any).file(); if (!f) throw new UserError("Envie um arquivo");
    const tmp = path.join(DATA_DIR, "cache", `ref_${Date.now()}_${path.basename(f.filename).replace(/[^\w.-]/g, "_")}`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true }); await fs.promises.writeFile(tmp, await f.toBuffer());
    try { return await analyzeReference(tmp); } finally { fs.rmSync(tmp, { force: true }); }
  });
  app.post("/api/voz/design", async (req) => {
    const st = await ENGINES.voicestudio.status();
    if (st.state !== "disponível") throw new UserError(`“Criar voz por descrição” exige um motor com voice design (VoiceStudio/OmniVoice): ${st.detail}`, 412);
    const r = await (ENGINES.voicestudio as any).design(B(req));
    const id = uid("vp_");
    db().prepare("INSERT INTO voice_profiles(id,name,engine,engine_voice,kind,language,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, B(req).name, "voicestudio", r?.id ?? null, "design", B(req).language ?? "pt-BR", JSON.stringify({ instruct: B(req).instruct, r }), now());
    return { id, r };
  });
  app.get("/api/voz/perfis", async () => db().prepare("SELECT id,name,engine,engine_voice,kind,language,data_json,consent_json,created_at FROM voice_profiles ORDER BY created_at DESC").all().map((r: any) => ({ ...r, data: j(r.data_json, {}), consent: j(r.consent_json, null) })));
  app.delete("/api/voz/perfis/:vid", async (req) => {
    const r = db().prepare("SELECT sample_path FROM voice_profiles WHERE id=?").get(P(req).vid) as any;
    if (r?.sample_path) fs.rmSync(r.sample_path, { force: true });
    db().prepare("DELETE FROM voice_profiles WHERE id=?").run(P(req).vid);
    return { ok: true, note: "Perfil e amostra local removidos. Se o perfil existir no VoiceStudio, remova-o lá também." };
  });
  app.post("/api/voz/receitas", async (req) => { const b = B(req); const tr = await translateRecipe(b.engine, b.parts); const id = uid("vr_"); db().prepare("INSERT INTO voice_recipes(id,name,engine,recipe_json,translation_json,created_at) VALUES(?,?,?,?,?,?)").run(id, b.name, b.engine, JSON.stringify(b.parts), JSON.stringify(tr), now()); return { id, translation: tr }; });
  app.get("/api/voz/receitas", async () => db().prepare("SELECT * FROM voice_recipes ORDER BY created_at DESC").all().map((r: any) => ({ ...r, parts: j(r.recipe_json, []), translation: j(r.translation_json, {}) })));
  app.get("/api/projects/:id/pronuncia", async (req) => db().prepare("SELECT * FROM pronunciations WHERE project_id=? OR project_id IS NULL").all(pid(req)));
  app.post("/api/projects/:id/pronuncia", async (req) => { const id = uid("pr_"); db().prepare("INSERT INTO pronunciations(id,project_id,term,say) VALUES(?,?,?,?)").run(id, pid(req), B(req).term, B(req).say); return { id }; });
  app.delete("/api/pronuncia/:pr", async (req) => { db().prepare("DELETE FROM pronunciations WHERE id=?").run(P(req).pr); return { ok: true }; });

  /* ------------------------------ storyboard/cenas ------------------------------ */
  app.post("/api/projects/:id/storyboard", async (req) => ({ job: enqueue("storyboard", pid(req), {}) }));
  app.get("/api/projects/:id/cenas", async (req) => listScenes(pid(req)));
  app.patch("/api/projects/:id/cenas/:key", async (req) => { const b = B(req); if (b.shots) z.array(ShotPlan).parse(b.shots); return editScene(pid(req), P(req).key, b); });
  app.post("/api/projects/:id/cenas/render", async (req) => ({ job: enqueue("scene_render", pid(req), { keys: B(req).keys, format: B(req).format }, { idempotencyKey: `render:${P(req).id}:${(B(req).keys ?? ["*"]).join(",")}:${Date.now() >> 14}` }) }));
  app.get("/api/projects/:id/imagens/plano", async (req) => {
    const keys = String(Q(req).keys ?? "").split(",").filter(Boolean); const roles = String(Q(req).roles ?? "fundo").split(",");
    const n = keys.length * roles.length; const est = estimateImages(n);
    return { images: n, model: getConfig("openai").imageModel, quality: getConfig("openai").quality, cost: est, budget: getProject(P(req).id).settings.budgetUsd };
  });
  app.post("/api/projects/:id/imagens", async (req) => {
    if (!B(req).confirm) throw new UserError("Confirme o plano de geração paga (quantidade, qualidade e custo).");
    return { job: enqueue("image", pid(req), { keys: B(req).keys, roles: B(req).roles ?? ["fundo"], force: !!B(req).force }, { paid: true }) };
  });
  app.post("/api/projects/:id/midia", async (req) => {
    const id = pid(req);
    const parts = (req as any).parts(); const fields: any = {}; let file: string | null = null, mime = "";
    for await (const part of parts) {
      if (part.type === "file") { mime = part.mimetype; if (!/^image\/(png|jpeg|webp)$|^audio\//.test(mime)) throw new UserError("Tipo de arquivo não suportado"); file = path.join(projectDir(id), "midia", `${Date.now()}_${path.basename(part.filename).replace(/[^\w.-]/g, "_")}`); fs.mkdirSync(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, await part.toBuffer()); }
      else fields[part.fieldname] = part.value;
    }
    if (!file) throw new UserError("Envie um arquivo");
    const aid = uid("ast_");
    db().prepare("INSERT INTO assets(id,project_id,kind,path,sha256,mime,provenance_json,scene_key,character_key,approved,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(aid, id, fields.kind ?? "imagem-fundo", file, await sha256File(file), mime, JSON.stringify({ origin: "upload do usuário", license: fields.license ?? "declarada pelo usuário" }), fields.sceneKey ?? null, fields.characterKey ?? null, 1, now());
    if (fields.characterKey) db().prepare("UPDATE characters SET ref_asset_id=? WHERE project_id=? AND stable_key=?").run(aid, id, fields.characterKey);
    return { assetId: aid };
  });
  app.get("/api/midia", async (req) => db().prepare(`SELECT id,project_id,kind,path,mime,provenance_json,scene_key,created_at FROM assets ${Q(req).projectId ? "WHERE project_id=?" : ""} ORDER BY created_at DESC LIMIT 300`).all(...(Q(req).projectId ? [Q(req).projectId] : [])).map((a: any) => ({ ...a, provenance: j(a.provenance_json, {}), url: a.project_id ? `/api/projects/${a.project_id}/arquivo/${path.relative(path.join(PROJECTS_DIR, a.project_id), a.path)}` : null })));
  app.get("/api/projects/:id/ia/plano", async (req) => {
    const p = getProject(pid(req)); const keys = String(Q(req).keys ?? "").split(",").filter(Boolean);
    const scenes = listScenes(p.id).filter((s) => keys.includes(s.stable_key));
    const st = p.settings.aiScenes?.where === "runpod" ? await runpodStatus() : await localStatus();
    return { enabled: !!p.settings.aiScenes?.enabled, where: p.settings.aiScenes?.where, status: st, limits: VIDEO_LIMITS, scenes: scenes.map((s) => ({ key: s.stable_key, t0: s.t0, t1: s.t1, clips: planAiClips(s.t0, s.t1) })), uploads: "Somente prompt e parâmetros (sem imagens) vão ao RunPod; local não envia nada.", cost: p.settings.aiScenes?.where === "runpod" ? (getConfig("runpod").pricePerSecondUsd ? { kind: "estimado", perSecondUsd: getConfig("runpod").pricePerSecondUsd } : { kind: "indisponível" }) : { kind: "local (sem cobrança de API)" } };
  });
  app.post("/api/projects/:id/ia", async (req) => { if (!B(req).confirm) throw new UserError("Confirme o plano das cenas por IA."); return { job: enqueue("ai_scene", pid(req), { keys: B(req).keys }, { paid: getProject(P(req).id).settings.aiScenes?.where === "runpod" }) }; });
  app.post("/api/projects/:id/montar", async (req) => ({ job: enqueue("assemble", pid(req), { format: B(req).format, music: B(req).music ?? null }) }));
  app.post("/api/projects/:id/comando/plano", async (req) => planCommand(pid(req), B(req).text));
  app.post("/api/projects/:id/comando/aplicar", async (req) => applyCommand(pid(req), B(req).text));

  /* ---------------------------------- som ---------------------------------- */
  app.get("/api/projects/:id/som", async (req) => ({ cues: currentCues(pid(req)), kit: fs.existsSync(path.join(SOUNDS_DIR, "openverse_manifest.json")) ? j(fs.readFileSync(path.join(SOUNDS_DIR, "openverse_manifest.json"), "utf8"), {}) : null }));
  app.post("/api/projects/:id/som/cues/:cue/deslocar", async (req) => shiftCue(pid(req), P(req).cue, Number(B(req).frames) | 0));
  app.post("/api/projects/:id/som/trechos/:exp/:idx", async (req) => { db().prepare("UPDATE review_clips SET verdict=?, note=? WHERE project_id=? AND export_id=? AND idx=?").run(z.enum(["aprovado", "ajustar"]).parse(B(req).verdict), B(req).note ?? "", pid(req), P(req).exp, Number(P(req).idx)); return { ok: true }; });
  app.post("/api/som/kit-openverse", async () => ({ job: enqueue("openverse_kit", null, {}) }));
  app.get("/api/som/creditos", async () => ({ text: fs.existsSync(path.join(SOUNDS_DIR, "CREDITOS.txt")) ? fs.readFileSync(path.join(SOUNDS_DIR, "CREDITOS.txt"), "utf8") : null }));
  app.get("/api/som/arquivo/:name", async (req, reply) => sendFile(reply, safeJoin(SOUNDS_DIR, P(req).name), req));

  /* --------------------------------- curtos --------------------------------- */
  app.get("/api/projects/:id/curtos/sugestoes", async (req) => suggestShorts(pid(req), Number(Q(req).count ?? 3), Number(Q(req).min ?? 45), Number(Q(req).max ?? 60)));
  app.post("/api/projects/:id/curtos", async (req) => createDerivedShort(pid(req), B(req)));

  /* --------------------------------- estilos --------------------------------- */
  app.get("/api/estilos", async () => listStyles());
  app.post("/api/estilos/atualizar", async () => refreshCatalog());
  app.get("/api/estilos/relatorios", async () => db().prepare("SELECT * FROM catalog_reports ORDER BY created_at DESC LIMIT 10").all().map((r: any) => ({ ...r, data: j(r.data_json, {}) })));
  app.post("/api/estilos/:sid/favorito", async (req) => { const on = B(req).on !== false; if (on) db().prepare("INSERT OR IGNORE INTO favorites(kind,ref,created_at) VALUES('style',?,?)").run(P(req).sid, now()); else db().prepare("DELETE FROM favorites WHERE kind='style' AND ref=?").run(P(req).sid); return { ok: true }; });
  app.post("/api/estilos/:sid/variacao", async (req) => ({ id: createVariant(P(req).sid, B(req).name, B(req).overrides ?? {}) }));
  app.get("/api/estilos/variacoes", async () => db().prepare("SELECT * FROM style_variants ORDER BY created_at DESC").all().map((v: any) => ({ ...v, overrides: j(v.overrides_json, {}) })));
  app.get("/api/estilos/:sid/miniatura", async (req, reply) => { const s = getStyleVersion(P(req).sid); if (!s?.thumb) return reply.code(404).send(); return sendFile(reply, s.thumb, req, 86400); });
  app.post("/api/estilos/:sid/demo-local", async (req) => ({ job: enqueue("style_demo", null, { styleId: P(req).sid }, { idempotencyKey: `demo:${P(req).sid}:${styleHash(P(req).sid)}` }) }));
  app.get("/api/estilos/:sid/demo-local", async (req, reply) => {
    const job = db().prepare("SELECT result_json FROM jobs WHERE type='style_demo' AND status='concluído' AND payload_json=? ORDER BY finished_at DESC LIMIT 1").get(JSON.stringify({ styleId: P(req).sid })) as any;
    const f = j<any>(job?.result_json, null)?.path;
    if (!f || !fs.existsSync(f)) return reply.code(404).send({ error: "Demo local ainda não gerada" });
    return sendFile(reply, f, req);
  });

  /* --------------------------------- séries --------------------------------- */
  app.get("/api/series", async () => db().prepare("SELECT * FROM series ORDER BY created_at DESC").all().map((s: any) => ({ ...s, episodes: db().prepare("SELECT e.*, p.title, p.status FROM episodes e LEFT JOIN projects p ON p.id=e.project_id WHERE series_id=? ORDER BY season, number").all(s.id) })));
  app.post("/api/series", async (req) => { const id = uid("ser_"); db().prepare("INSERT INTO series(id,title,premise,bible_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, B(req).title, B(req).premise ?? "", "{}", now(), now()); return { id }; });
  app.post("/api/series/:sid/episodios", async (req) => {
    const b = B(req);
    if (b.audienceChoice && !b.audienceChoiceSource) throw new UserError("Informe a origem da escolha do público (ex.: “enquete inserida pelo usuário em 07/11”). Não registramos votações inexistentes.");
    const id = uid("ep_"); const n = (db().prepare("SELECT COALESCE(MAX(number),0)+1 n FROM episodes WHERE series_id=? AND season=?").get(P(req).sid, b.season ?? 1) as any).n;
    db().prepare("INSERT INTO episodes(id,series_id,project_id,season,number,recap,audience_choice,audience_choice_source,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, P(req).sid, b.projectId ?? null, b.season ?? 1, n, b.recap ?? null, b.audienceChoice ?? null, b.audienceChoiceSource ?? null, now());
    return { id, number: n };
  });

  /* --------------------------------- YouTube --------------------------------- */
  app.get("/api/youtube/skills", async () => ({ skills: SKILLS, catalog: discoverSkillCatalog() }));
  app.post("/api/youtube/:skill", async (req) => {
    const skill = P(req).skill as SkillId;
    if (!(skill in SKILLS)) throw new UserError("Skill desconhecida", 404);
    const b = B(req);
    if (b.async) return { job: enqueue("editorial", b.projectId ?? null, { skill, input: b.input ?? {} }) };
    return runEditorialSkill(b.projectId ?? null, skill, b.input ?? {});
  });
  app.get("/api/youtube/relatorios", async (req) => db().prepare(`SELECT * FROM editorial_reports ${Q(req).projectId ? "WHERE project_id=?" : ""} ORDER BY created_at DESC LIMIT 50`).all(...(Q(req).projectId ? [Q(req).projectId] : [])).map((r: any) => ({ ...r, data: j(r.data_json, {}), input: j(r.input_json, {}) })));
  app.get("/api/canal", async () => channelProfile());
  app.put("/api/canal", async (req) => saveChannelProfile(ChannelProfile.partial().parse(B(req))));
  app.get("/api/canal/versoes", async () => db().prepare("SELECT version, created_at FROM channel_profiles ORDER BY version DESC").all());

  /* ------------------------------ configurações ------------------------------ */
  app.get("/api/config", async () => {
    const secrets = Object.fromEntries((Object.keys(SECRET_NAMES) as SecretName[]).map((n) => [n, { configured: !!getSecret(n), masked: mask(getSecret(n)), backend: secretBackend(n), envVar: SECRET_NAMES[n] }]));
    const cfg = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, { config: getConfig(k as any), status: getStatus(k) }]));
    return { secrets, keyring: keyringAvailable(), config: cfg, imageQualities: IMAGE_QUALITIES, notes: {
      claude: "Renderização roda no seu computador; a inferência do Claude usa o serviço externo da Anthropic. Caminho A (API): chave própria e cobrança por uso. Caminho B (Claude Code): sua instalação oficial e sua conta; limites da assinatura continuam valendo; este app não faz login, não lê tokens e não intermedeia a assinatura.",
      openai: "A API OpenAI é cobrada à parte. Assinatura ChatGPT não dá crédito de API.",
      runpod: "A chave sozinha não cria um serviço: implante o worker de runpod-worker/ como endpoint Serverless e informe o ID.",
    } };
  });
  app.put("/api/config/:provider", async (req) => { const k = P(req).provider; if (!(k in DEFAULTS)) throw new UserError("Provedor desconhecido", 404); return setConfig(k as any, B(req)); });
  app.put("/api/segredos/:name", async (req) => { const n = P(req).name as SecretName; if (!(n in SECRET_NAMES)) throw new UserError("Segredo desconhecido", 404); const where = setSecret(n, String(B(req).value ?? "")); return { ok: true, where, masked: mask(getSecret(n)) }; });
  app.delete("/api/segredos/:name", async (req) => { const n = P(req).name as SecretName; if (!(n in SECRET_NAMES)) throw new UserError("Segredo desconhecido", 404); deleteSecret(n); return { ok: true }; });
  app.post("/api/config/:provider/testar", async (req) => {
    switch (P(req).provider) {
      case "anthropic": return testAnthropic();
      case "openai": return testOpenAI();
      case "runpod": return runpodStatus();
      case "local_video": return localStatus();
      case "voicestudio": return ENGINES.voicestudio.status();
      case "kokoro": return ENGINES.kokoro.status();
      case "muapi": return muapiStatus();
      default: throw new UserError("Sem teste para este provedor", 400);
    }
  });
  app.get("/api/config/anthropic/modelos", async () => listAnthropicModels());
  app.get("/api/config/openai/modelos", async () => listImageModels());

  /* ---------------------------------- jobs ---------------------------------- */
  app.get("/api/jobs", async (req) => listJobs({ projectId: Q(req).projectId, status: Q(req).status }).map(publicJob));
  app.get("/api/jobs/:jid", async (req) => { const jb = getJob(P(req).jid); if (!jb) throw new UserError("Job não encontrado", 404); return { ...publicJob(jb), events: jobEvents(jb.id), remote: db().prepare("SELECT provider,remote_id,endpoint,status,created_at,updated_at FROM remote_jobs WHERE job_id=?").all(jb.id) }; });
  app.post("/api/jobs/:jid/cancelar", async (req) => publicJob(requestCancel(P(req).jid)!));
  app.post("/api/jobs/:jid/retomar", async (req) => publicJob(retryJob(P(req).jid)!));
  app.get("/api/eventos", async (req, reply) => {
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let last = "";
    const tick = () => {
      const rows = db().prepare("SELECT id,project_id,type,status,progress,progress_label,progress_estimated,error,finished_at FROM jobs WHERE status IN ('em fila','produzindo') OR finished_at > datetime('now','-30 seconds') ORDER BY created_at DESC LIMIT 50").all();
      const s = JSON.stringify(rows);
      if (s !== last) { reply.raw.write(`data: ${s}\n\n`); last = s; }
    };
    tick();
    const iv = setInterval(tick, 1000);
    req.raw.on("close", () => clearInterval(iv));
  });

  /* -------------------------------- arquivos -------------------------------- */
  app.get("/api/projects/:id/arquivo/*", async (req, reply) => {
    const id = pid(req);
    const rel = (P(req)["*"] as string) ?? "";
    return sendFile(reply, safeJoin(path.join(PROJECTS_DIR, id), rel), req);
  });

  /* -------------------------------- frontend -------------------------------- */
  if (fs.existsSync(WEB_DIST)) {
    await app.register(fstatic, { root: WEB_DIST, prefix: "/" });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "Rota não encontrada" }) : reply.sendFile("index.html")));
  }
  return app;
}

function publicJob(jb: any) { return { ...jb, payload: j(jb.payload_json, {}), result: j(jb.result_json, null), payload_json: undefined, result_json: undefined, visual: VISUAL_JOB_TYPES.has(jb.type) }; }

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".srt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".md": "text/markdown; charset=utf-8" };
/** Envia arquivo com suporte a Range (players de áudio/vídeo). */
function sendFile(reply: FastifyReply, file: string, req: FastifyRequest, maxAge = 0) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return reply.code(404).send({ error: "Arquivo não encontrado" });
  if (path.basename(file) === "segredos.json") return reply.code(403).send();
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  reply.header("content-type", type).header("accept-ranges", "bytes").header("cache-control", maxAge ? `max-age=${maxAge}` : "no-cache").header("x-content-type-options", "nosniff");
  if (type.startsWith("text/html")) reply.header("content-security-policy", "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self' data:");
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0, end = m?.[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size) return reply.code(416).header("content-range", `bytes */${size}`).send();
    reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header("content-length", size);
  return reply.send(fs.createReadStream(file));
}
