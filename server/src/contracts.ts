import { z } from "zod";

/** Contratos JSON validados. Toda resposta estruturada de modelo passa por aqui. */

export const Genre = z.enum(["aventura", "mistério", "ficção científica", "fantasia", "humor", "sobrevivência", "terror"]);
export const VisualMode = z.enum(["codigo", "camadas", "hibrido"]);

export const ProjectSettings = z.object({
  premise: z.string().min(5),
  genre: Genre.default("sobrevivência"),
  audience: z.string().default("jovens e adultos"),
  language: z.string().default("pt-BR"),
  perspective: z.enum(["segunda pessoa", "primeira pessoa", "terceira pessoa"]).default("segunda pessoa"),
  /** segundos de narração-alvo */
  targetSeconds: z.number().min(15).max(600),
  toleranceSeconds: z.number().min(2).max(60).default(20),
  format: z.enum(["16:9", "9:16"]),
  styleId: z.string().optional(),
  styleVariantId: z.string().optional(),
  visualMode: VisualMode.default("codigo"),
  suspense: z.number().min(0).max(10).default(7),
  violence: z.number().min(0).max(10).default(3),
  voice: z.object({ profileId: z.string().optional(), engine: z.string().optional(), wpm: z.number().min(90).max(220).default(150) }).default({ wpm: 150 }),
  music: z.string().default("tensa e discreta"),
  shortsCount: z.number().int().min(0).max(10).default(0),
  aiScenes: z.object({
    enabled: z.boolean().default(false),
    where: z.enum(["local", "runpod"]).optional(),
    model: z.string().optional(),
    budgetUsd: z.number().min(0).default(0),
  }).default({ enabled: false, budgetUsd: 0 }),
  budgetUsd: z.number().min(0).default(5),
  freeText: z.string().default(""),
  referenceLinks: z.array(z.string().url()).default([]),
  fps: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }).default({ num: 24, den: 1 }),
  loudness: z.object({ lufs: z.number().default(-16), truePeak: z.number().default(-4) }).default({ lufs: -16, truePeak: -4 }),
  mode: z.enum(["independente", "serie"]).default("independente"),
  seriesId: z.string().optional(),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const ScriptLine = z.object({
  speaker: z.string().describe("'narrador' ou o id estável de um personagem"),
  text: z.string().min(1),
  emotion: z.string().describe("ex.: suspense, medo, calma, urgência"),
  pauseAfterMs: z.number().int().min(0).max(4000),
});
export const ScriptScene = z.object({
  key: z.string().describe("id estável curto, ex.: s01"),
  act: z.number().int().min(1).max(5),
  goal: z.string(),
  setting: z.string().describe("id do cenário da bíblia"),
  characters: z.array(z.string()),
  actions: z.array(z.string()).describe("ações visíveis e realizáveis"),
  emotion: z.string(),
  lines: z.array(ScriptLine).min(1),
  visualIntent: z.string(),
  camera: z.string(),
  mediaNeeds: z.array(z.string()),
  soundMoments: z.array(z.string()),
  estimatedSeconds: z.number().min(1).max(120),
});
export const ScriptCharacter = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string(),
  role: z.string(),
  physical: z.string(),
  clothes: z.string(),
  colors: z.array(z.string()),
  proportions: z.string(),
  accessories: z.array(z.string()),
  personality: z.string(),
  relations: z.string(),
});
export const ScriptDoc = z.object({
  title: z.string(),
  logline: z.string(),
  hook: z.string().describe("primeira fala, 3–8 s, situação concreta"),
  hookOptions: z.array(z.object({ text: z.string(), formula: z.string() })).length(5),
  protagonistGoal: z.string(),
  stakes: z.string(),
  worldRules: z.array(z.string()).min(1),
  characters: z.array(ScriptCharacter),
  settings: z.array(z.object({ id: z.string(), description: z.string() })),
  scenes: z.array(ScriptScene).min(1),
  conclusion: z.string(),
  cta: z.string(),
  estimatedWords: z.number().int(),
  selfReview: z.object({
    repetitions: z.array(z.string()),
    contradictions: z.array(z.string()),
    excessiveExposition: z.array(z.string()),
    unkeptPromises: z.array(z.string()),
  }),
});
export type ScriptDoc = z.infer<typeof ScriptDoc>;

/** Plano visual de uma cena, derivado dos tempos REAIS do master aprovado. */
export const ShotPlan = z.object({
  t0: z.number(), t1: z.number(),
  setPiece: z.string(),
  camera: z.object({
    move: z.enum(["estatica", "push-in", "pull-out", "pan-esq", "pan-dir", "tilt-cima", "tilt-baixo", "tremor", "travelling"]),
    shot: z.enum(["geral", "medio", "close", "detalhe"]),
    intensity: z.number().min(0).max(1),
  }),
  actors: z.array(z.object({ id: z.string(), action: z.string(), x: z.number(), facing: z.enum(["esq", "dir"]) })),
  props: z.array(z.string()),
  fx: z.array(z.string()),
  light: z.enum(["dia", "entardecer", "noite", "lanterna", "fogueira", "alerta"]),
  transitionIn: z.enum(["corte", "fusao", "whip", "escuro", "match"]),
  caption: z.string().nullable(),
});
export type ShotPlan = z.infer<typeof ShotPlan>;

export const SceneData = z.object({
  title: z.string(),
  narration: z.string(),
  segmentIds: z.array(z.string()),
  characters: z.array(z.string()),
  setting: z.string(),
  actions: z.array(z.string()),
  visualIntent: z.string(),
  styleId: z.string(),
  styleHash: z.string(),
  visualMode: VisualMode,
  shots: z.array(ShotPlan),
  media: z.array(z.object({ role: z.string(), assetId: z.string().nullable(), prompt: z.string() })),
  ai: z.object({
    use: z.boolean(), where: z.enum(["local", "runpod"]).optional(), model: z.string().optional(),
    prompt: z.string().optional(), seed: z.number().int().optional(), status: z.string().optional(),
  }),
  sound: z.array(z.string()),
  subtitleIds: z.array(z.number()),
});
export type SceneData = z.infer<typeof SceneData>;

export const SoundCue = z.object({
  id: z.string(),
  sceneKey: z.string(),
  timelineVersion: z.string(),
  event: z.string(),
  narrativeFunction: z.string(),
  category: z.string(),
  file: z.string().nullable(),
  source: z.string(),
  license: z.string(),
  fps: z.object({ num: z.number().int(), den: z.number().int() }),
  frame: z.number().int().min(0),
  targetTime: z.number(),
  syncType: z.enum(["inicio", "ataque", "pico", "passagem", "fim", "silencio"]),
  syncOffset: z.number(),
  fileStart: z.number(),
  duration: z.number(),
  intentionalShiftMs: z.number().default(0),
  gainDb: z.number(),
  fadeInMs: z.number(), fadeOutMs: z.number(),
  pan: z.number().min(-1).max(1),
  relation: z.string(),
  review: z.enum(["proposto", "aprovado", "ajustar"]).default("proposto"),
});
export type SoundCue = z.infer<typeof SoundCue>;

export const ChannelProfile = z.object({
  proposal: z.string().default(""),
  audience: z.string().default(""),
  language: z.string().default("pt-BR"),
  tone: z.string().default(""),
  themes: z.array(z.string()).default([]),
  approvedExamples: z.array(z.string()).default([]),
  recurringCharacters: z.array(z.string()).default([]),
  rules: z.array(z.string()).default([]),
  vocabulary: z.string().default(""),
  pacing: z.string().default(""),
  restrictions: z.array(z.string()).default([]),
  qualityCriteria: z.array(z.string()).default([]),
  productionAvailability: z.string().default(""),
  /** template de voz editorial (youtube-agent-skill/templates/voice.md) — maneira de escrever, não timbre */
  editorialVoice: z.string().default(""),
});
export type ChannelProfile = z.infer<typeof ChannelProfile>;
