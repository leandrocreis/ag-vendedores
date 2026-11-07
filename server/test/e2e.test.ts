import { TEST_DIR } from "./setup.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, now } from "../src/db.js";
import { ProjectSettings } from "../src/contracts.js";
import { FIXTURE_SCRIPT } from "./fixtures.js";
import { saveScriptVersion } from "../src/pipeline/script.js";
import { splitIntoSegments, listSegments, buildMaster, updateSegment, synthSegment } from "../src/pipeline/narration.js";
import { approveMaster, approvedMaster, latestMaster, staleReport } from "../src/pipeline/audio-gate.js";
import { alignApproved } from "../src/pipeline/align.js";
import { buildStoryboard, listScenes, editScene } from "../src/pipeline/storyboard.js";
import { HANDLERS } from "../src/handlers.js";
import { enqueue, claimNext, finish } from "../src/jobs.js";
import { refreshCatalog, styleHash } from "../src/catalog/catalog.js";
import { closeBrowser } from "../src/render/renderer.js";
import { ffprobe } from "../src/util.js";
import { createDerivedShort } from "../src/pipeline/shorts.js";

/**
 * Teste de ponta a ponta com motores REAIS locais (Kokoro, faster-whisper, Chromium, FFmpeg).
 * O roteiro é FIXTURE (não vem da API Anthropic). A aprovação do áudio é feita pelo teste,
 * simulando o clique do usuário — no projeto demonstrativo ela é do usuário.
 */
const ctx = (job: any = { id: "t", project_id: null }) => ({ job, payload: {}, progress: () => {}, log: () => {}, signal: new AbortController().signal });
let PID = "";

after(async () => { await closeBrowser(); });

test("e2e: roteiro → narração → aprovação → alinhamento → storyboard → cena → MP4 validado → curtos", { timeout: 1_800_000 }, async () => {
  await refreshCatalog();
  const styleId = "lemo:cel-anime-80s";
  assert.ok(styleHash(styleId), "estilo do catálogo real existe");
  PID = "pe2e" + Date.now().toString(16).slice(-8);
  const settings = ProjectSettings.parse({ premise: "Teste: barraca à meia-noite", targetSeconds: 20, toleranceSeconds: 15, format: "16:9", styleId, visualMode: "codigo" });
  db().prepare("INSERT INTO projects(id,title,kind,settings_json,style_lock_json,status,is_test,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)").run(PID, "teste", "short", JSON.stringify(settings), JSON.stringify({ styleId, hash: styleHash(styleId) }), "rascunho", now(), now());

  const sv = saveScriptVersion(PID, FIXTURE_SCRIPT, "manual", "fixture");
  assert.equal(sv.version, 1);
  assert.equal(sv.hooks.length, 5);
  const segs = splitIntoSegments(PID, 1);
  assert.equal(segs.length, 4);

  // visual bloqueado antes do áudio
  assert.throws(() => enqueue("storyboard", PID, {}), /aprova/);

  // narração completa (Kokoro real) → master v1
  const n1: any = await HANDLERS.narration_full({ ...ctx({ id: "t1", project_id: PID }), payload: { scriptVersion: 1 } } as any);
  assert.equal(n1.version, 1);
  const m1 = latestMaster(PID)!;
  assert.ok(m1.duration > 8 && m1.duration < 40, `duração real ${m1.duration}`);
  assert.equal(m1.sample_rate, 48000);
  assert.equal(approvedMaster(PID), null);

  // aprovação vinculada ao hash
  await approveMaster(PID, m1.id, "teste automatizado (simula o usuário)");
  assert.equal(approvedMaster(PID)!.id, m1.id);

  // alinhamento real
  const al = await alignApproved(PID);
  assert.ok(al.words > 10, `palavras alinhadas: ${al.words}`);
  assert.ok(fs.existsSync(al.srtPath));

  // storyboard com tempos do master
  buildStoryboard(PID);
  const scenes = listScenes(PID);
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].t0, 0);
  assert.ok(Math.abs(scenes[1].t1 - m1.duration) < 1e-9, "última cena termina no fim do master");

  // cena piloto (job pela fila persistente)
  const jb = enqueue("scene_render", PID, { keys: ["s01"] });
  const claimed = claimNext(process.pid)!;
  assert.equal(claimed.id, jb.id);
  const pilot: any = await HANDLERS.scene_render({ ...ctx(claimed), payload: { keys: ["s01"] } } as any);
  finish(claimed.id, "concluído", pilot);
  const pinfo = await ffprobe(pilot[0].path);
  assert.equal(pinfo.streams[0].width, 1920);

  // montagem completa + validação + 5 trechos
  const a: any = await HANDLERS.assemble({ ...ctx({ id: "t2", project_id: PID }), payload: {} } as any);
  assert.ok(a.validation.ok, "MP4 validado: " + JSON.stringify(a.validation.problems));
  assert.equal(a.validation.video.codec, "h264");
  assert.equal(a.validation.audio.codec, "aac");
  assert.ok(Math.abs(a.validation.syncMs ?? 999) < 45, "fala sincronizada com o master");
  assert.ok(a.validation.loudness.stereo.truePeak < -4, "true peak abaixo de −4 dBTP (alvo da skill sound-effects)");
  assert.equal(a.reviewClips.length, 5);
  const dir = path.join(TEST_DIR, "projetos", PID);
  for (const f of ["sons/CUES.json", "sons/CUES.csv", "sons/RELATORIO_SOM.html", "revisao_fone/01_abertura.mp4", "revisao_fone/05_encerramento.mp4"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  for (const c of a.cueCheck) assert.ok(Math.abs(c.deviationMs) < 60, `cue ${c.id} desvio medido ${c.deviationMs} ms`);
  assert.equal(new Set(a.cueCheck.map((c: any) => c.frame)).size, a.cueCheck.length, "cues não se sobrepõem no mesmo quadro");

  // mudança só visual preserva o master e a aprovação
  const before = latestMaster(PID)!.id;
  editScene(PID, "s02", { shots: listScenes(PID)[1].data.shots.map((s: any) => ({ ...s, light: "alerta" })) });
  assert.equal(latestMaster(PID)!.id, before);
  assert.equal(approvedMaster(PID)!.id, before);

  // curto derivado: projeto próprio 9:16 com aprovação própria
  const short = createDerivedShort(PID, { segmentIds: listSegments(PID, 1).slice(2).map((s) => s.id), kind: "trecho com gancho" });
  const sm: any = await buildMaster(short.shortId, 1);
  assert.equal(approvedMaster(short.shortId), null, "curto exige aprovação própria");
  await approveMaster(short.shortId, sm.masterId, "teste");
  await alignApproved(short.shortId);
  buildStoryboard(short.shortId);
  const sa: any = await HANDLERS.short_assemble({ ...ctx({ id: "t3", project_id: short.shortId }), payload: {} } as any);
  assert.ok(sa.validation.ok, JSON.stringify(sa.validation.problems));
  assert.equal(sa.validation.video.w, 1080); assert.equal(sa.validation.video.h, 1920);

  // mudança de texto ⇒ nova versão do master, aprovação perdida, dependentes desatualizados
  const seg = listSegments(PID, 1)[1];
  updateSegment(seg.id, { text: "Lá fora, a fogueira estala. Ninguém responde." });
  await synthSegment(PID, seg.id);
  const m2: any = await buildMaster(PID, 1);
  assert.equal(m2.version, 2);
  assert.equal(approvedMaster(PID), null, "nova versão exige nova aprovação");
  assert.ok(staleReport(PID).scenes.length >= 1, "cenas dependentes sinalizadas");
  assert.throws(() => enqueue("scene_render", PID, { keys: ["s01"] }), /não foi aprovada/);
  assert.ok(fs.existsSync(a.path), "exportação anterior preservada");
});
