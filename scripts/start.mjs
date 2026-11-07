#!/usr/bin/env node
// Inicia o E Se? Studio: servidor (127.0.0.1) + worker de produção. Uso: npm start   (dev: npm run dev)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dev = process.argv.includes("--dev");
const port = process.env.PORTA ?? "4870";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
if (!dev && !fs.existsSync(path.join(ROOT, "web", "dist", "index.html"))) {
  console.log("Compilando a interface (primeira execução)…");
  execFileSync(npx, ["vite", "build"], { cwd: path.join(ROOT, "web"), stdio: "inherit" });
}
const procs = [];
const run = (name, args, cwd) => {
  const p = spawn(npx, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORTA: port } });
  p.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  p.on("exit", (c) => { console.log(`[${name}] saiu (${c})`); if (!stopping) shutdown(1); });
  procs.push(p);
};
let stopping = false;
function shutdown(code = 0) { stopping = true; for (const p of procs) p.kill("SIGTERM"); setTimeout(() => process.exit(code), 1500); }
process.on("SIGINT", () => shutdown(0)); process.on("SIGTERM", () => shutdown(0));
run("servidor", ["tsx", "src/index.ts", ...(dev ? ["--dev"] : [])], path.join(ROOT, "server"));
run("worker", ["tsx", "src/worker.ts"], path.join(ROOT, "server"));
if (dev) run("web", ["vite", "--host", "127.0.0.1", "--port", "5173"], path.join(ROOT, "web"));
console.log(`\nE Se? Studio → http://127.0.0.1:${dev ? "5173" : port}  (Ctrl+C para sair)\n`);
