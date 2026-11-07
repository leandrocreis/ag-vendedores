import fs from "node:fs";
import path from "node:path";
import { PYTHON_DIR, venvPython, DATA_DIR } from "../paths.js";
import { getConfig } from "./config.js";
import { getSecret } from "../secrets.js";
import { ffprobe, run, UserError } from "../util.js";

/**
 * Adaptadores de TTS substituíveis. Cada motor declara, controle a controle, se o recurso é
 * NATIVO, TRADUZIDO para instrução textual, PÓS-PROCESSAMENTO nosso, ou INDISPONÍVEL — a interface
 * desabilita o que não existe, com o motivo. Nada de "mudar pitch = novo sotaque".
 */
export type Support = "nativo" | "instrução textual" | "pós-processamento" | "indisponível";
export interface Control { support: Support; note: string }
export type ControlKey = "idioma" | "sotaque" | "velocidade" | "pausas" | "tom" | "energia" | "emoção" | "descrição livre" | "clonagem" | "voz por descrição" | "mistura de vozes" | "pronúncia";

export interface Voice { id: string; name: string; language: string; accent?: string; gender?: string; engine: string; traits: string[]; kind: "preset" | "clone" | "design"; demoNote: string }
export interface SpeakRequest { text: string; voice: string; speed: number; language: string; instruction?: string; blend?: { voice: string; weight: number }[]; emotion?: string }
export interface SpeakResult { path: string; duration: number; sampleRate: number; request: object; engine: string; controlsApplied: Record<string, Support> }

export interface TtsEngine {
  id: string; name: string; local: boolean; license: string; weightsLicense: string;
  status(): Promise<{ state: "disponível" | "precisa instalar" | "precisa configurar" | "incompatível"; detail: string }>;
  voices(): Promise<Voice[]>;
  controls(): Promise<Record<ControlKey, Control>>;
  speak(req: SpeakRequest, out: string): Promise<SpeakResult>;
}

/* ---------------------------------- Kokoro ---------------------------------- */
const KOKORO_DIR = path.join(DATA_DIR, "modelos", "kokoro");
const KOKORO_LANG: Record<string, { lang: string; label: string }> = {
  p: { lang: "pt-br", label: "Português (Brasil)" }, a: { lang: "en-us", label: "Inglês (EUA)" }, b: { lang: "en-gb", label: "Inglês (Reino Unido)" },
  e: { lang: "es", label: "Espanhol" }, f: { lang: "fr-fr", label: "Francês" }, i: { lang: "it", label: "Italiano" }, h: { lang: "hi", label: "Hindi" }, j: { lang: "ja", label: "Japonês" }, z: { lang: "cmn", label: "Chinês (mandarim)" },
};
async function py(script: string, req: object, timeoutMs = 600_000) {
  const python = venvPython();
  if (!python) throw new UserError("Ambiente Python (.venv) ausente. Rode `npm run setup`.", 412, "Instalar dependências");
  const r = await run(python, ["-I", path.join(PYTHON_DIR, script)], { input: JSON.stringify(req), timeoutMs });
  const line = r.stdout.trim().split("\n").pop() ?? "";
  let o: any;
  try { o = JSON.parse(line); } catch { throw new Error(`Saída inválida de ${script}: ${r.stderr.slice(-500)}`); }
  if (!o.ok) throw new Error(o.error ?? "falha");
  return o;
}

export const kokoro: TtsEngine = {
  id: "kokoro", name: "Kokoro (local, CPU)", local: true, license: "kokoro-onnx: MIT", weightsLicense: "Kokoro-82M: Apache-2.0",
  async status() {
    if (!venvPython()) return { state: "precisa instalar", detail: "Rode `npm run setup` para criar o ambiente Python." };
    if (!fs.existsSync(path.join(KOKORO_DIR, "kokoro-v1.0.onnx"))) return { state: "precisa instalar", detail: "Modelo Kokoro (~354 MB) ainda não baixado. `npm run setup -- --voz`." };
    return { state: "disponível", detail: "Roda localmente na CPU; nenhum áudio sai da máquina." };
  },
  async voices() {
    const r = await py("tts_kokoro.py", { op: "voices" });
    return (r.voices as string[]).map((v) => {
      const l = KOKORO_LANG[v[0]] ?? { lang: "?", label: "?" };
      return { id: v, name: v.split("_")[1].replace(/^\w/, (c) => c.toUpperCase()), language: l.lang, accent: l.label, gender: v[1] === "f" ? "feminina" : "masculina", engine: "kokoro", traits: [], kind: "preset", demoNote: "Use “Ouvir com meu texto” para ouvir esta voz com o seu roteiro." } as Voice;
    });
  },
  async controls() {
    return {
      idioma: { support: "nativo", note: "pt-br, en-us, en-gb, es, fr, it, hi, ja, zh — depende da voz." },
      sotaque: { support: "indisponível", note: "Cada voz tem um único sotaque; para PT só há pt-BR (pf_dora, pm_alex, pm_santa)." },
      velocidade: { support: "nativo", note: "Parâmetro speed do modelo (0,5–2,0)." },
      pausas: { support: "pós-processamento", note: "Silêncio inserido entre trechos na montagem do master (amostra exata)." },
      tom: { support: "indisponível", note: "Sem controle de pitch no modelo; não alteramos pitch artificialmente." },
      energia: { support: "indisponível", note: "Sem controle de energia." },
      emoção: { support: "indisponível", note: "Kokoro não recebe instrução de emoção. A emoção fica registrada só como direção de roteiro." },
      "descrição livre": { support: "indisponível", note: "Não aceita instrução textual." },
      clonagem: { support: "indisponível", note: "Kokoro não clona vozes. Use VoiceStudio (OmniVoice) para clonagem autorizada." },
      "voz por descrição": { support: "indisponível", note: "Sem voice design." },
      "mistura de vozes": { support: "nativo", note: "Interpolação real dos vetores de estilo (embeddings) das vozes do próprio modelo." },
      pronúncia: { support: "pós-processamento", note: "Dicionário de pronúncia substitui o texto falado antes da síntese." },
    };
  },
  async speak(req, out) {
    const r = await py("tts_kokoro.py", { op: "speak", text: req.text, voice: req.blend?.length ? null : req.voice, blend: req.blend ?? null, speed: req.speed, lang: req.language, out });
    return { path: out, duration: r.duration, sampleRate: r.sample_rate, request: { ...req, engine: "kokoro" }, engine: "kokoro", controlsApplied: { velocidade: "nativo", ...(req.blend?.length ? { "mistura de vozes": "nativo" } : {}) } };
  },
};

/* -------------------------------- VoiceStudio -------------------------------- */
async function vs(pathname: string, init: RequestInit = {}, timeoutMs = 15000) {
  const base = getConfig("voicestudio").url.replace(/\/$/, "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)) {
    // remoto exige chave OMNIVOICE_API_KEY (documentado em docs/api-auth.md do VoiceStudio)
    if (!getSecret("voicestudio")) throw new UserError("VoiceStudio remoto exige a chave OMNIVOICE_API_KEY.", 412);
  }
  const headers: Record<string, string> = { ...(init.headers as any) };
  const key = getSecret("voicestudio");
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(base + pathname, { ...init, headers, signal: ctl.signal });
  } finally { clearTimeout(t); }
}

export const voicestudio: TtsEngine & { clone(o: { name: string; file: string; refText: string; language: string }): Promise<any>; design(o: { name: string; instruct: string; language: string }): Promise<any>; engines(): Promise<any> } = {
  id: "voicestudio", name: "VoiceStudio (API local)", local: true, license: "VoiceStudio: AGPL-3.0-only (adaptador HTTP separado; ver docs/LICENCAS.md)", weightsLicense: "Depende do motor: OmniVoice padrão = pesos CC-BY-NC (uso não comercial); confira cada motor",
  async status() {
    try {
      const r = await vs("/v1/models", {}, 3000);
      if (!r.ok) return { state: "precisa configurar", detail: `VoiceStudio respondeu HTTP ${r.status}.` };
      return { state: "disponível", detail: "Conectado à API local OpenAI-compatível do VoiceStudio." };
    } catch {
      return { state: "precisa instalar", detail: `VoiceStudio não respondeu em ${getConfig("voicestudio").url}. Instale/abra o VoiceStudio (https://github.com/debpalash/VoiceStudio).` };
    }
  },
  async engines() {
    const r = await vs("/engines/tts");
    return r.ok ? r.json() : null;
  },
  async voices() {
    const r = await vs("/v1/audio/voices");
    if (!r.ok) throw new UserError(`VoiceStudio: HTTP ${r.status}`, 502);
    const o: any = await r.json();
    const list = Array.isArray(o) ? o : o.voices ?? o.data ?? [];
    return list.map((v: any) => ({ id: v.voice_id ?? v.id, name: v.name ?? v.id, language: v.language ?? "auto", engine: "voicestudio", traits: [], kind: v.kind === "design" ? "design" : v.kind === "clone" ? "clone" : "preset", demoNote: "Amostras sempre geradas com o seu texto." }));
  },
  async controls() {
    // Capacidades verificadas no código/documentação do VoiceStudio consultados; o motor ativo pode restringir.
    return {
      idioma: { support: "nativo", note: "Conforme o motor ativo (OmniVoice declara muitos idiomas)." },
      sotaque: { support: "instrução textual", note: "Só via design/instrução quando o motor aceitar; não há garantia de sotaque." },
      velocidade: { support: "nativo", note: "Campo speed de /v1/audio/speech." },
      pausas: { support: "pós-processamento", note: "Silêncio inserido entre trechos." },
      tom: { support: "instrução textual", note: "Tags de voice design (ex.: 'low pitch') quando o motor suportar." },
      energia: { support: "instrução textual", note: "Via instruções de estilo." },
      emoção: { support: "instrução textual", note: "Campo instructions → instrução do motor. O OmniVoice mantém apenas tags de voice design e ignora prosa livre (docs/agentic-voice.md)." },
      "descrição livre": { support: "instrução textual", note: "Vira instrução de estilo; motores que não aceitam ignoram." },
      clonagem: { support: "nativo", note: "POST /profiles (kind=clone) com referência autorizada." },
      "voz por descrição": { support: "nativo", note: "POST /profiles (kind=design) — voice design do OmniVoice." },
      "mistura de vozes": { support: "indisponível", note: "Não há interpolação de identidades exposta na API consultada; usamos tradução para instrução textual." },
      pronúncia: { support: "nativo", note: "VoiceStudio tem dicionário próprio (/pronunciation); também aplicamos o nosso antes do envio." },
    };
  },
  async speak(req, out) {
    const r = await vs("/v1/audio/speech", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tts-1-hd", voice: req.voice, input: req.text, speed: req.speed, instructions: req.instruction ?? undefined, response_format: "wav" }),
    }, 600_000);
    if (!r.ok) throw new UserError(`VoiceStudio falhou (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`, 502);
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    const info = await ffprobe(out);
    const sr = Number(info.streams[0]?.sample_rate ?? 24000);
    return { path: out, duration: info.duration, sampleRate: sr, request: { ...req, engine: "voicestudio" }, engine: "voicestudio", controlsApplied: { velocidade: "nativo", ...(req.instruction ? { "descrição livre": "instrução textual" } : {}) } };
  },
  async clone(o) {
    const fd = new FormData();
    fd.set("name", o.name); fd.set("kind", "clone"); fd.set("ref_text", o.refText); fd.set("language", o.language);
    fd.set("ref_audio", new Blob([fs.readFileSync(o.file)]), path.basename(o.file));
    const r = await vs("/profiles", { method: "POST", body: fd }, 120_000);
    if (!r.ok) throw new UserError(`VoiceStudio recusou a clonagem (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`, 502);
    return r.json();
  },
  async design(o) {
    const fd = new FormData();
    fd.set("name", o.name); fd.set("kind", "design"); fd.set("instruct", o.instruct); fd.set("language", o.language); fd.set("vd_states", "{}");
    const r = await vs("/profiles", { method: "POST", body: fd }, 120_000);
    if (!r.ok) throw new UserError(`VoiceStudio recusou o voice design (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`, 502);
    return r.json();
  },
};

export const ENGINES: Record<string, TtsEngine> = { kokoro, voicestudio };
export function engine(id: string) {
  const e = ENGINES[id];
  if (!e) throw new UserError(`Motor de voz desconhecido: ${id}`);
  return e;
}

/* ----------------------- Receitas de combinação vocal ----------------------- */
export interface RecipePart { label: string; weight: number; voice?: string; descriptor?: string }
/**
 * Traduz a receita editorial (ex.: 60% narrador grave, 25% calma, 15% suspense) para o motor.
 * - Kokoro + partes com `voice`: mistura real de embeddings (pesos normalizados).
 * - Partes só descritivas: viram instrução textual (motores que aceitam) — o modo é informado.
 * - Nunca somamos dois áudios nem mexemos só no pitch chamando de "nova voz".
 */
export async function translateRecipe(engineId: string, parts: RecipePart[]) {
  const ctrl = await engine(engineId).controls();
  const total = parts.reduce((s, p) => s + Math.max(0, p.weight), 0) || 1;
  const voiceParts = parts.filter((p) => p.voice);
  const descParts = parts.filter((p) => !p.voice && p.descriptor);
  const out: { mode: string[]; blend?: { voice: string; weight: number }[]; instruction?: string; unsupported: string[] } = { mode: [], unsupported: [] };
  if (voiceParts.length) {
    if (ctrl["mistura de vozes"].support === "nativo") {
      out.blend = voiceParts.map((p) => ({ voice: p.voice!, weight: p.weight / total }));
      out.mode.push("mistura real de embeddings");
    } else out.unsupported.push(`Mistura de identidades não suportada por ${engineId}: ${ctrl["mistura de vozes"].note} Motor compatível: Kokoro (vozes do próprio modelo).`);
  }
  if (descParts.length) {
    const text = descParts.sort((a, b) => b.weight - a.weight).map((p) => `${p.descriptor} (${Math.round((p.weight / total) * 100)}%)`).join(", ");
    if (ctrl["descrição livre"].support !== "indisponível") { out.instruction = `Interpretação: ${text}.`; out.mode.push("tradução para instrução textual"); }
    else out.unsupported.push(`${engineId} não aceita instruções de estilo; as partes descritivas (${text}) ficam só como direção registrada.`);
  }
  return out;
}

/** Aplica o dicionário de pronúncia ao texto FALADO (o texto das legendas não muda). */
export function applyPronunciation(text: string, dict: { term: string; say: string }[]) {
  let t = text;
  for (const d of dict) t = t.replace(new RegExp(`\\b${d.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), d.say);
  return t;
}
