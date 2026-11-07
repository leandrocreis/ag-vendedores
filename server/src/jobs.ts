import { db, j, now, uid } from "./db.js";
import { VISUAL_JOB_TYPES, requireApprovedAudio, approvedMaster } from "./pipeline/audio-gate.js";
import { redact } from "./secrets.js";
import { UserError } from "./util.js";

export type JobStatus = "em fila" | "produzindo" | "pausado" | "falhou" | "cancelado" | "concluído";

export interface JobRow {
  id: string; project_id: string | null; type: string; status: JobStatus; payload_json: string;
  result_json: string | null; error: string | null; progress: number; progress_label: string | null;
  progress_estimated: number; attempts: number; max_attempts: number; idempotency_key: string | null;
  master_id: string | null; paid: number; cancel_requested: number; worker_pid: number | null;
  heartbeat_at: string | null; created_at: string; started_at: string | null; finished_at: string | null;
}

export interface EnqueueOpts { idempotencyKey?: string; paid?: boolean; maxAttempts?: number }

/** Enfileira um job. Tipos visuais exigem áudio aprovado — verificação do BACKEND. */
export function enqueue(type: string, projectId: string | null, payload: object, opts: EnqueueOpts = {}): JobRow {
  let masterId: string | null = null;
  if (VISUAL_JOB_TYPES.has(type)) {
    if (!projectId) throw new UserError("Job visual sem projeto");
    masterId = requireApprovedAudio(projectId).id;
  }
  const d = db();
  if (opts.idempotencyKey) {
    const ex = d.prepare("SELECT * FROM jobs WHERE idempotency_key=?").get(opts.idempotencyKey) as JobRow | undefined;
    if (ex && !["falhou", "cancelado"].includes(ex.status)) return ex;
    if (ex) d.prepare("UPDATE jobs SET idempotency_key=NULL WHERE id=?").run(ex.id);
  }
  const id = uid("job_");
  d.prepare(`INSERT INTO jobs(id,project_id,type,status,payload_json,idempotency_key,master_id,paid,max_attempts,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, type, "em fila", JSON.stringify(payload), opts.idempotencyKey ?? null, masterId, opts.paid ? 1 : 0, opts.paid ? 1 : (opts.maxAttempts ?? 2), now());
  event(id, "info", `Job ${type} enfileirado`);
  return getJob(id)!;
}

export const getJob = (id: string) => (db().prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow) ?? null;

export function listJobs(filter: { projectId?: string; status?: string; limit?: number } = {}) {
  const w: string[] = [], a: any[] = [];
  if (filter.projectId) { w.push("project_id=?"); a.push(filter.projectId); }
  if (filter.status) { w.push("status=?"); a.push(filter.status); }
  return db().prepare(`SELECT * FROM jobs ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`).all(...a, filter.limit ?? 200) as JobRow[];
}

export function event(jobId: string, level: "info" | "aviso" | "erro", message: string) {
  db().prepare("INSERT INTO job_events(job_id,at,level,message) VALUES(?,?,?,?)").run(jobId, now(), level, redact(message).slice(0, 4000));
}
export const jobEvents = (jobId: string) => db().prepare("SELECT at,level,message FROM job_events WHERE job_id=? ORDER BY id").all(jobId);

/** Reivindica atomicamente o próximo job em fila. */
export function claimNext(pid: number, types?: string[]): JobRow | null {
  const d = db();
  return d.transaction(() => {
    const row = d.prepare(`SELECT id FROM jobs WHERE status='em fila' ${types ? `AND type IN (${types.map(() => "?").join(",")})` : ""} ORDER BY created_at LIMIT 1`).get(...(types ?? [])) as { id: string } | undefined;
    if (!row) return null;
    d.prepare("UPDATE jobs SET status='produzindo', worker_pid=?, started_at=COALESCE(started_at,?), heartbeat_at=?, attempts=attempts+1 WHERE id=? AND status='em fila'").run(pid, now(), now(), row.id);
    return getJob(row.id);
  })();
}

export function heartbeat(id: string) { db().prepare("UPDATE jobs SET heartbeat_at=? WHERE id=?").run(now(), id); }

export function setProgress(id: string, progress: number, label?: string, estimated = false) {
  db().prepare("UPDATE jobs SET progress=?, progress_label=?, progress_estimated=?, heartbeat_at=? WHERE id=?").run(Math.max(0, Math.min(1, progress)), label ?? null, estimated ? 1 : 0, now(), id);
}

export function finish(id: string, status: Exclude<JobStatus, "em fila" | "produzindo">, result?: unknown, error?: string) {
  db().prepare("UPDATE jobs SET status=?, result_json=?, error=?, finished_at=?, progress=CASE WHEN ?='concluído' THEN 1 ELSE progress END WHERE id=?")
    .run(status, result === undefined ? null : JSON.stringify(result), error ? redact(error) : null, now(), status, id);
  event(id, status === "falhou" ? "erro" : "info", `Job ${status}${error ? ": " + error : ""}`);
}

export function requestCancel(id: string) {
  const job = getJob(id);
  if (!job) throw new UserError("Job não encontrado", 404);
  if (job.status === "em fila" || job.status === "pausado") { finish(id, "cancelado"); return getJob(id); }
  if (job.status === "produzindo") db().prepare("UPDATE jobs SET cancel_requested=1 WHERE id=?").run(id);
  return getJob(id);
}

export function retryJob(id: string) {
  const job = getJob(id);
  if (!job) throw new UserError("Job não encontrado", 404);
  if (!["falhou", "cancelado", "pausado"].includes(job.status)) throw new UserError("Só jobs falhos, pausados ou cancelados podem ser retomados");
  // Jobs remotos já enviados são retomados por consulta ao ID remoto (o handler verifica remote_jobs).
  db().prepare("UPDATE jobs SET status='em fila', cancel_requested=0, error=NULL, finished_at=NULL WHERE id=?").run(id);
  event(id, "info", "Retomado pelo usuário");
  return getJob(id);
}

/**
 * Recuperação após reinício: jobs "produzindo" sem batimento há >90 s voltam para a fila
 * (o handler retoma pelo estado salvo — p. ex. frames já renderizados ou ID remoto já criado).
 * Jobs pagos sem ID remoto salvo NÃO são reenviados automaticamente: ficam pausados.
 */
export function recoverStale(maxAgeMs = 90_000) {
  const d = db();
  const rows = d.prepare("SELECT * FROM jobs WHERE status='produzindo'").all() as JobRow[];
  let n = 0;
  for (const r of rows) {
    const age = Date.now() - Date.parse(r.heartbeat_at ?? r.started_at ?? r.created_at);
    if (age < maxAgeMs) continue;
    const remote = d.prepare("SELECT 1 FROM remote_jobs WHERE job_id=?").get(r.id);
    if (r.paid && !remote) {
      d.prepare("UPDATE jobs SET status='pausado', error=? WHERE id=?").run("Interrompido antes de confirmar o envio pago; retome manualmente para evitar cobrança duplicada.", r.id);
    } else {
      d.prepare("UPDATE jobs SET status='em fila' WHERE id=?").run(r.id);
    }
    event(r.id, "aviso", "Recuperado após interrupção do worker");
    n++;
  }
  return n;
}

export function jobPayload<T = any>(job: JobRow): T { return j<T>(job.payload_json, {} as T); }

/** Revalida, no início da execução, que o áudio que originou o job visual ainda é o aprovado. */
export function assertJobStillValid(job: JobRow) {
  if (!VISUAL_JOB_TYPES.has(job.type) || !job.project_id) return;
  const m = approvedMaster(job.project_id);
  if (!m || m.id !== job.master_id) throw new UserError("A narração aprovada mudou depois que este job foi criado; ele foi descartado para não usar tempos antigos.", 409);
}
