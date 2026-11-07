import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DATA_DIR } from "./paths.js";

/**
 * Segredos ficam SOMENTE no backend. Ordem: variável de ambiente → cofre do sistema
 * (@napi-rs/keyring: Keychain/Credential Manager/Secret Service) → arquivo local 0600
 * (data/segredos.json), identificado na interface como alternativa menos segura.
 * Nenhuma função devolve o valor ao frontend: só `mask()` e `hasSecret()`.
 */
export const SECRET_NAMES = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  runpod: "RUNPOD_API_KEY",
  muapi: "MUAPI_API_KEY",
  voicestudio: "OMNIVOICE_API_KEY",
} as const;
export type SecretName = keyof typeof SECRET_NAMES;

const SERVICE = "e-se-studio";
const FILE = path.join(DATA_DIR, "segredos.json");
const require = createRequire(import.meta.url);

type Backend = "env" | "keyring" | "arquivo" | "nenhum";

function keyringEntry(name: string): any | null {
  try {
    const { Entry } = require("@napi-rs/keyring");
    return new Entry(SERVICE, name);
  } catch {
    return null;
  }
}

let keyringWorks: boolean | null = null;
export function keyringAvailable(): boolean {
  if (keyringWorks !== null) return keyringWorks;
  try {
    const e = keyringEntry("__probe__");
    if (!e) return (keyringWorks = false);
    e.setPassword("ok");
    e.deletePassword();
    keyringWorks = true;
  } catch {
    keyringWorks = false;
  }
  return keyringWorks;
}

function readFile(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeFile(o: Record<string, string>) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(o, null, 1), { mode: 0o600 });
  try {
    fs.chmodSync(FILE, 0o600);
  } catch {}
}

export function getSecret(name: SecretName): string | null {
  const env = process.env[SECRET_NAMES[name]];
  if (env && env.trim()) return env.trim();
  if (keyringAvailable()) {
    try {
      const v = keyringEntry(name)?.getPassword();
      if (v) return v;
    } catch {}
  }
  return readFile()[name] ?? null;
}

export function secretBackend(name: SecretName): Backend {
  if (process.env[SECRET_NAMES[name]]?.trim()) return "env";
  if (keyringAvailable()) {
    try {
      if (keyringEntry(name)?.getPassword()) return "keyring";
    } catch {}
  }
  return readFile()[name] ? "arquivo" : "nenhum";
}

export function setSecret(name: SecretName, value: string) {
  const v = value.trim();
  if (!v) throw new Error("Valor vazio");
  if (keyringAvailable()) {
    keyringEntry(name).setPassword(v);
    const f = readFile();
    if (f[name]) {
      delete f[name];
      writeFile(f);
    }
    return "keyring" as const;
  }
  const f = readFile();
  f[name] = v;
  writeFile(f);
  return "arquivo" as const;
}

export function deleteSecret(name: SecretName) {
  if (keyringAvailable()) {
    try {
      keyringEntry(name).deletePassword();
    } catch {}
  }
  const f = readFile();
  delete f[name];
  writeFile(f);
}

export function mask(v: string | null) {
  if (!v) return null;
  return v.length <= 8 ? "••••" : `${v.slice(0, 3)}••••${v.slice(-4)}`;
}

/** Remove qualquer segredo conhecido de um texto (logs, mensagens de erro, manifestos). */
export function redact(text: string): string {
  let out = text;
  for (const n of Object.keys(SECRET_NAMES) as SecretName[]) {
    const v = getSecret(n);
    if (v && v.length >= 6) out = out.split(v).join("[segredo-removido]");
  }
  return out.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{10,}/g, "$1[removido]");
}
