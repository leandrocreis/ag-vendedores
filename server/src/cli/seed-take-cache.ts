/** Semeia o cache de takes a partir dos takes escolhidos de uma versão de roteiro (reuso de trechos inalterados). */
import fs from "node:fs";
import path from "node:path";
import { db, j } from "../db.js";
import { projectDir } from "../paths.js";
import { sha256 } from "../util.js";
import { voiceCast, listSegments } from "../pipeline/narration.js";
import { applyPronunciation } from "../providers/tts.js";
const [pid, sv] = [process.argv[2], Number(process.argv[3])];
const cast = voiceCast(pid);
const dict = db().prepare("SELECT term, say FROM pronunciations WHERE project_id=? OR project_id IS NULL").all(pid) as any[];
let n = 0;
for (const s of listSegments(pid, sv)) {
  const t = s.takes.find((x: any) => x.id === s.chosen_take_id);
  if (!t) continue;
  const setting = cast[s.speaker] ?? cast.narrador;
  const key = sha256(JSON.stringify([applyPronunciation(s.text, dict), setting, j<any>(s.direction_json, {}).emotion ?? null]));
  const f = path.join(projectDir(pid), "voz", "cache", `${key}.wav`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) { fs.copyFileSync(t.path, f); n++; }
}
console.log(`${n} takes adicionados ao cache`);
