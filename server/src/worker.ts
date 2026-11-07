import os from "node:os";
import { claimNext, finish, getJob, heartbeat, setProgress, event, recoverStale, assertJobStillValid, jobPayload } from "./jobs.js";
import { HANDLERS } from "./handlers.js";
import { closeBrowser } from "./render/renderer.js";
import { db } from "./db.js";

/**
 * Worker de produção: processo separado do servidor HTTP. Nenhum vídeo é feito dentro de uma
 * requisição. Fila persistente em SQLite; batimento a cada 5 s; cancelamento real (AbortSignal
 * mata ffmpeg/Python/Chromium e envia cancelamento ao provedor remoto quando suportado).
 * Concorrência configurável (ESE_WORKERS, padrão 1 — render já usa vários núcleos).
 */
const CONC = Math.max(1, Number(process.env.ESE_WORKERS ?? 1));
let stopping = false;

async function runOne(slot: number) {
  const job = claimNext(process.pid);
  if (!job) return false;
  const ctl = new AbortController();
  const hb = setInterval(() => {
    heartbeat(job.id);
    const j = getJob(job.id);
    if (j?.cancel_requested) ctl.abort();
  }, 5000);
  try {
    const h = HANDLERS[job.type];
    if (!h) throw new Error(`Tipo de job desconhecido: ${job.type}`);
    assertJobStillValid(job); // a narração aprovada ainda é a mesma?
    event(job.id, "info", `Iniciado no worker ${process.pid}/${slot}`);
    const result = await h({
      job, payload: jobPayload(job), signal: ctl.signal,
      progress: (p, label, est) => setProgress(job.id, p, label, est),
      log: (s) => event(job.id, "info", s),
    });
    finish(job.id, "concluído", result);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (ctl.signal.aborted || /cancelado/.test(msg)) finish(job.id, "cancelado", undefined, msg);
    else finish(job.id, "falhou", { nextAction: e?.nextAction ?? null, status: e?.status ?? null }, msg);
  } finally {
    clearInterval(hb);
  }
  return true;
}

async function loop(slot: number) {
  while (!stopping) {
    let did = false;
    try { did = await runOne(slot); } catch (e) { console.error(e); }
    if (!did) await new Promise((r) => setTimeout(r, 1000));
  }
}

const n = recoverStale();
if (n) console.log(`[worker] ${n} job(s) recuperado(s) após reinício`);
setInterval(() => recoverStale(), 60_000).unref();
console.log(`[worker] pronto (pid ${process.pid}, ${CONC} slot(s), ${os.cpus().length} CPUs)`);
const loops = Array.from({ length: CONC }, (_, i) => loop(i));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { stopping = true; await closeBrowser(); db().close(); process.exit(0); });
await Promise.all(loops);
