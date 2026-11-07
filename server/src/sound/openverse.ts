import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, SOUNDS_DIR } from "../paths.js";
import { decodePcm, ffprobe, sha256, sha256File, writeJson } from "../util.js";

/**
 * Busca e download via API OFICIAL do Openverse (https://api.openverse.org/v1/audio/).
 * Parâmetros conferidos no schema OpenAPI publicado (/v1/schema/): q, license, category, length,
 * page, page_size, filter_dead. Uso anônimo (sem OAuth), com timeout, cache e retentativas limitadas,
 * respeitando Retry-After. Licenças aceitas neste fluxo: CC0 e CC BY (BY-SA, NC e ND excluídas).
 */
const API = "https://api.openverse.org/v1/audio/";
const UA = "E-Se-Studio/0.1 (aplicativo local; +https://github.com/leandrocreis/ag-vendedores)";
export const ACCEPTED = new Set(["cc0", "by"]);

async function fetchRetry(url: string, init: RequestInit = {}, tries = 3): Promise<Response> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers as any) }, signal: ctl.signal });
      if (r.status === 429 || r.status >= 500) {
        const ra = Number(r.headers.get("retry-after"));
        last = new Error(`HTTP ${r.status}`);
        if (r.status === 429 && i === tries - 1) throw Object.assign(new Error("Openverse: limite de requisições (429)"), { status: 429, retryAfter: ra || null });
        await new Promise((res) => setTimeout(res, Math.min(30, Number.isFinite(ra) && ra > 0 ? ra : 2 ** i) * 1000));
        continue;
      }
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`Openverse recusou o acesso (HTTP ${r.status}). Configure credenciais OAuth do Openverse ou importe os arquivos manualmente.`), { status: r.status });
      return r;
    } catch (e: any) {
      if (e?.status) throw e;
      last = e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
    } finally { clearTimeout(t); }
  }
  throw last;
}

export interface OvItem { id: string; title: string; creator: string | null; creator_url: string | null; license: string; license_version: string; license_url: string; provider: string; source: string; foreign_landing_url: string; url: string; filetype: string | null; duration: number | null; attribution: string | null; [k: string]: any }

export async function search(q: string, page = 1): Promise<{ count: number; results: OvItem[] }> {
  const key = sha256(`${q}|${page}`).slice(0, 16);
  const cache = path.join(CACHE_DIR, "openverse", `${key}.json`);
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < 86400_000) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const u = new URL(API);
  u.searchParams.set("q", q); u.searchParams.set("license", "cc0,by"); // category=sound_effect não é usado: em 2026-11-07 ele zerava resultados de "whoosh" (itens do Freesound sem categoria).
  u.searchParams.set("length", "shortest,short"); u.searchParams.set("page_size", "20"); u.searchParams.set("page", String(page));
  const r = await fetchRetry(u.toString());
  if (!r.ok) throw new Error(`Openverse HTTP ${r.status}`);
  const o: any = await r.json();
  const out = { count: o.result_count, results: o.results as OvItem[] };
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(out));
  return out;
}

export async function detail(id: string): Promise<OvItem> {
  const r = await fetchRetry(`${API}${encodeURIComponent(id)}/`);
  if (!r.ok) throw new Error(`Openverse detalhe HTTP ${r.status}`);
  return r.json() as any;
}

/* ------------------------------ análise local ------------------------------ */
export interface SoundFeatures { duration: number; decodes: boolean; peakTime: number; onsetTime: number; attackMs: number; peakDb: number; lowRatio: number; peakPosition: number; rmsDb: number; tailMs: number }
/** Mede pontos de sincronismo reais no arquivo: início (onset), pico e cauda. 48 kHz mono. */
export async function analyzeSound(file: string): Promise<SoundFeatures> {
  const SR = 48000;
  const x = await decodePcm(file, SR, 1);
  if (!x.length) throw new Error("arquivo sem áudio");
  const win = 480; // 10 ms
  const env: number[] = [];
  for (let i = 0; i + win <= x.length; i += win) { let s = 0; for (let k = i; k < i + win; k++) s += x[k] * x[k]; env.push(Math.sqrt(s / win)); }
  const pk = Math.max(...env);
  const pi = env.indexOf(pk);
  const onsetIdx = env.findIndex((e) => e > pk * 0.1);
  let lastIdx = env.length - 1; while (lastIdx > pi && env[lastIdx] < pk * 0.03) lastIdx--;
  // razão de energia grave (<250 Hz) com passa-baixa de 1 polo
  const a = Math.exp((-2 * Math.PI * 250) / SR);
  let y = 0, lo = 0, tot = 0, peakAbs = 0, rms = 0;
  for (const v of x) { y = (1 - a) * v + a * y; lo += y * y; tot += v * v; const av = Math.abs(v); if (av > peakAbs) peakAbs = av; }
  rms = Math.sqrt(tot / x.length);
  const db = (v: number) => 20 * Math.log10(Math.max(1e-9, v));
  return {
    duration: x.length / SR, decodes: true, peakTime: (pi + 0.5) * win / SR, onsetTime: Math.max(0, onsetIdx) * win / SR,
    attackMs: ((pi - Math.max(0, onsetIdx)) * win * 1000) / SR, peakDb: db(peakAbs), lowRatio: tot ? lo / tot : 0,
    peakPosition: env.length > 1 ? pi / (env.length - 1) : 0, rmsDb: db(rms), tailMs: ((lastIdx - pi) * win * 1000) / SR,
  };
}

/* ----------------------- seleção dos três whooshes ----------------------- */
export const ROLES = [
  { key: "passagem", label: "Passagem rápida com ataque definido", file: "whoosh_01_passagem_rapida", fit: (f: SoundFeatures) => f.duration <= 2.2 && f.attackMs <= 260 ? 1 / (0.3 + f.duration) + (f.attackMs < 120 ? 0.5 : 0) : -1 },
  { key: "pesada", label: "Transição grave/pesada", file: "whoosh_02_transicao_pesada", fit: (f: SoundFeatures) => f.duration >= 0.6 && f.duration <= 6 ? f.lowRatio * 3 + Math.min(1, f.duration / 2) : -1 },
  { key: "revelacao", label: "Movimento crescente para revelação", file: "whoosh_03_crescente_revelacao", fit: (f: SoundFeatures) => f.duration >= 1 && f.duration <= 8 && f.peakPosition >= 0.45 ? f.peakPosition * 2 + Math.min(1, f.duration / 3) : -1 },
] as const;

const QUERIES = ["whoosh", "cinematic whoosh", "heavy whoosh", "transition swoosh"];

export interface Candidate { item: OvItem; file: string; features?: SoundFeatures; error?: string; query: string }

export async function fetchWhooshes(log: (s: string) => void = console.log) {
  const candDir = path.join(SOUNDS_DIR, "candidatos");
  fs.mkdirSync(candDir, { recursive: true });
  const seen = new Set<string>();
  const cands: Candidate[] = [];
  for (const q of QUERIES) {
    const r = await search(q);
    log(`Openverse "${q}": ${r.count} resultados; avaliando ${r.results.length}`);
    for (const it of r.results) {
      if (seen.has(it.id)) continue; seen.add(it.id);
      if (!ACCEPTED.has(it.license)) continue; // CC0/BY apenas
      if (!it.url || !it.foreign_landing_url) continue;
      if ((it.duration ?? 0) > 9000) continue;
      const ext = (it.filetype || path.extname(new URL(it.url).pathname).slice(1) || "bin").toLowerCase();
      const file = path.join(candDir, `${it.id}.${ext}`);
      try {
        if (!fs.existsSync(file)) {
          const res = await fetchRetry(it.url, {}, 2);
          if (!res.ok) throw new Error(`download HTTP ${res.status}`);
          fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        }
        cands.push({ item: it, file, query: q, features: await analyzeSound(file) });
      } catch (e: any) {
        cands.push({ item: it, file, query: q, error: String(e.message ?? e) });
      }
      if (cands.filter((c) => c.features).length >= 36) break;
    }
  }
  // Adequação ao projeto (suspense): exclui sons cômicos; penaliza arquivo que decodifica acima de 0 dBFS (clipping na prévia).
  const COMIC = /cartoon|comic|funny|toy|silly|goofy|laser|8.?bit|retro game/i;
  const usable = cands.filter((c) => c.features && c.features.duration > 0.15 && !COMIC.test(`${c.item.title} ${(c.item.tags ?? []).map((t: any) => t.name).join(" ")}`));
  const chosen: { role: typeof ROLES[number]; c: Candidate; score: number }[] = [];
  const used = new Set<string>();
  for (const role of ROLES) {
    const ranked = usable.filter((c) => !used.has(c.item.id) && !chosen.some((x) => x.c.item.creator === c.item.creator && x.c.item.title === c.item.title))
      .map((c) => ({ c, score: role.fit(c.features!) - (c.features!.peakDb > 0 ? 1.5 : 0) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    if (ranked[0]) { chosen.push({ role, ...ranked[0] }); used.add(ranked[0].c.item.id); }
  }
  return { candidates: cands, chosen };
}

/** Grava os três escolhidos em sons/, CREDITOS.txt (UTF-8) e openverse_manifest.json. */
export async function writeKit(chosen: Awaited<ReturnType<typeof fetchWhooshes>>["chosen"]) {
  fs.mkdirSync(path.join(SOUNDS_DIR, "processados"), { recursive: true });
  const verified = new Date().toISOString().slice(0, 10);
  const manifest: any[] = [];
  const entries: string[] = [];
  for (const { role, c, score } of chosen) {
    const det = await detail(c.item.id); // revalida licença/fonte no registro atual
    if (!ACCEPTED.has(det.license)) throw new Error(`Licença mudou para ${det.license} em ${det.id}`);
    const ext = path.extname(c.file);
    const local = `${role.file}${ext}`;
    fs.copyFileSync(c.file, path.join(SOUNDS_DIR, local));
    const isPreview = /\/previews\//.test(det.url) || /-hq\.mp3$|-lq\.mp3$/.test(det.url);
    const lic = det.license === "cc0" ? `CC0 ${det.license_version}` : `CC BY ${det.license_version}`;
    const attribution = det.license === "cc0" ? `"${det.title}" por ${det.creator ?? "autor não informado"} (${det.provider}) — CC0 ${det.license_version} (atribuição não exigida; crédito voluntário).`
      : `"${det.title}" por ${det.creator ?? "autor não informado"} — ${det.foreign_landing_url} — licenciado sob CC BY ${det.license_version} (${det.license_url}). Sem alterações no arquivo original.`;
    entries.push([
      `Arquivo local: ${local}`,
      `Função: ${role.label}`,
      `Título original: ${det.title}`,
      `Autor: ${det.creator ?? "(não informado na fonte)"}`,
      `Link do autor: ${det.creator_url ?? "(não informado)"}`,
      `Provedor: ${det.provider} (fonte: ${det.source})`,
      `ID Openverse: ${det.id}`,
      `Página Openverse: https://openverse.org/audio/${det.id}`,
      `Link permanente da fonte: ${det.foreign_landing_url}`,
      `URL de download: ${det.url}`,
      `Qualidade do arquivo: ${isPreview ? "PRÉVIA disponibilizada pelo provedor (MP3 HQ do Freesound), não o original sem perdas; o original exige conta no Freesound" : "arquivo indicado pela fonte"}`,
      `Licença: ${lic}`,
      `Link da licença: ${det.license_url}`,
      `Data de verificação: ${verified} (registro Openverse consultado; confira também a página da fonte antes de publicar)`,
      `Alterações: nenhuma no arquivo em sons/ (original preservado). Versões tratadas, se houver, ficam em sons/processados/ com vínculo a este arquivo.`,
      `Medições locais: duração ${c.features!.duration.toFixed(2)} s, ataque ${c.features!.attackMs.toFixed(0)} ms, pico em ${c.features!.peakTime.toFixed(3)} s (${c.features!.peakDb.toFixed(1)} dBFS), energia grave ${(c.features!.lowRatio * 100).toFixed(0)}%`,
      `Atribuição pronta: ${attribution}`,
      `Observação: o catálogo não garante ausência de reivindicações de terceiros.`,
    ].join("\n"));
    manifest.push({ local, role: role.key, roleLabel: role.label, selectionScore: score, sha256: await sha256File(path.join(SOUNDS_DIR, local)), features: c.features, query: c.query, isPreview, openverse: det });
  }
  fs.writeFileSync(path.join(SOUNDS_DIR, "CREDITOS.txt"), "﻿" + `CRÉDITOS DOS SONS — E Se? Studio\nGerado em ${new Date().toISOString()} a partir da API oficial do Openverse.\n\n` + entries.join("\n\n" + "-".repeat(60) + "\n\n") + "\n", "utf8");
  writeJson(path.join(SOUNDS_DIR, "openverse_manifest.json"), { generatedAt: new Date().toISOString(), api: API, filters: { license: "cc0,by", length: "shortest,short", note: "category=sound_effect omitido: zerava os resultados" }, items: manifest });
  return manifest;
}

export async function probeOk(file: string) {
  const i = await ffprobe(file);
  return i.streams.some((s) => s.codec_type === "audio") && i.duration > 0;
}
