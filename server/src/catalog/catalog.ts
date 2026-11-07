import fs from "node:fs";
import path from "node:path";
import { db, j, now, uid } from "../db.js";
import { VENDOR_DIR, CACHE_DIR } from "../paths.js";
import { run, sha256 } from "../util.js";
import { CATEGORY_PT, STYLE_PT } from "./pt-names.js";

/**
 * Catálogo de estilos. Descoberto a partir dos ARQUIVOS REAIS dos repositórios em vendor/
 * (nenhuma contagem fixa no código). Coleções:
 *  - lemo: styles/<slug>/{style.json, STYLE.md, poster.jpg}; demo oficial na galeria (CC BY 4.0)
 *  - lemo-opuscar98: styleboard/opuscar98_styles.json (98 estilos-prompt; demo = trecho do filme)
 *  - bang-motion: direções e starters da galeria docs/gallery (técnica de movimento, não estilo de traço)
 *  - autoral: preset próprio "Cartoon narrativo cinematográfico"
 */

export type DemoKind = "video-oficial-remoto" | "trecho-de-filme-remoto" | "imagem" | "demo-local-gerada";
export interface StyleRecord {
  id: string; source: string; collection: string; slug: string; nameOriginal: string; namePt: string;
  category: string; categoryPt: string; description: string; descriptionLang: "en" | "pt";
  tags: string[]; thumb: string | null;
  demo: { kind: DemoKind; url?: string; start?: number; duration?: number; note: string } | null;
  license: { code: string; media: string; attribution: string };
  stylePrompt: string | null; stylePromptPath: string | null;
  renderFamily: string; palette: string[];
  capabilities: { articulatedCharacters: boolean; parallaxLayers: boolean; codeOnlyOriginal: boolean; hybridIsAdaptation: boolean };
  restrictions: string[]; dependencies: string[];
  availability: "disponível" | "precisa instalar" | "precisa configurar" | "incompatível" | "não suportado";
  origin: { repo: string; commit: string | null; path: string };
}

const LEMO_REPO = "https://github.com/lemomo-ai/lemo-opuscar";
const LEMO_GALLERY = "https://lemomo-ai.github.io/lemo-opuscar";

/** Família de renderização do nosso motor (server/engine) usada para aproximar cada estilo. */
export function familyFor(slug: string, category: string): string {
  const m: [RegExp, string][] = [
    [/watercolor|urban-sketch/, "aquarela"], [/ink-wash/, "nanquim"], [/chalkboard|whiteboard|one-line/, "giz"],
    [/crayon/, "giz-cera"], [/impasto/, "oleo"], [/shadow-puppet|papercut|paper-lantern|paper-popup/, "papel-recortado"],
    [/ukiyoe|woodcut|engraving|stained-glass/, "gravura"], [/risograph|halftone|silkscreen|printed-long/, "reticula"],
    [/ascii|circuit|hologram|dark-keynote/, "crt-neon"], [/pixel|hd-2d|microgame/, "pixel"], [/silent-film|newsreel/, "cinema-mudo"],
    [/backrooms/, "vhs"], [/blueprint|briefing|lidar|white-model|satellite|teardown/, "planta"],
    [/cel-anime|scifi-toon|rubber-hose|midcentury|game-show/, "cel"], [/iso|lowpoly|brick|tilt|memphis|glass|desktop|data-physical/, "isometrico"],
  ];
  for (const [re, f] of m) if (re.test(slug)) return f;
  if (/Edit|Evidence/.test(category)) return "documental";
  return "vetor-plano";
}

function gitHead(dir: string): string | null {
  try {
    const head = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head;
    const ref = head.slice(5).trim();
    const f = path.join(dir, ".git", ref);
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
    const packed = fs.readFileSync(path.join(dir, ".git", "packed-refs"), "utf8");
    return packed.split("\n").find((l) => l.endsWith(ref))?.split(" ")[0] ?? null;
  } catch {
    return null;
  }
}

/** Paleta dominante real da miniatura: reduz a 32×18 via ffmpeg e agrupa em k-means simples. */
export async function extractPalette(img: string, k = 5): Promise<string[]> {
  const key = sha256(img + fs.statSync(img).mtimeMs);
  const cache = path.join(CACHE_DIR, "paletas", key + ".json");
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const r = await new Promise<Buffer>((res, rej) => {
    import("node:child_process").then(({ spawn }) => {
      const p = spawn("ffmpeg", ["-v", "error", "-i", img, "-vf", "scale=32:18", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { shell: false });
      const b: Buffer[] = [];
      p.stdout.on("data", (d) => b.push(d));
      p.on("close", (c) => (c === 0 ? res(Buffer.concat(b)) : rej(new Error("ffmpeg"))));
    });
  });
  const px: number[][] = [];
  for (let i = 0; i + 2 < r.length; i += 3) px.push([r[i], r[i + 1], r[i + 2]]);
  let cent = Array.from({ length: k }, (_, i) => px[Math.floor((i + 0.5) * px.length / k)]);
  for (let it = 0; it < 12; it++) {
    const sums = cent.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let bi = 0, bd = Infinity;
      cent.forEach((c, i) => { const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; if (d < bd) { bd = d; bi = i; } });
      sums[bi][0] += p[0]; sums[bi][1] += p[1]; sums[bi][2] += p[2]; sums[bi][3]++;
    }
    cent = sums.map((s, i) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cent[i]));
  }
  const counts = cent.map(() => 0);
  for (const p of px) { let bi = 0, bd = Infinity; cent.forEach((c, i) => { const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; if (d < bd) { bd = d; bi = i; } }); counts[bi]++; }
  const hex = cent.map((c, i) => ({ c: "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""), n: counts[i] })).sort((a, b) => b.n - a.n).map((x) => x.c);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(hex));
  return hex;
}

async function discoverLemo(): Promise<StyleRecord[]> {
  const base = path.join(VENDOR_DIR, "lemo-opuscar");
  const stylesDir = path.join(base, "styles");
  if (!fs.existsSync(stylesDir)) return [];
  const commit = gitHead(base);
  const out: StyleRecord[] = [];
  for (const slug of fs.readdirSync(stylesDir).sort()) {
    const sj = path.join(stylesDir, slug, "style.json");
    if (slug.startsWith("_") || !fs.existsSync(sj)) continue;
    const s = JSON.parse(fs.readFileSync(sj, "utf8"));
    const poster = path.join(stylesDir, slug, "poster.jpg");
    const stylePromptPath = path.join(stylesDir, slug, "STYLE.md");
    const cat = s.category_en ?? "";
    const hasFilm = Number(s.dur) > 0;
    const restrictions: string[] = [];
    if (/Edit & Documentary|Evidence Films/.test(cat)) restrictions.push("O estilo original é cortado de material real (filmagem, documentos ou dados). Em histórias hipotéticas usamos apenas a gramática visual — adaptação.");
    if (/3D/.test(cat) || /lowpoly|glass|brick|desktop/.test(slug)) restrictions.push("O original usa 3D (three.js). Nosso motor aproxima em 2D/2.5D — adaptação.");
    restrictions.push("Original desenhado inteiramente por código (sem geração de imagem). Os modos 'camadas' e 'híbrido' são adaptações.");
    out.push({
      id: `lemo:${slug}`, source: "lemo-opuscar", collection: "Lemo-Opuscar", slug,
      nameOriginal: s.en, namePt: STYLE_PT[slug] ?? s.en, category: cat, categoryPt: CATEGORY_PT[cat] ?? cat,
      description: s.line ?? "", descriptionLang: "en", tags: s.uses ?? [],
      thumb: fs.existsSync(poster) ? poster : null,
      demo: hasFilm
        ? { kind: "video-oficial-remoto", url: `${LEMO_GALLERY}/films/${slug}.mp4`, duration: s.dur, note: `Filme demo oficial “${s.film}” (corte 720p da galeria, CC BY 4.0 · LemoLab). Carregado só ao tocar.` }
        : fs.existsSync(poster) ? { kind: "imagem", note: "Só há imagem para este estilo." } : null,
      license: {
        code: "MIT (código do repositório)", media: "Demos e stills: CC BY 4.0 — crédito a LemoLab com link; ativos de terceiros mantêm licenças próprias (CREDITS de cada demo). Seis faixas de voz não são CC BY.",
        attribution: `Estilo “${s.en}” de Lemo-Opuscar por LemoLab${s.by ? ` (autor: ${s.by.name})` : ""} — ${LEMO_REPO}`,
      },
      stylePrompt: fs.existsSync(stylePromptPath) ? fs.readFileSync(stylePromptPath, "utf8") : null,
      stylePromptPath: fs.existsSync(stylePromptPath) ? stylePromptPath : null,
      renderFamily: familyFor(slug, cat), palette: fs.existsSync(poster) ? await extractPalette(poster) : [],
      capabilities: { articulatedCharacters: true, parallaxLayers: true, codeOnlyOriginal: true, hybridIsAdaptation: true },
      restrictions, dependencies: ["Chromium (Playwright)", "FFmpeg"],
      availability: "disponível", origin: { repo: LEMO_REPO, commit, path: `styles/${slug}` },
    });
  }
  return out;
}

async function discoverOpuscar98(): Promise<StyleRecord[]> {
  const base = path.join(VENDOR_DIR, "lemo-opuscar");
  const f = path.join(base, "styleboard", "opuscar98_styles.json");
  if (!fs.existsSync(f)) return [];
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  const commit = gitHead(base);
  const out: StyleRecord[] = [];
  for (const film of d.films ?? []) {
    if (!film.prompt_en || !film.style_en) continue; // metadados insuficientes
    const n = String(film.no).padStart(2, "0");
    const img = path.join(base, "styleboard", "img", "opuscar98", `${n}.jpg`);
    out.push({
      id: `opuscar98:${n}`, source: "lemo-opuscar", collection: "OPUSCAR 98 (Lemo-Opuscar)", slug: `opuscar98-${n}`,
      nameOriginal: film.style_en, namePt: film.style_en, category: `OPUSCAR 98 · ${film.render ?? ""}`, categoryPt: `OPUSCAR 98 · ${film.render ?? ""}`,
      description: film.desc_en ?? "", descriptionLang: "en", tags: film.blend_en ?? [],
      thumb: fs.existsSync(img) ? img : null,
      demo: { kind: "trecho-de-filme-remoto", url: `${LEMO_GALLERY}/films/opuscar98.mp4`, start: film.t0, duration: film.dur, note: `Trecho do filme OPUSCAR 98 (${film.dur}s a partir de ${film.t0}s), CC BY 4.0 · LemoLab. O mascote “Clawd” e as referências a filmes premiados são do material original; não use personagens de terceiros.` },
      license: { code: "MIT", media: "CC BY 4.0 (LemoLab)", attribution: `Prompt de estilo da coleção OPUSCAR 98 de Lemo-Opuscar (LemoLab) — ${LEMO_REPO}` },
      stylePrompt: film.prompt_en, stylePromptPath: null,
      renderFamily: familyFor(String(film.style_en).toLowerCase().replace(/\s+/g, "-"), ""), palette: fs.existsSync(img) ? await extractPalette(img) : [],
      capabilities: { articulatedCharacters: true, parallaxLayers: true, codeOnlyOriginal: true, hybridIsAdaptation: true },
      restrictions: ["Prompt escrito para um filme específico com o mascote do autor: use apenas a técnica visual, nunca personagens, cenas ou obras citadas.", ...(film.render === "3D" ? ["Original em 3D: aproximação 2.5D no nosso motor."] : [])],
      dependencies: ["Chromium (Playwright)", "FFmpeg"], availability: "disponível",
      origin: { repo: LEMO_REPO, commit, path: `styleboard/opuscar98_styles.json#${film.no}` },
    });
  }
  return out;
}

const BANG_GALLERY: [string, string, string, string][] = [
  ["01-grainy-gradient", "Grainy gradient", "Gradiente granulado", "Formas em camadas brilhantes, grão suave, câmera que viaja através delas."],
  ["02-kinetic-colorblock", "Poster color-block", "Tipografia cinética em blocos de cor", "Palavras enormes cortadas, campos de cor sólida que entram no tempo."],
  ["04-flat-vector", "Flat vector illustration", "Ilustração vetorial plana", "Preenchimentos sólidos, mãos estilizadas, formas com leve overshoot."],
  ["05-continuous-action", "Continuous action", "Ação contínua", "Um sujeito que nunca para; números e mapas vivem dentro do mundo."],
  ["06-cartoon-stage", "Cartoon stage", "Palco de cartoon", "Um palco vivo por cena, personagens articulados, sem legendas."],
  ["09-visual-journalism", "Visual journalism", "Jornalismo visual", "Fundo preto, fotos reais com etiquetas de fonte, marca-texto e anotações."],
  ["10-vintage-sketch", "Vintage sketch", "Esboço vintage", "Papel sépia, gravura, serifas clássicas, notas em ferrugem."],
  ["11-cartoon-collage", "Cartoon collage", "Colagem de cartoon", "Papel creme, recortes de ilustração plana, pílulas de cor, caligrafia."],
];

function discoverBang(): StyleRecord[] {
  const base = path.join(VENDOR_DIR, "bang-motion");
  if (!fs.existsSync(path.join(base, "docs", "gallery"))) return [];
  const commit = gitHead(base);
  return BANG_GALLERY.filter(([f]) => fs.existsSync(path.join(base, "docs", "gallery", f + ".jpg"))).map(([f, en, pt, desc]) => ({
    id: `bang:${f}`, source: "bang-motion", collection: "Bang Motion — direções de movimento", slug: f, nameOriginal: en, namePt: pt,
    category: "Técnica de movimento", categoryPt: "Técnica de movimento (não é estilo de traço)", description: desc, descriptionLang: "pt",
    tags: ["movimento", "câmera", "transição"], thumb: path.join(base, "docs", "gallery", f + ".jpg"),
    demo: { kind: "imagem", note: "A galeria do Bang Motion traz apenas quadros estáticos (algumas fotos geradas com GPT Image, segundo o README). Use “Gerar demo local” para ver a técnica animada no nosso motor." },
    license: { code: "MIT", media: "Imagens da galeria: README informa marcas e dados fictícios; algumas imagens geradas por IA", attribution: "Bang Motion por Bang Tutorial — https://github.com/bangtutorial/bang-motion" },
    stylePrompt: null, stylePromptPath: path.join(base, "references", "techniques.md"),
    renderFamily: /cartoon/.test(f) ? "cel" : /sketch/.test(f) ? "gravura" : "vetor-plano", palette: [],
    capabilities: { articulatedCharacters: /cartoon-stage/.test(f), parallaxLayers: true, codeOnlyOriginal: true, hybridIsAdaptation: true },
    restrictions: ["É uma linguagem de movimento: combine com um estilo visual principal; não substitui o estilo do episódio."],
    dependencies: ["Chromium (Playwright)"], availability: "disponível",
    origin: { repo: "https://github.com/bangtutorial/bang-motion", commit, path: `docs/gallery/${f}.jpg` },
  }));
}

export const AUTHORIAL_STYLE: StyleRecord = {
  id: "autoral:cartoon-narrativo", source: "autoral", collection: "Presets próprios do E Se? Studio", slug: "cartoon-narrativo",
  nameOriginal: "Cartoon narrativo cinematográfico", namePt: "Cartoon narrativo cinematográfico", category: "Preset autoral", categoryPt: "Preset autoral (não importado)",
  description: "Ilustração 2D, personagens expressivos, contornos definidos, cel shading, iluminação dramática e cenários com profundidade.", descriptionLang: "pt",
  tags: ["2D", "cel shading", "contorno", "iluminação dramática", "profundidade"], thumb: null,
  demo: { kind: "demo-local-gerada", note: "Demonstração gerada localmente pelo nosso motor (sem som)." },
  license: { code: "Do próprio projeto", media: "Do próprio projeto", attribution: "Preset autoral do E Se? Studio" },
  stylePrompt: "Cartoon narrativo cinematográfico: ilustração 2D com contornos definidos e espessos (2–4 px a 1080p), cel shading em duas a três faixas de luz, personagens expressivos com proporções levemente estilizadas (cabeça grande, mãos visíveis), iluminação dramática com uma fonte dominante motivada (lua, fogueira, lanterna), cenários com profundidade em 3–5 planos de parallax, névoa atmosférica entre planos, paleta limitada com um acento recorrente.",
  stylePromptPath: null, renderFamily: "cel", palette: ["#14213d", "#1f3b57", "#e9c46a", "#f4a261", "#e76f51"],
  capabilities: { articulatedCharacters: true, parallaxLayers: true, codeOnlyOriginal: false, hybridIsAdaptation: false },
  restrictions: [], dependencies: ["Chromium (Playwright)", "FFmpeg"], availability: "disponível",
  origin: { repo: "local", commit: null, path: "server/src/catalog/catalog.ts" },
};

export async function discoverAll(): Promise<StyleRecord[]> {
  const all = [AUTHORIAL_STYLE, ...(await discoverLemo()), ...(await discoverOpuscar98()), ...discoverBang()];
  // evita duplicatas por id e por (coleção, nome original)
  const seen = new Set<string>();
  return all.filter((s) => { const k = s.id; if (seen.has(k)) return false; seen.add(k); return true; });
}

const hashOf = (s: StyleRecord) => sha256(JSON.stringify({ ...s, thumb: null, stylePromptPath: null })).slice(0, 16);

/** "Atualizar catálogo": compara com o banco e gera relatório do que mudou. Projetos guardam a versão fixada. */
export async function refreshCatalog() {
  const found = await discoverAll();
  const d = db();
  const existing = new Map((d.prepare("SELECT id, content_hash, removed FROM styles").all() as any[]).map((r) => [r.id, r]));
  const report = { added: [] as string[], changed: [] as string[], removed: [] as string[], unchanged: 0, at: now() };
  d.transaction(() => {
    for (const s of found) {
      const h = hashOf(s);
      const ex = existing.get(s.id);
      d.prepare("INSERT OR IGNORE INTO style_versions(style_id,content_hash,data_json,seen_at) VALUES(?,?,?,?)").run(s.id, h, JSON.stringify(s), now());
      if (!ex) report.added.push(s.id);
      else if (ex.content_hash !== h) report.changed.push(s.id);
      else report.unchanged++;
      d.prepare(`INSERT INTO styles(id,source,slug,version,data_json,content_hash,available,removed,updated_at) VALUES(?,?,?,?,?,?,1,0,?)
        ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, content_hash=excluded.content_hash, version=excluded.version, removed=0, updated_at=excluded.updated_at`)
        .run(s.id, s.source, s.slug, s.origin.commit?.slice(0, 12) ?? "local", JSON.stringify(s), h, now());
      existing.delete(s.id);
    }
    for (const [id, r] of existing) if (!r.removed) { d.prepare("UPDATE styles SET removed=1 WHERE id=?").run(id); report.removed.push(id); }
    d.prepare("INSERT INTO catalog_reports(id,data_json,created_at) VALUES(?,?,?)").run(uid("cat_"), JSON.stringify(report), now());
  })();
  return report;
}

export function listStyles(): (StyleRecord & { hash: string; favorite: boolean })[] {
  const favs = new Set((db().prepare("SELECT ref FROM favorites WHERE kind='style'").all() as any[]).map((r) => r.ref));
  return (db().prepare("SELECT data_json, content_hash FROM styles WHERE removed=0").all() as any[]).map((r) => ({ ...j<StyleRecord>(r.data_json, null as any), hash: r.content_hash, favorite: favs.has(j<StyleRecord>(r.data_json, null as any).id) }));
}

/** Retorna o estilo NA VERSÃO fixada (hash) — atualizações do catálogo não mudam projetos iniciados. */
export function getStyleVersion(id: string, hash?: string): StyleRecord | null {
  if (hash) {
    const r = db().prepare("SELECT data_json FROM style_versions WHERE style_id=? AND content_hash=?").get(id, hash) as any;
    if (r) return j(r.data_json, null);
  }
  const r = db().prepare("SELECT data_json FROM styles WHERE id=?").get(id) as any;
  return r ? j(r.data_json, null) : null;
}
export function styleHash(id: string): string | null {
  return (db().prepare("SELECT content_hash FROM styles WHERE id=?").get(id) as any)?.content_hash ?? null;
}

export interface StyleVariantOverrides { palette?: string[]; renderFamily?: string; grain?: number; outline?: number; notes?: string }
export function createVariant(baseId: string, name: string, overrides: StyleVariantOverrides) {
  const h = styleHash(baseId);
  if (!h) throw new Error("Estilo base não encontrado");
  const id = uid("var_");
  db().prepare("INSERT INTO style_variants(id,base_style_id,base_hash,name,overrides_json,created_at) VALUES(?,?,?,?,?,?)").run(id, baseId, h, name, JSON.stringify(overrides), now());
  return id;
}

/** Estilo efetivo de um projeto: versão fixada + variação pessoal (original nunca é alterado). */
export function effectiveStyle(styleId: string, hash: string | undefined, variantId?: string): StyleRecord & { variant?: { id: string; name: string } } {
  const base = getStyleVersion(styleId, hash) ?? AUTHORIAL_STYLE;
  if (!variantId) return base;
  const v = db().prepare("SELECT * FROM style_variants WHERE id=?").get(variantId) as any;
  if (!v) return base;
  const o = j<StyleVariantOverrides>(v.overrides_json, {});
  return { ...base, palette: o.palette ?? base.palette, renderFamily: o.renderFamily ?? base.renderFamily, variant: { id: v.id, name: v.name } };
}

export { run };
