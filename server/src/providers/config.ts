import { db, j, now, uid } from "../db.js";

/** Configuração NÃO secreta por provedor. Chaves ficam em secrets.ts. */
export interface ProviderConfigs {
  anthropic: { model: string; effort: "low" | "medium" | "high" | "xhigh" | "max"; allowFallbacks: boolean };
  openai: { imageModel: string; quality: string; pricePerImageUsd?: number };
  voicestudio: { url: string };
  kokoro: { enabled: boolean };
  runpod: { endpointId: string; workerImage: string; gpu: string; maxConcurrency: number; pricePerSecondUsd?: number; timeoutSec: number; storagePolicy: string };
  local_video: { model: string };
  muapi: { enabled: boolean };
  output: { exportDir: string };
  render: { workers: number; maxRamMb: number; jpegQuality: number };
  budget: { projectDefaultUsd: number; pauseAtLimit: boolean };
}

export const DEFAULTS: ProviderConfigs = {
  // Modelo de roteiro: Claude Opus 5.5. Identificador configurável e validado em "Testar conexão".
  anthropic: { model: "claude-opus-5-5", effort: "high", allowFallbacks: false },
  // Sem modelo fixo inventado: o padrão sugerido vem da documentação consultada (GPT Image 2.5 Flare);
  // a tela "Listar modelos" mostra os IDs realmente disponíveis para a sua chave.
  openai: { imageModel: "gpt-image-2.5-flare", quality: "medium" },
  voicestudio: { url: process.env.VOICESTUDIO_URL ?? "http://127.0.0.1:3900" },
  kokoro: { enabled: true },
  runpod: { endpointId: "", workerImage: "", gpu: "", maxConcurrency: 1, timeoutSec: 900, storagePolicy: "resultado em base64 na resposta; nada persiste no worker" },
  local_video: { model: "Wan-AI/Wan2.1-T2V-1.3B-Diffusers" },
  muapi: { enabled: false },
  output: { exportDir: "" },
  render: { workers: 2, maxRamMb: 4096, jpegQuality: 92 },
  budget: { projectDefaultUsd: 5, pauseAtLimit: true },
};

export function getConfig<K extends keyof ProviderConfigs>(k: K): ProviderConfigs[K] {
  const r = db().prepare("SELECT config_json FROM provider_configs WHERE provider=?").get(k) as any;
  return { ...DEFAULTS[k], ...j(r?.config_json, {}) };
}
export function setConfig<K extends keyof ProviderConfigs>(k: K, patch: Partial<ProviderConfigs[K]>) {
  const cur = getConfig(k);
  const next = { ...cur, ...patch };
  db().prepare("INSERT INTO provider_configs(provider,config_json,updated_at) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at").run(k, JSON.stringify(next), now());
  return next;
}
export function setStatus(k: string, status: object) {
  db().prepare("INSERT INTO provider_configs(provider,config_json,status_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET status_json=excluded.status_json, updated_at=excluded.updated_at").run(k, "{}", JSON.stringify({ ...status, at: now() }), now());
}
export function getStatus(k: string) {
  return j((db().prepare("SELECT status_json FROM provider_configs WHERE provider=?").get(k) as any)?.status_json, null);
}

/* ------------------------------- custos -------------------------------- */
export type CostKind = "estimado" | "confirmado" | "indisponível";
export function recordCost(c: { projectId?: string | null; jobId?: string | null; provider: string; model?: string; kind: CostKind; amountUsd?: number | null; units?: object }) {
  db().prepare("INSERT INTO costs(id,project_id,job_id,provider,model,kind,amount_usd,units_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(uid("cost_"), c.projectId ?? null, c.jobId ?? null, c.provider, c.model ?? null, c.kind, c.amountUsd ?? null, JSON.stringify(c.units ?? {}), now());
}
export function costSummary(projectId?: string) {
  const rows = db().prepare(`SELECT provider, kind, COUNT(*) n, SUM(amount_usd) usd FROM costs ${projectId ? "WHERE project_id=?" : ""} GROUP BY provider, kind`).all(...(projectId ? [projectId] : [])) as any[];
  return rows;
}
export function spentUsd(projectId: string) {
  const r = db().prepare("SELECT COALESCE(SUM(amount_usd),0) s FROM costs WHERE project_id=? AND kind IN ('estimado','confirmado')").get(projectId) as any;
  return Number(r.s);
}

/** Preços públicos da Anthropic para o cálculo ESTIMADO a partir do uso medido (USD por milhão de tokens). */
export const ANTHROPIC_PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 }, "claude-sonnet-5-5": { in: 2, out: 10 }, "claude-haiku-5-5": { in: 0.1, out: 0.5 }, "claude-fable-5-1": { in: 10, out: 50 },
};
