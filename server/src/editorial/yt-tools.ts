import fs from "node:fs";
import path from "node:path";
import { VENDOR_DIR } from "../paths.js";
import { mmss } from "../util.js";

/**
 * Portes para TypeScript das ferramentas da youtube-agent-skill (MIT, Jake Schincariol):
 *   yt-script/hookscore.py, yt-package/title.py, yt-chapters/chapters.py,
 *   yt-retention/retention.py, yt-edit/deadair.py, yt-viral/swipe.py
 * Mesma lógica e pesos do original. ADAPTAÇÃO NOSSA: léxicos em português somados aos ingleses
 * (os regex originais só reconhecem inglês). As notas são heurísticas e não preveem visualizações.
 */
const SKILL_DIR = path.join(VENDOR_DIR, "youtube-agent-skill", "skills");

export function hookFormulas(): { id: string; name: string; shape: string; example: string; fails_when: string; match: string[] }[] {
  try { return JSON.parse(fs.readFileSync(path.join(SKILL_DIR, "yt-script", "hooks.json"), "utf8")).hooks; } catch { return []; }
}

/* ------------------------------- hookscore ------------------------------- */
const FILLER = new Set(["basically", "actually", "literally", "just", "really", "very", "so", "kind", "sort", "like", "guys", "hey", "welcome", "today", "video", "subscribe", "channel",
  "basicamente", "literalmente", "tipo", "pessoal", "galera", "olá", "oi", "bem-vindos", "hoje", "vídeo", "inscreva", "canal", "muito", "realmente"]);
const VAGUE = new Set(["amazing", "incredible", "insane", "crazy", "huge", "massive", "game", "changer", "secret", "powerful", "ultimate", "best", "revolutionary", "mind", "blowing", "unbelievable",
  "incrível", "insano", "louco", "enorme", "gigantesco", "segredo", "poderoso", "melhor", "revolucionário", "inacreditável", "surreal"]);
const CONCRETE = /\b(\d[\d,.]*\s?(%|k|m|x|s|h)?|\$\d|R\$\s?\d|\d+\s?(second|minute|hour|day|week|month|year|segundo|minuto|hora|dia|semana|m[eê]s|ano)s?)\b/gi;
const YOU = /\b(you|your|you're|youre|yourself|você|vocês|voce|seu|sua|seus|suas|te|ti)\b/gi;
const STAKE = /\b(lose|lost|wasting|waste|quit|fail|broke|cost|risk|before|stop|never|die|dying|dead|perder|perdeu|perde|desperdiçar|falhar|custa|risco|antes|pare|parar|nunca|morrer|morrendo|morto|morta|sangue|preso|presa|fugir|sobreviver)\b/gi;
const CURIOSITY = /\b(why|how|what|which|until|before|but|nobody|almost|except|reason|actually|por que|porque|como|o que|qual|até|antes|mas|ninguém|quase|exceto|motivo|só que|de repente)\b/gi;
const words = (t: string) => t.toLowerCase().match(/[a-zà-ú0-9'%$.-]+/g) ?? [];
const count = (re: RegExp, t: string) => (t.match(re) ?? []).length;

function specificity(t: string) {
  const w = words(t); if (!w.length) return 0;
  const nums = count(CONCRETE, t), vague = w.filter((x) => VAGUE.has(x)).length, filler = w.filter((x) => FILLER.has(x)).length;
  let s = 34 + nums * 22 - vague * 16 - filler * 5;
  s += Math.min(18, 6 * t.split(/\s+/).slice(1).filter((x) => /^[A-ZÀ-Ú]/.test(x)).length);
  return Math.max(0, Math.min(100, s));
}
const address = (t: string) => Math.max(0, Math.min(100, 26 + count(YOU, t) * 20 + (new RegExp(YOU.source, "i").test(t.split(/\s+/).slice(0, 6).join(" ")) ? 30 : 0)));
const stakes = (t: string) => Math.max(0, Math.min(100, 22 + count(STAKE, t) * 26 + (new RegExp(CONCRETE.source, "i").test(t) ? 14 : 0)));
function curiosity(t: string) {
  const q = t.trim().endsWith("?") ? 18 : 0;
  const closed = /\b(because|so that|which means|porque|então|o que significa)\b/i.test(t) ? -18 : 0;
  return Math.max(0, Math.min(100, 24 + count(CURIOSITY, t) * 17 + q + closed));
}
function brevity(t: string) {
  const n = words(t).length; if (!n) return 0;
  if (n >= 9 && n <= 24) return 100;
  return n < 9 ? Math.max(30, 100 - (9 - n) * 11) : Math.max(10, 100 - (n - 24) * 7);
}
const FIX: Record<string, string> = {
  ESPECIFICIDADE: "troque um adjetivo por um número, um nome ou um detalhe concreto",
  ENDEREÇAMENTO: "diga 'você' nas seis primeiras palavras",
  RISCO: "diga o que o espectador perde se nada mudar",
  CURIOSIDADE: "corte a metade da frase que responde a si mesma",
  CONCISÃO: "9 a 24 palavras; leia em voz alta e pare onde o fôlego acaba",
};
export function hookScore(t: string) {
  const parts: Record<string, number> = { ESPECIFICIDADE: specificity(t), ENDEREÇAMENTO: address(t), RISCO: stakes(t), CURIOSIDADE: curiosity(t), CONCISÃO: brevity(t) };
  const vals = Object.values(parts);
  const verdict = Math.round(0.6 * (vals.reduce((a, b) => a + b, 0) / vals.length) + 0.4 * Math.min(...vals));
  let best: string | null = null, hits = 0;
  for (const f of hookFormulas()) {
    const n = f.match.filter((p) => { try { return new RegExp(p, "i").test(t); } catch { return false; } }).length;
    if (n > hits) { best = f.name; hits = n; }
  }
  const weakest = Object.entries(parts).sort((a, b) => a[1] - b[1])[0][0];
  return { hook: t, properties: parts, verdict, band: verdict >= 72 ? "FORTE" : verdict >= 55 ? "FUNCIONA" : "FRACO", formula: best ?? "Não classificado (fórmulas em inglês)", weakest, fix: FIX[weakest],
    note: "Heurística portada de hookscore.py; separa ganchos ruins de bons, mas não prevê visualizações." };
}
export const rankHooks = (hooks: string[]) => hooks.map(hookScore).sort((a, b) => b.verdict - a.verdict);

/* --------------------------------- título -------------------------------- */
export function titleLint(title: string, thumb?: string) {
  const DESKTOP = 60, MOBILE = 40, HARD = 100;
  const STOP = new Set(["the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "is", "are", "with", "your", "you", "my", "i", "this", "that", "it", "how", "what", "why",
    "o", "a", "os", "as", "um", "uma", "de", "do", "da", "dos", "das", "para", "em", "no", "na", "e", "ou", "é", "com", "seu", "sua", "você", "meu", "isso", "como", "que", "por", "se"]);
  const t = title.trim(), n = [...t].length;
  const issues: [string, string][] = [], good: string[] = [];
  if (n > HARD) issues.push(["tamanho", `${n} caracteres — o limite do YouTube é ${HARD}`]);
  else if (n > DESKTOP) issues.push(["tamanho", `${n} caracteres — a busca no desktop corta perto de ${DESKTOP}`]);
  else good.push(`${n} caracteres, dentro do corte de ${DESKTOP}`);
  if (n > MOBILE) issues.push(["celular", `no feed do celular aparece cerca de "${t.slice(0, MOBILE).replace(/\s+\S*$/, "")}…" — confira se o assunto sobrevive`]);
  const caps = t.split(/\s+/).filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-ZÀ-Ú]/.test(w));
  if (caps.length > 2) issues.push(["gritando", `${caps.length} palavras em maiúsculas`]); else if (caps.length) good.push(`${caps.length} palavra em maiúsculas para ênfase`);
  const v = words(t).filter((w) => VAGUE.has(w));
  if (v.length) issues.push(["vago", `${[...new Set(v)].join(", ")} — troque por número, nome ou data`]);
  const nums = t.match(/\d[\d,.]*%?/g) ?? [];
  if (nums.length) good.push(`traz um dado concreto (${nums.slice(0, 3).join(", ")})`); else issues.push(["sem-número", "sem número, data ou nome — a correção mais confiável (em ficção, um detalhe concreto também serve)"]);
  if (t.endsWith("?")) good.push("pergunta aberta no título");
  if (!words(t).slice(0, 3).some((w) => !STOP.has(w))) issues.push(["começo", "as três primeiras palavras são enchimento"]);
  if (thumb) {
    const tw = new Set(words(t).filter((w) => !STOP.has(w))), hw = new Set(words(thumb).filter((w) => !STOP.has(w)));
    const shared = [...tw].filter((w) => hw.has(w));
    if (shared.length) issues.push(["duplicado", `a thumbnail repete o título em: ${shared.join(", ")}`]); else good.push("título e thumbnail dizem coisas diferentes");
    if (words(thumb).length > 4) issues.push(["texto-thumb", `${words(thumb).length} palavras na thumbnail — três é o teto no tamanho do feed`]);
  }
  return { title: t, chars: n, score: Math.max(0, Math.min(100, 100 - 14 * issues.length + 4 * good.length)), issues, good };
}

/* -------------------------------- capítulos ------------------------------- */
export interface Cue { t0: number; t1: number; text: string }
export function parseSrt(raw: string): Cue[] {
  const ts = (s: string) => { const p = s.trim().replace(",", ".").split(":"); return p.length === 3 ? +p[0] * 3600 + +p[1] * 60 + +p[2] : +p[0] * 60 + +p[1]; };
  const out: Cue[] = []; let cur: Cue | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/\s*(\d[\d:.,]+)\s*-->\s*(\d[\d:.,]+)/);
    if (m) { cur = { t0: ts(m[1]), t1: ts(m[2]), text: "" }; out.push(cur); }
    else if (cur && line.trim() && !/^\d+$/.test(line.trim())) cur.text = (cur.text + " " + line.trim()).trim();
  }
  return out.filter((c) => c.text);
}
const STOPK = new Set("the a an of for to in on and or is are was were be been with this that it as at by from you your i my we our they them he she but so if then than there here what which who how when where why not no yes do does did just really very like about into over out up down can could will would should have has had get got make made go going went one two que de do da dos das para com uma por mais como mas foi ele ela eles elas isso esse essa você seu sua nos nas não sim muito quando onde porque então aqui ali".split(" "));
const keywords = (t: string) => new Set((t.toLowerCase().match(/[a-zà-ú']{4,}/g) ?? []).filter((w) => !STOPK.has(w)));
export function chapters(cues: Cue[], target = 7, minLen = 10) {
  if (cues.length < 6) return { valid: false, chapters: [], reason: "poucos trechos para capitular" };
  const dur = cues[cues.length - 1].t1;
  const cand: [number, number][] = [];
  for (let i = 1; i < cues.length; i++) {
    const gap = cues[i].t0 - cues[i - 1].t1;
    const kb = keywords(cues.slice(Math.max(0, i - 12), i).map((c) => c.text).join(" ")), ka = keywords(cues.slice(i, i + 12).map((c) => c.text).join(" "));
    const uni = new Set([...kb, ...ka]); const inter = [...kb].filter((w) => ka.has(w)).length;
    const shift = uni.size ? 1 - inter / uni.size : 0;
    cand.push([gap * 1.6 + shift * 3.2, cues[i].t0]);
  }
  cand.sort((a, b) => b[0] - a[0]);
  const picked = [0];
  for (const [, t] of cand) { if (picked.length >= target) break; if (picked.every((p) => Math.abs(t - p) >= minLen) && dur - t >= minLen) picked.push(t); }
  picked.sort((a, b) => a - b);
  const ch = picked.map((t, n) => {
    const end = picked[n + 1] ?? dur;
    const text = cues.filter((c) => c.t0 >= t && c.t1 <= end).map((c) => c.text).join(" ");
    const kw = [...keywords(text)].sort((a, b) => text.toLowerCase().split(b).length - text.toLowerCase().split(a).length);
    return { start: +t.toFixed(2), label: mmss(t), draftTitle: kw.slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Seção", seconds: +(end - t).toFixed(2) };
  });
  const valid = ch.length >= 3 && ch[0].start === 0 && ch.every((c) => c.seconds >= minLen);
  return { valid, chapters: ch, rules: "Regras verificadas: começa em 0:00, ≥3 capítulos, cada um ≥10 s. Reescreva os títulos — são palavras-tema, não títulos finais." };
}

/* -------------------------------- retenção -------------------------------- */
export function parseRetentionCsv(raw: string) {
  const rows: [number, number][] = [];
  for (const line of raw.replace(/^﻿/, "").split(/\r?\n/)) {
    const nums = line.split(/[,;\t]/).map((c) => Number(c.trim().replace("%", "").replace(",", "."))).filter((n) => Number.isFinite(n));
    if (nums.length >= 2) rows.push([nums[0], nums[1]]);
  }
  return rows;
}
export function retention(rows: [number, number][], durationSec?: number, cues?: Cue[]) {
  if (rows.length < 8) return { error: "Não foi possível ler ao menos 8 pontos (posição, % assistindo)." };
  const xs = rows.map((r) => r[0]), ys = rows.map((r) => r[1]);
  const pctAxis = Math.max(...xs) <= 100.5;
  const at = (x: number) => (pctAxis && durationSec ? (x / 100) * durationSec : pctAxis ? null : x);
  const start = ys[0] || 100;
  const cutoff = !pctAxis ? 30 : durationSec ? (30 / durationSec) * 100 : 10;
  const hookEnd = Math.min(...rows.filter(([x]) => x <= cutoff).map(([, y]) => y), start);
  const drops = rows.slice(1).map(([x, y], i) => ({ rate: (ys[i] - y) / (x - xs[i] || 1), from: xs[i], to: x, lost: ys[i] - y })).sort((a, b) => b.rate - a.rate);
  const cliffs = drops.slice(0, 5).filter((d) => d.lost > 0.8).map((d) => {
    const s = at(d.from);
    const said = s != null && cues ? cues.filter((q) => q.t0 <= s + 4 && q.t1 >= s - 4).map((q) => q.text).join(" ").slice(0, 160) : null;
    return { from: d.from, to: d.to, lost: +d.lost.toFixed(2), atSeconds: s != null ? +s.toFixed(1) : null, said };
  });
  const mid = drops.filter((d) => d.from > cutoff).map((d) => d.rate);
  return {
    points: rows.length, axis: pctAxis ? "percentual do vídeo" : "segundos", start, end: ys[ys.length - 1], hookLeak: +(start - hookEnd).toFixed(2),
    hookVerdict: start - hookEnd < 25 ? "saudável" : start - hookEnd < 40 ? "vazando" : "grave", cliffs, slide: +(mid.reduce((a, b) => a + b, 0) / (mid.length || 1)).toFixed(3),
    evidenceNote: "Quedas são medidas no arquivo importado; ligar a queda ao que foi dito é correlação temporal, não prova de causa.",
  };
}

/* --------------------------- edição (deadair) ---------------------------- */
const FILLER_ONLY = /^[\s,.-]*((um+|uh+|er+|ah+|so|okay|ok|right|yeah|like|anyway|basically|actually|you know|i mean|é+|hã+|ahn+|tipo|então|né|bom|enfim|assim)[\s,.-]*)+$/i;
/** EDL de silêncios/enchimentos. Pausas intencionais (registradas no master) NÃO são marcadas como erro. */
export function deadAir(cues: Cue[], floor = 0.35, intentionalPauses: { t0: number; t1: number }[] = []) {
  const items: any[] = [];
  for (let i = 1; i < cues.length; i++) {
    const g0 = cues[i - 1].t1, g1 = cues[i].t0, gap = g1 - g0;
    if (gap > floor) {
      const intentional = intentionalPauses.some((p) => p.t0 <= g0 + 0.15 && p.t1 >= g1 - 0.15);
      items.push({ kind: intentional ? "PAUSA INTENCIONAL" : "SILÊNCIO", t0: g0, t1: g1, seconds: +gap.toFixed(2), action: intentional ? "manter (direção dramática)" : "avaliar corte — exige nova aprovação do áudio" });
    }
  }
  for (const c of cues) if (FILLER_ONLY.test(c.text)) items.push({ kind: "ENCHIMENTO", t0: c.t0, t1: c.t1, seconds: +(c.t1 - c.t0).toFixed(2), text: c.text, action: "avaliar corte — exige nova aprovação do áudio" });
  for (let i = 1; i < cues.length; i++) {
    const a = cues[i - 1].text.toLowerCase().split(/\s+/).slice(0, 4).join(" "), b = cues[i].text.toLowerCase().split(/\s+/).slice(0, 4).join(" ");
    if (a.length > 8 && a === b) items.push({ kind: "REPETIÇÃO", t0: cues[i - 1].t0, t1: cues[i - 1].t1, text: cues[i - 1].text, action: "manter só a segunda tomada? exige nova aprovação" });
  }
  const removable = items.filter((x) => x.kind !== "PAUSA INTENCIONAL").reduce((s, x) => s + x.seconds, 0);
  return { items: items.sort((a, b) => a.t0 - b.t0), removableSeconds: +removable.toFixed(2), note: "Nada é cortado automaticamente: o EDL é revisado e qualquer corte cria nova versão do master." };
}

/* ----------------------------- viral (swipe) ------------------------------ */
export function swipe(videos: { channel: string; title: string; views: number; url?: string; duration?: number }[], min = 2.0) {
  const by = new Map<string, number[]>();
  for (const v of videos) by.set(v.channel, [...(by.get(v.channel) ?? []), v.views]);
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const out = videos.map((v) => {
    const vs = by.get(v.channel)!;
    const enough = vs.length >= 4;
    const mult = enough ? v.views / (med(vs) || 1) : null;
    const f = hookFormulas().map((x) => ({ n: x.match.filter((p) => { try { return new RegExp(p, "i").test(v.title); } catch { return false; } }).length, name: x.name })).sort((a, b) => b.n - a.n)[0];
    return { ...v, multiple: mult, reliable: enough, formula: f?.n ? f.name : "Não classificado" };
  }).filter((v) => v.multiple == null || v.multiple >= min).sort((a, b) => (b.multiple ?? 0) - (a.multiple ?? 0));
  return { ranked: out, note: "Múltiplo da mediana do PRÓPRIO canal (mín. 4 vídeos por canal). Dados importados pelo usuário; não indica viralização futura." };
}
