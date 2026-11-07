/** Cliente da API local. Toda escrita leva o cabeçalho x-ese (proteção CSRF do backend). */
export class ApiError extends Error { constructor(msg: string, public status: number, public nextAction?: string | null) { super(msg); } }
async function req<T>(method: string, url: string, body?: unknown, form?: FormData): Promise<T> {
  const r = await fetch(url, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method !== "GET" ? { "x-ese": "1" } : {}) }, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!r.ok) throw new ApiError((data as any)?.error ?? `HTTP ${r.status}`, r.status, (data as any)?.nextAction);
  return data as T;
}
export const api = {
  get: <T = any>(u: string) => req<T>("GET", u),
  post: <T = any>(u: string, b: unknown = {}) => req<T>("POST", u, b),
  put: <T = any>(u: string, b: unknown = {}) => req<T>("PUT", u, b),
  patch: <T = any>(u: string, b: unknown = {}) => req<T>("PATCH", u, b),
  del: <T = any>(u: string) => req<T>("DELETE", u),
  upload: <T = any>(u: string, f: FormData) => req<T>("POST", u, undefined, f),
};
export const fmtSec = (s: number) => { const m = Math.floor(s / 60), r = Math.round(s % 60); return `${m}:${String(r).padStart(2, "0")}`; };
export const fmtBytes = (b: number) => (b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : b > 1e6 ? (b / 1e6).toFixed(0) + " MB" : (b / 1e3).toFixed(0) + " KB");
