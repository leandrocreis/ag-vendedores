import fs from "node:fs";
import path from "node:path";
import { db, j, now, uid } from "../db.js";
import { projectDir, PYTHON_DIR, venvPython, DATA_DIR } from "../paths.js";
import { run, UserError } from "../util.js";
import { masterIntervals, requireApprovedAudio, type Master } from "./audio-gate.js";
import { buildSrt } from "./narration.js";

/**
 * Transcrição/alinhamento da GRAVAÇÃO REAL do master aprovado.
 * - Limites de cada trecho são exatos (medidos na montagem, amostra a amostra).
 * - Palavras vêm do faster-whisper (local) com confiança; p<0.5 é sinalizado como baixa confiança.
 * - Sem alinhador instalado, os tempos por palavra ficam "estimados" (proporcionais) e marcados.
 */
export async function alignApproved(projectId: string, onProgress?: (p: number, l: string) => void) {
  const m = requireApprovedAudio(projectId);
  const intervals = masterIntervals(m);
  const p = db().prepare("SELECT settings_json FROM projects WHERE id=?").get(projectId) as any;
  const lang = (j<any>(p.settings_json, {}).language ?? "pt-BR").slice(0, 2);
  let words: { t0: number; t1: number; word: string; p: number }[] | null = null;
  let engine = "estimado (proporcional ao texto)";
  let segmentsAsr: any[] = [];
  const python = venvPython();
  if (python) {
    onProgress?.(0.1, "Transcrevendo o master com faster-whisper (local)");
    const r = await run(python, ["-I", path.join(PYTHON_DIR, "align_whisper.py")], {
      input: JSON.stringify({ audio: m.path, language: lang, model: process.env.WHISPER_MODEL ?? "small", expected: intervals.map((i) => i.text).join(" ") }),
      env: { ...process.env, HF_HOME: path.join(DATA_DIR, "modelos", "hf") }, timeoutMs: 3_600_000,
    });
    try {
      const o = JSON.parse(r.stdout.trim().split("\n").pop()!);
      if (o.ok) { words = o.words; engine = o.engine; segmentsAsr = o.segments; }
      else console.warn("alinhador falhou:", o.error);
    } catch { console.warn("alinhador sem saída válida", r.stderr.slice(-300)); }
  }
  const lowConfidence = (words ?? []).filter((w) => w.p < 0.5);
  // compara texto esperado × reconhecido por trecho (taxa simples de palavras encontradas)
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const perSegment = intervals.map((iv) => {
    const heard = (words ?? []).filter((w) => w.t0 >= iv.t0 - 0.2 && w.t1 <= iv.t1 + 0.3).map((w) => norm(w.word)).flat();
    const exp = norm(iv.text);
    const hs = new Set(heard);
    const match = exp.length ? exp.filter((w) => hs.has(w)).length / exp.length : 1;
    return { segmentId: iv.segmentId, t0: iv.t0, t1: iv.t1, match: words ? match : null, flag: words ? match < 0.75 : null };
  });
  const { srt, cues } = buildSrt(intervals, words);
  const dir = path.join(projectDir(projectId), "legendas");
  fs.mkdirSync(dir, { recursive: true });
  const srtPath = path.join(dir, `narracao_v${m.version}.srt`);
  fs.writeFileSync(srtPath, srt);
  const alignId = uid("aln_");
  const data = { masterId: m.id, masterSha256: m.sha256, engine, sentenceTimesExact: true, wordTimes: words ? "medidos (ASR)" : "estimados", words, asrSegments: segmentsAsr, lowConfidence, perSegment, cues };
  db().transaction(() => {
    db().prepare("INSERT INTO alignments(id,master_id,engine,data_json,created_at) VALUES(?,?,?,?,?)").run(alignId, m.id, engine, JSON.stringify(data), now());
    db().prepare("UPDATE subtitle_tracks SET status='substituída' WHERE project_id=? AND kind='narracao' AND status='atual'").run(projectId);
    db().prepare("INSERT INTO subtitle_tracks(id,project_id,master_id,path,kind,status,created_at) VALUES(?,?,?,?,?,?,?)").run(uid("sub_"), projectId, m.id, srtPath, "narracao", "atual", now());
  })();
  return { alignId, engine, srtPath, lowConfidence: lowConfidence.length, flaggedSegments: perSegment.filter((s) => s.flag).length, words: words?.length ?? 0 };
}

export function latestAlignment(m: Master) {
  const r = db().prepare("SELECT data_json FROM alignments WHERE master_id=? ORDER BY created_at DESC LIMIT 1").get(m.id) as any;
  return r ? j<any>(r.data_json, null) : null;
}

export function requireAlignment(projectId: string) {
  const m = requireApprovedAudio(projectId);
  const a = latestAlignment(m);
  if (!a) throw new UserError("Falta o alinhamento do master aprovado (transcrição com tempos).", 409, "Alinhar narração aprovada");
  return { master: m, alignment: a };
}
