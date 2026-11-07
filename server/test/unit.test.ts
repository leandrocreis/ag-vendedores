import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, now } from "../src/db.js";
import { ScriptDoc, ProjectSettings } from "../src/contracts.js";
import { FIXTURE_SCRIPT } from "./fixtures.js";
import { hookScore, titleLint, chapters, retention, deadAir } from "../src/editorial/yt-tools.js";
import { buildDescription, YT_DESC_LIMIT } from "../src/editorial/skills.js";
import { enqueue, claimNext, finish, recoverStale, getJob } from "../src/jobs.js";
import { setSecret, getSecret, redact } from "../src/secrets.js";
import { buildApp } from "../src/app.js";
import { commitIfCurrent, approvedMaster } from "../src/pipeline/audio-gate.js";
import { safeJoin } from "../src/paths.js";
import { planShots } from "../src/pipeline/storyboard.js";
import { translateRecipe } from "../src/providers/tts.js";
import { wordTarget } from "../src/pipeline/script.js";

function mkProject(id = "ptest" + Math.random().toString(16).slice(2, 8)) {
  const s = ProjectSettings.parse({ premise: "teste de unidade", targetSeconds: 30, format: "16:9" });
  db().prepare("INSERT INTO projects(id,title,kind,settings_json,style_lock_json,status,is_test,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)").run(id, "t", "short", JSON.stringify(s), "{}", "rascunho", now(), now());
  return id;
}

test("contrato do roteiro: fixture válida e campos obrigatórios", () => {
  assert.ok(ScriptDoc.safeParse(FIXTURE_SCRIPT).success);
  assert.equal(ScriptDoc.safeParse({ ...FIXTURE_SCRIPT, hookOptions: FIXTURE_SCRIPT.hookOptions.slice(0, 3) }).success, false, "exige cinco ganchos");
});

test("meta de palavras deriva da velocidade da voz", () => {
  assert.equal(wordTarget(420, 150), Math.round(420 * 0.92 * 150 / 60));
});

test("backend bloqueia jobs visuais sem áudio aprovado (com próxima ação)", () => {
  const id = mkProject();
  for (const t of ["storyboard", "image", "scene_render", "ai_scene", "assemble", "thumbnail"]) {
    assert.throws(() => enqueue(t, id, {}), (e: any) => e.status === 409 && e.nextAction === "Gerar e aprovar narração");
  }
  assert.ok(enqueue("catalog_refresh", null, {}).id, "jobs não visuais seguem permitidos");
});

test("transição atômica rejeita resultado de master antigo", () => {
  const id = mkProject();
  const r = commitIfCurrent(id, "mst_inexistente", () => 1);
  assert.equal(r.committed, false);
  assert.equal(approvedMaster(id), null);
});

test("fila persistente: idempotência, recuperação e pausa de job pago sem ID remoto", () => {
  const a = enqueue("catalog_refresh", null, {}, { idempotencyKey: "k1" });
  const b = enqueue("catalog_refresh", null, {}, { idempotencyKey: "k1" });
  assert.equal(a.id, b.id, "não duplica");
  db().prepare("UPDATE jobs SET status='concluído' WHERE status='em fila'").run();
  const paid = enqueue("catalog_refresh", null, {}, { paid: true });
  const c = claimNext(999)!;
  assert.equal(c.id, paid.id);
  db().prepare("UPDATE jobs SET heartbeat_at='2000-01-01T00:00:00Z' WHERE id=?").run(c.id);
  recoverStale(1000);
  assert.equal(getJob(c.id)!.status, "pausado", "pago sem ID remoto não é reenviado sozinho");
  finish(c.id, "cancelado");
});

test("segredos não aparecem na API nem em logs", async () => {
  setSecret("openai", "sk-teste-1234567890abcdefghij");
  assert.equal(getSecret("openai"), "sk-teste-1234567890abcdefghij");
  assert.ok(!redact("erro com sk-teste-1234567890abcdefghij").includes("1234567890abcdefghij"));
  const app = await buildApp({ port: 4999 });
  const r = await app.inject({ method: "GET", url: "/api/config", headers: { host: "127.0.0.1:4999" } });
  assert.equal(r.statusCode, 200);
  assert.ok(!r.body.includes("1234567890abcdefghij"), "chave nunca vai ao frontend");
  assert.ok(r.body.includes("sk-••••ghij"));
  const csrf = await app.inject({ method: "PUT", url: "/api/segredos/openai", headers: { host: "127.0.0.1:4999" }, payload: { value: "x" } });
  assert.equal(csrf.statusCode, 403, "escrita sem cabeçalho x-ese é recusada");
  const evil = await app.inject({ method: "GET", url: "/api/health", headers: { host: "evil.example:4999" } });
  assert.equal(evil.statusCode, 403, "host externo recusado");
  const origin = await app.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1:4999", origin: "https://evil.example" } });
  assert.equal(origin.statusCode, 403);
  await app.close();
});

test("caminhos ficam dentro da pasta autorizada", () => {
  assert.throws(() => safeJoin("/tmp/a", "../b"));
  assert.ok(safeJoin("/tmp/a", "x/y").startsWith("/tmp/a/"));
});

test("hookscore portado reconhece português e penaliza saudação", () => {
  const good = hookScore("Você acorda às 3 da manhã e alguém está abrindo o zíper da sua barraca.");
  const bad = hookScore("Olá pessoal, bem-vindos ao canal, hoje o vídeo é muito incrível.");
  assert.ok(good.verdict > bad.verdict);
});

test("título: limites e duplicação com thumbnail", () => {
  const r = titleLint("E se um apocalipse zumbi começasse enquanto você acampava?", "ZÍPER ABERTO");
  assert.ok(r.chars <= 100);
  assert.ok(titleLint("Zumbi zumbi", "zumbi").issues.some(([k]) => k === "duplicado"));
});

test("descrição YouTube respeita 5.000 caracteres e nunca corta os créditos", () => {
  const credits = "Créditos obrigatórios: \"Som\" por Autor — CC BY 4.0 — https://exemplo.org";
  const d = buildDescription({ summary: "x ".repeat(4000), credits, chapters: "0:00 Início\n0:30 Meio\n1:10 Fim", hashtags: ["zumbi", "eSe"] });
  assert.ok(d.chars <= YT_DESC_LIMIT && d.margin >= 100);
  assert.ok(d.text.endsWith(credits));
  assert.ok(d.truncatedSummary);
});

test("capítulos seguem as regras (0:00, ≥3, ≥10 s)", () => {
  const cues = Array.from({ length: 40 }, (_, i) => ({ t0: i * 5, t1: i * 5 + 4.5, text: i < 13 ? "barraca fogueira noite" : i < 26 ? "estrada carro motorista" : "cabana porta janela" }));
  const r = chapters(cues, 5);
  assert.ok(r.valid);
  assert.equal(r.chapters[0].start, 0);
});

test("retenção: lê CSV real e distingue evidência de hipótese", () => {
  const csv = "Posição,Retenção\n" + Array.from({ length: 20 }, (_, i) => `${i * 5},${100 - i * 2 - (i === 6 ? 10 : 0)}`).join("\n");
  const r: any = retention(Array.from(csv.split("\n").slice(1), (l) => l.split(",").map(Number) as [number, number]), 100);
  assert.ok(r.cliffs.length > 0 && r.evidenceNote);
});

test("edição (deadair) preserva pausas dramáticas registradas no master", () => {
  const r = deadAir([{ t0: 0, t1: 2, text: "a" }, { t0: 3.2, t1: 5, text: "b" }, { t0: 5.1, t1: 6, text: "é" }], 0.35, [{ t0: 2, t1: 3.2 }]);
  assert.equal(r.items.find((i: any) => i.t0 === 2).kind, "PAUSA INTENCIONAL");
});

test("planos cortam em fronteiras reais de frase e cobrem a cena inteira", () => {
  const sh = planShots("corre pela estrada", undefined, 10, 31, [10, 14, 22.5, 27], ["voce"], false);
  assert.equal(sh[0].t0, 10); assert.equal(sh[sh.length - 1].t1, 31);
  for (let i = 1; i < sh.length; i++) assert.equal(sh[i].t0, sh[i - 1].t1);
  assert.ok(sh.every((s) => s.t1 - s.t0 <= 8.0001));
});

test("receita vocal: Kokoro mistura embeddings; partes descritivas não viram 'nova voz' falsa", async () => {
  const r = await translateRecipe("kokoro", [{ label: "narrador grave", weight: 60, voice: "pm_alex" }, { label: "calma", weight: 25, voice: "pm_santa" }, { label: "suspense", weight: 15, descriptor: "suspense" }]);
  assert.deepEqual(r.mode, ["mistura real de embeddings"]);
  assert.ok(Math.abs(r.blend!.reduce((s, b) => s + b.weight, 0) - 0.85) < 1e-9);
  assert.ok(r.unsupported.some((u) => u.includes("não aceita instruções")));
});
