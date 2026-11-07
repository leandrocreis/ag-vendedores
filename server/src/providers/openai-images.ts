import OpenAI, { toFile } from "openai";
import fs from "node:fs";
import { getSecret } from "../secrets.js";
import { getConfig, recordCost, setStatus } from "./config.js";
import { UserError } from "../util.js";

/**
 * Imagens via OpenAI Image API (SDK oficial `openai`). Crédito de API é cobrado à parte —
 * assinatura ChatGPT NÃO dá crédito de API. Tamanhos recomendados na documentação consultada:
 * 1024x1024, 1536x1024, 1024x1536 e "auto". A resolução do ARQUIVO gerado é diferente da
 * resolução de EXPORTAÇÃO (1920×1080 / 1080×1920): o motor reenquadra a imagem em camadas.
 */
export const IMAGE_SIZES = ["1536x1024", "1024x1536", "1024x1024", "auto"] as const;
export const IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;

function client() {
  const key = getSecret("openai");
  if (!key) throw new UserError("Chave OpenAI não configurada (Configurações → Integrações).", 412, "Configurar OpenAI");
  return new OpenAI({ apiKey: key, maxRetries: 1 });
}

function explain(e: any) {
  const s = e?.status;
  if (s === 401) return "Chave OpenAI inválida (401).";
  if (s === 403) return "Sem permissão para este modelo/organização (403). Alguns modelos de imagem exigem verificação da organização.";
  if (s === 429) return /quota|billing|insufficient/i.test(e?.message ?? "") ? "Saldo/cota insuficiente na API OpenAI (429)." : "Limite de requisições (429). Tente mais tarde.";
  if (s === 400) return `Pedido recusado pela API (400): ${e?.message}`;
  return String(e?.message ?? e);
}

export async function testOpenAI() {
  const cfg = getConfig("openai");
  try {
    const c = client();
    const m = await c.models.retrieve(cfg.imageModel);
    const st = { ok: true, model: m.id };
    setStatus("openai", st);
    return st;
  } catch (e: any) {
    const st = { ok: false, model: cfg.imageModel, error: e instanceof UserError ? e.message : explain(e) };
    setStatus("openai", st);
    return st;
  }
}

export async function listImageModels() {
  const c = client();
  const out: string[] = [];
  for await (const m of c.models.list()) if (/image/i.test(m.id)) out.push(m.id);
  return out.sort();
}

export function sizeFor(format: "16:9" | "9:16", role: "fundo" | "personagem" | "quadro" | "thumbnail"): string {
  if (role === "personagem") return "1024x1536";
  return format === "9:16" ? "1024x1536" : "1536x1024";
}

/** Estimativa só quando o usuário informou o preço por imagem (dado confiável); senão "indisponível". */
export function estimateImages(n: number) {
  const p = getConfig("openai").pricePerImageUsd;
  return p ? { kind: "estimado" as const, usd: p * n } : { kind: "indisponível" as const, usd: null };
}

export async function generateImage(opts: { prompt: string; size: string; outPath: string; references?: string[]; projectId?: string; jobId?: string }) {
  const cfg = getConfig("openai");
  const c = client();
  try {
    let res: any;
    if (opts.references?.length) {
      const images = await Promise.all(opts.references.slice(0, 8).map((p) => toFile(fs.createReadStream(p), p.split("/").pop())));
      res = await c.images.edit({ model: cfg.imageModel, image: images as any, prompt: opts.prompt, size: opts.size as any, quality: cfg.quality as any } as any);
    } else {
      res = await c.images.generate({ model: cfg.imageModel, prompt: opts.prompt, size: opts.size as any, quality: cfg.quality as any } as any);
    }
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error("Resposta sem imagem (b64_json ausente)");
    fs.writeFileSync(opts.outPath, Buffer.from(b64, "base64"));
    const est = estimateImages(1);
    recordCost({ projectId: opts.projectId, jobId: opts.jobId, provider: "openai", model: cfg.imageModel, kind: est.kind, amountUsd: est.usd, units: { images: 1, size: opts.size, quality: cfg.quality, usage: res.usage ?? null } });
    return { path: opts.outPath, model: cfg.imageModel, size: opts.size, quality: cfg.quality, revisedPrompt: res.data?.[0]?.revised_prompt ?? null };
  } catch (e: any) {
    throw new UserError(e instanceof UserError ? e.message : explain(e), 502);
  }
}
