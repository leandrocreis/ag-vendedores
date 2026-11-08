import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";

/**
 * Login para o modo SERVIDOR (ESE_MODO=servidor). No modo local (padrão) não há login:
 * o app só aceita 127.0.0.1. No servidor, uma senha única (ESE_SENHA) protege tudo;
 * a sessão é um cookie HttpOnly + Secure + SameSite=Strict assinado com HMAC.
 */
export const SERVER_MODE = process.env.ESE_MODO === "servidor";
const COOKIE = "ese_sessao";
const TTL_MS = 14 * 24 * 3600 * 1000;

function sessionSecret(): Buffer {
  const f = path.join(DATA_DIR, ".sessao.key");
  if (!fs.existsSync(f)) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, crypto.randomBytes(32).toString("hex"), { mode: 0o600 }); }
  return Buffer.from(fs.readFileSync(f, "utf8").trim(), "hex");
}

let passHash: Buffer | null = null;
const salt = crypto.randomBytes(16);
export function initAuth() {
  if (!SERVER_MODE) return;
  const p = process.env.ESE_SENHA ?? "";
  if (p.length < 12) throw new Error("Modo servidor exige ESE_SENHA com pelo menos 12 caracteres.");
  passHash = crypto.scryptSync(p, salt, 32);
}

export function checkPassword(p: string) {
  if (!passHash) return false;
  const h = crypto.scryptSync(String(p ?? ""), salt, 32);
  return crypto.timingSafeEqual(h, passHash);
}

export function makeCookie() {
  const exp = Date.now() + TTL_MS;
  const payload = `${exp}.${crypto.randomBytes(12).toString("hex")}`;
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL_MS / 1000}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function validSession(cookieHeader: string | undefined) {
  const m = (cookieHeader ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const parts = m[1].split(".");
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  const want = crypto.createHmac("sha256", sessionSecret()).update(`${exp}.${nonce}`).digest("hex");
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  return Number(exp) > Date.now();
}

/** Limite simples de tentativas de login por IP (5 por 15 minutos). */
const attempts = new Map<string, number[]>();
export function loginAllowed(ip: string) {
  const now = Date.now();
  const a = (attempts.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
  attempts.set(ip, a);
  return a.length < 5;
}
export function registerFailure(ip: string) { attempts.set(ip, [...(attempts.get(ip) ?? []), Date.now()]); }
