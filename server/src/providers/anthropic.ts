import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { getSecret } from "../secrets.js";
import { getConfig, recordCost, setStatus, ANTHROPIC_PRICES } from "./config.js";
import { UserError } from "../util.js";

/**
 * Caminho A — automação integrada por API, com a chave Anthropic do próprio usuário.
 * O backend faz as chamadas; a chave nunca vai ao frontend. O modelo é configurável e
 * NUNCA é trocado silenciosamente: se indisponível, a geração para com erro explicativo.
 * (Fallbacks de recusa do servidor ficam DESLIGADOS por padrão porque substituem o modelo;
 * podem ser ligados explicitamente e o modelo que respondeu é sempre registrado.)
 */
function client() {
  const key = getSecret("anthropic");
  if (!key) throw new UserError("Chave Anthropic não configurada. Use Configurações → Integrações, ou o caminho “Preparar projeto para Claude Code”.", 412, "Configurar Anthropic");
  return new Anthropic({ apiKey: key, maxRetries: 1 });
}

export async function testAnthropic() {
  const cfg = getConfig("anthropic");
  try {
    const c = client();
    const m = await c.models.retrieve(cfg.model);
    const st = { ok: true, model: m.id, displayName: m.display_name, maxInput: (m as any).max_input_tokens ?? null, maxOutput: (m as any).max_tokens ?? null };
    setStatus("anthropic", st);
    return st;
  } catch (e: any) {
    const st = { ok: false, model: cfg.model, error: explain(e) };
    setStatus("anthropic", st);
    return st;
  }
}

export async function listAnthropicModels() {
  const c = client();
  const out: { id: string; name: string }[] = [];
  for await (const m of c.models.list()) out.push({ id: m.id, name: m.display_name });
  return out;
}

function explain(e: any): string {
  if (e instanceof UserError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "Chave Anthropic inválida (401).";
  if (e instanceof Anthropic.PermissionDeniedError) return "Sem permissão para este modelo ou recurso (403).";
  if (e instanceof Anthropic.NotFoundError) return `Modelo não encontrado para esta chave (404). Escolha outro modelo explicitamente em Configurações.`;
  if (e instanceof Anthropic.RateLimitError) return "Limite de requisições atingido (429). Tente mais tarde.";
  if (e instanceof Anthropic.APIError) return `Erro da API Anthropic ${e.status}: ${e.message}`;
  return String(e?.message ?? e);
}

export interface StructuredResult<T> { data: T; model: string; usage: { input: number; output: number }; costUsd: number | null; stopReason: string | null }

/** Chamada estruturada com validação zod; JSON inválido gera um pedido de correção antes de prosseguir. */
export async function structured<S extends z.ZodType>(opts: { system: string; user: string; schema: S; projectId?: string; jobId?: string; maxTokens?: number }): Promise<StructuredResult<z.infer<S>>> {
  const cfg = getConfig("anthropic");
  const c = client();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.user }];
  let totalIn = 0, totalOut = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp: any;
    try {
      const body: any = {
        model: cfg.model, max_tokens: opts.maxTokens ?? 16000, system: opts.system, messages,
        thinking: { type: "adaptive" }, output_config: { effort: cfg.effort, format: zodOutputFormat(opts.schema) },
      };
      resp = cfg.allowFallbacks
        ? await c.beta.messages.parse({ ...body, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as any)
        : await c.messages.parse(body);
    } catch (e) {
      throw new UserError(explain(e), 502);
    }
    totalIn += resp.usage?.input_tokens ?? 0;
    totalOut += resp.usage?.output_tokens ?? 0;
    if (resp.stop_reason === "refusal") throw new UserError(`O modelo recusou a solicitação (${resp.stop_details?.category ?? "sem categoria"}). Revise a premissa ou o nível de violência.`, 422);
    if (resp.model !== cfg.model) {
      // registro explícito — nunca escondemos qual modelo respondeu
      console.warn(`[anthropic] resposta servida por ${resp.model} (configurado: ${cfg.model})`);
    }
    const parsed = resp.parsed_output;
    const check = parsed ? opts.schema.safeParse(parsed) : { success: false, error: "sem JSON" };
    if (check.success) {
      const price = ANTHROPIC_PRICES[resp.model];
      const costUsd = price ? (totalIn * price.in + totalOut * price.out) / 1e6 : null;
      recordCost({ projectId: opts.projectId, jobId: opts.jobId, provider: "anthropic", model: resp.model, kind: costUsd == null ? "indisponível" : "estimado", amountUsd: costUsd, units: { input_tokens: totalIn, output_tokens: totalOut } });
      return { data: (check as any).data, model: resp.model, usage: { input: totalIn, output: totalOut }, costUsd, stopReason: resp.stop_reason };
    }
    // pede correção do JSON
    messages.push({ role: "assistant", content: resp.content.filter((b: any) => b.type === "text") });
    messages.push({ role: "user", content: `O JSON não passou na validação: ${String((check as any).error).slice(0, 1500)}. Devolva o objeto completo corrigido.` });
  }
  throw new UserError("A resposta do modelo não passou na validação de schema após uma tentativa de correção.", 502);
}
