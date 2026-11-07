import Database from "better-sqlite3";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, ensureDirs } from "./paths.js";

ensureDirs();

export type DB = Database.Database;
let _db: DB | null = null;

export function db(): DB {
  if (_db) return _db;
  const file = process.env.ESE_DB ?? path.join(DATA_DIR, "estudio.sqlite");
  _db = new Database(file);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");
  migrate(_db);
  return _db;
}

export function closeDb() {
  _db?.close();
  _db = null;
}

export const uid = (prefix = "") => prefix + crypto.randomBytes(8).toString("hex");
export const now = () => new Date().toISOString();

export function j<T = any>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/**
 * Esquema. Cada entidade pedida no requisito §13 tem tabela própria. Campos variáveis ficam em
 * colunas JSON validadas pelos contratos zod em contracts.ts.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

  CREATE TABLE IF NOT EXISTS series (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, premise TEXT, bible_json TEXT DEFAULT '{}',
    created_at TEXT, updated_at TEXT);

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('long','short','package')),
    parent_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    settings_json TEXT NOT NULL,          -- ProjectSettings
    style_lock_json TEXT,                 -- estilo + versão fixados
    bible_json TEXT DEFAULT '{}',         -- bíblia do projeto (regras, cenários)
    status TEXT NOT NULL DEFAULT 'rascunho',
    is_demo INTEGER DEFAULT 0, is_test INTEGER DEFAULT 0,
    created_at TEXT, updated_at TEXT);

  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    season INTEGER NOT NULL DEFAULT 1, number INTEGER NOT NULL,
    recap TEXT, audience_choice TEXT, audience_choice_source TEXT, created_at TEXT);

  CREATE TABLE IF NOT EXISTS styles (
    id TEXT PRIMARY KEY,                  -- origem:slug
    source TEXT NOT NULL, slug TEXT NOT NULL, version TEXT NOT NULL,
    data_json TEXT NOT NULL, content_hash TEXT NOT NULL,
    available INTEGER NOT NULL DEFAULT 1, removed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT);
  CREATE TABLE IF NOT EXISTS style_versions (
    style_id TEXT NOT NULL, content_hash TEXT NOT NULL, data_json TEXT NOT NULL, seen_at TEXT,
    PRIMARY KEY (style_id, content_hash));
  CREATE TABLE IF NOT EXISTS style_variants (
    id TEXT PRIMARY KEY, base_style_id TEXT NOT NULL, base_hash TEXT NOT NULL,
    name TEXT NOT NULL, overrides_json TEXT NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS favorites (kind TEXT, ref TEXT, created_at TEXT, PRIMARY KEY(kind, ref));
  CREATE TABLE IF NOT EXISTS catalog_reports (id TEXT PRIMARY KEY, data_json TEXT, created_at TEXT);

  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    series_id TEXT REFERENCES series(id) ON DELETE CASCADE,
    stable_key TEXT NOT NULL, data_json TEXT NOT NULL, ref_asset_id TEXT,
    created_at TEXT, updated_at TEXT);

  CREATE TABLE IF NOT EXISTS script_versions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, origin TEXT NOT NULL,      -- api | claude-code | manual
    model TEXT, data_json TEXT NOT NULL, text TEXT NOT NULL,
    hooks_json TEXT, report_json TEXT, channel_direction_version INTEGER,
    created_at TEXT, UNIQUE(project_id, version));

  CREATE TABLE IF NOT EXISTS voice_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, engine TEXT NOT NULL, engine_voice TEXT,
    kind TEXT NOT NULL,                   -- preset | clone | design
    language TEXT, data_json TEXT NOT NULL DEFAULT '{}',
    consent_json TEXT, sample_path TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS voice_recipes (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, engine TEXT NOT NULL,
    recipe_json TEXT NOT NULL, translation_json TEXT NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS pronunciations (
    id TEXT PRIMARY KEY, project_id TEXT, term TEXT NOT NULL, say TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS speech_segments (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    script_version INTEGER NOT NULL, idx INTEGER NOT NULL, scene_key TEXT,
    speaker TEXT NOT NULL, text TEXT NOT NULL, direction_json TEXT NOT NULL DEFAULT '{}',
    pause_after_ms INTEGER NOT NULL DEFAULT 250, chosen_take_id TEXT,
    status TEXT NOT NULL DEFAULT 'pendente', UNIQUE(project_id, script_version, idx));
  CREATE TABLE IF NOT EXISTS voice_tracks (     -- takes por trecho
    id TEXT PRIMARY KEY, segment_id TEXT NOT NULL REFERENCES speech_segments(id) ON DELETE CASCADE,
    path TEXT NOT NULL, sha256 TEXT NOT NULL, duration REAL NOT NULL, engine TEXT NOT NULL,
    request_json TEXT NOT NULL, created_at TEXT);

  CREATE TABLE IF NOT EXISTS narration_masters (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, script_version INTEGER NOT NULL,
    path TEXT NOT NULL, sha256 TEXT NOT NULL, duration REAL NOT NULL, sample_rate INTEGER NOT NULL,
    speakers_json TEXT NOT NULL, intervals_json TEXT NOT NULL, recipe_json TEXT NOT NULL,
    origin TEXT NOT NULL,                 -- tts | upload | short-derived
    status TEXT NOT NULL DEFAULT 'aguardando revisão',
    created_at TEXT, UNIQUE(project_id, version));
  CREATE TABLE IF NOT EXISTS audio_approvals (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    master_id TEXT NOT NULL REFERENCES narration_masters(id), master_sha256 TEXT NOT NULL,
    approved_at TEXT NOT NULL, approved_by TEXT NOT NULL, notes TEXT, revoked_at TEXT, revoked_reason TEXT);
  CREATE TABLE IF NOT EXISTS alignments (
    id TEXT PRIMARY KEY, master_id TEXT NOT NULL REFERENCES narration_masters(id) ON DELETE CASCADE,
    engine TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS subtitle_tracks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, master_id TEXT NOT NULL,
    path TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'atual', created_at TEXT);

  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    stable_key TEXT NOT NULL, idx INTEGER NOT NULL, master_id TEXT NOT NULL,
    t0 REAL NOT NULL, t1 REAL NOT NULL, data_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'rascunho', version INTEGER NOT NULL DEFAULT 1,
    approved INTEGER NOT NULL DEFAULT 0, stale INTEGER NOT NULL DEFAULT 0, stale_reason TEXT,
    render_path TEXT, render_hash TEXT, created_at TEXT, updated_at TEXT,
    UNIQUE(project_id, stable_key));

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL, path TEXT NOT NULL,
    sha256 TEXT NOT NULL, mime TEXT, provenance_json TEXT NOT NULL DEFAULT '{}',
    cost_json TEXT, scene_key TEXT, character_key TEXT, approved INTEGER DEFAULT 0, created_at TEXT);

  CREATE TABLE IF NOT EXISTS sound_cues (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, timeline_version TEXT NOT NULL,
    scene_key TEXT, data_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposto', created_at TEXT);
  CREATE TABLE IF NOT EXISTS review_clips (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, export_id TEXT, idx INTEGER NOT NULL,
    data_json TEXT NOT NULL, verdict TEXT, note TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS exports (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT,
    master_id TEXT, validation_json TEXT, status TEXT NOT NULL, created_at TEXT);

  CREATE TABLE IF NOT EXISTS provider_configs (
    provider TEXT PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}',
    status_json TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS channel_profiles (
    version INTEGER PRIMARY KEY, data_json TEXT NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS editorial_reports (
    id TEXT PRIMARY KEY, project_id TEXT, skill TEXT NOT NULL, project_version TEXT,
    input_json TEXT, data_json TEXT NOT NULL, created_at TEXT);

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, project_id TEXT, type TEXT NOT NULL,
    status TEXT NOT NULL,                 -- em fila | produzindo | pausado | falhou | cancelado | concluído
    payload_json TEXT NOT NULL, result_json TEXT, error TEXT,
    progress REAL DEFAULT 0, progress_label TEXT, progress_estimated INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 2,
    idempotency_key TEXT UNIQUE, master_id TEXT, paid INTEGER DEFAULT 0,
    cancel_requested INTEGER DEFAULT 0, worker_pid INTEGER, heartbeat_at TEXT,
    created_at TEXT, started_at TEXT, finished_at TEXT);
  CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
  CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, at TEXT, level TEXT, message TEXT);
  CREATE TABLE IF NOT EXISTS remote_jobs (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, provider TEXT NOT NULL, remote_id TEXT NOT NULL,
    endpoint TEXT, status TEXT, data_json TEXT, created_at TEXT, updated_at TEXT);

  CREATE TABLE IF NOT EXISTS costs (
    id TEXT PRIMARY KEY, project_id TEXT, job_id TEXT, provider TEXT NOT NULL, model TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('estimado','confirmado','indisponível')),
    amount_usd REAL, units_json TEXT, created_at TEXT);
  `,
];

function migrate(d: DB) {
  d.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
  const row = d.prepare("SELECT v FROM meta WHERE k='schema'").get() as { v: string } | undefined;
  const cur = row ? Number(row.v) : 0;
  for (let i = cur; i < MIGRATIONS.length; i++) {
    d.exec(MIGRATIONS[i]);
    d.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('schema',?)").run(String(i + 1));
  }
}
