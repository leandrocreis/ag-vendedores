#!/usr/bin/env node
// Clona os oito repositórios de referência em vendor/, FIXADOS nos commits verificados.
// Uso: npm run refs   (ou: npm run refs -- --atualizar  para buscar a ponta de main e mostrar o que mudou)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REFS = JSON.parse(fs.readFileSync(path.join(ROOT, "refs.lock.json"), "utf8")).repos;
const update = process.argv.includes("--atualizar");
fs.mkdirSync(path.join(ROOT, "vendor"), { recursive: true });
for (const r of REFS) {
  const dir = path.join(ROOT, "vendor", r.name);
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
  if (!fs.existsSync(dir)) execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", r.url, dir], { stdio: "inherit" });
  if (fs.lstatSync(dir).isSymbolicLink()) { console.log(`${r.name}: link existente, mantido`); continue; }
  git("fetch", "--quiet", "origin", update ? "HEAD" : r.commit);
  const target = update ? git("rev-parse", "FETCH_HEAD") : r.commit;
  git("checkout", "--quiet", target);
  console.log(`${r.name.padEnd(22)} ${target.slice(0, 12)}${update && target !== r.commit ? "  (NOVO — revise e atualize refs.lock.json)" : ""}`);
}
