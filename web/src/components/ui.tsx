import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api";

/* ---------------------------- avisos (toasts) ---------------------------- */
type Toast = { id: number; text: string; err?: boolean; next?: string | null };
const ToastCtx = createContext<(t: string | Error, err?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((t: string | Error, err = false) => {
    const id = Date.now() + Math.random();
    const isErr = err || t instanceof Error;
    setList((l) => [...l, { id, text: t instanceof Error ? t.message : t, err: isErr, next: t instanceof ApiError ? t.nextAction : null }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), isErr ? 9000 : 4000);
  }, []);
  return <ToastCtx.Provider value={push}>{children}{list.map((t, i) => (
    <div key={t.id} className={`toast fade ${t.err ? "err" : ""}`} style={{ bottom: 18 + i * 74 }}>
      {t.text}{t.next && <div className="small" style={{ marginTop: 4 }}>Próxima ação: <b>{t.next}</b></div>}
    </div>))}</ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

/* -------------------------- dados com recarga -------------------------- */
export function useData<T = any>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!url) return;
    try { setData(await api.get<T>(url)); setError(null); } catch (e: any) { setError(e.message); }
  }, [url]);
  useEffect(() => { load(); }, [load, ...deps]);
  return { data, error, reload: load, setData };
}

/** Assina o fluxo de eventos de jobs (SSE) do backend. */
export function useJobEvents(onChange?: (jobs: any[]) => void) {
  const [jobs, setJobs] = useState<any[]>([]);
  const cb = useRef(onChange); cb.current = onChange;
  useEffect(() => {
    const es = new EventSource("/api/eventos");
    es.onmessage = (e) => { const j = JSON.parse(e.data); setJobs(j); cb.current?.(j); };
    return () => es.close();
  }, []);
  return jobs;
}

/** Botão que executa uma ação assíncrona e mostra o erro/próxima ação. */
export function Action({ onRun, children, primary, danger, disabled, title, confirm }: { onRun: () => Promise<unknown>; children: ReactNode; primary?: boolean; danger?: boolean; disabled?: boolean; title?: string; confirm?: string }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return <button className={primary ? "primary" : danger ? "danger" : ""} disabled={disabled || busy} title={title} onClick={async () => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    try { const r: any = await onRun(); if (r?.job) toast(`Enviado para a fila de produção (${r.job.type}).`); } catch (e: any) { toast(e, true); } finally { setBusy(false); }
  }}>{busy ? "⏳ " : ""}{children}</button>;
}

export function Chip({ kind, children }: { kind?: "ok" | "warn" | "err" | "info" | "lock"; children: ReactNode }) { return <span className={`chip ${kind ?? ""}`}>{children}</span>; }

export function stateChip(s: string) {
  const k = ({ "concluído": "ok", "produzindo": "info", "em fila": "info", "falhou": "err", "cancelado": "lock", "pausado": "warn", "disponível": "ok", "precisa instalar": "warn", "precisa configurar": "warn", "incompatível": "err", "não suportado": "lock" } as any)[s];
  return <Chip kind={k}>{s}</Chip>;
}

export function Progress({ value, label, estimated }: { value: number; label?: string | null; estimated?: boolean }) {
  return <div><div className="bar"><i style={{ width: `${Math.round(value * 100)}%` }} /></div>{label && <div className="tiny muted" style={{ marginTop: 4 }}>{label} · {Math.round(value * 100)}%{estimated ? " (estimado)" : ""}</div>}</div>;
}

/** Forma de onda desenhada a partir do arquivo real (Web Audio). */
export function Waveform({ src, marks = [], duration, onSeek }: { src: string; marks?: { t: number; color?: string }[]; duration?: number; onSeek?: (t: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [dur, setDur] = useState(duration ?? 0);
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer();
        const ac = new OfflineAudioContext(1, 1, 8000);
        const audio = await ac.decodeAudioData(buf);
        const ch = audio.getChannelData(0); const n = 900; const step = Math.max(1, Math.floor(ch.length / n));
        const p: number[] = [];
        for (let i = 0; i < n; i++) { let m = 0; for (let k = i * step; k < (i + 1) * step && k < ch.length; k++) m = Math.max(m, Math.abs(ch[k])); p.push(m); }
        if (!cancel) { setPeaks(p); setDur(audio.duration); }
      } catch { if (!cancel) setPeaks([]); }
    })();
    return () => { cancel = true; };
  }, [src]);
  useEffect(() => {
    const c = ref.current; if (!c || !peaks) return;
    const w = (c.width = c.clientWidth * 2), h = (c.height = 128); const g = c.getContext("2d")!;
    g.fillStyle = "#0f1219"; g.fillRect(0, 0, w, h); g.fillStyle = "#7dd3fc";
    peaks.forEach((p, i) => { const x = (i / peaks.length) * w; const y = p * h * 0.48; g.fillRect(x, h / 2 - y, Math.max(1, w / peaks.length - 0.5), y * 2); });
    for (const m of marks) { g.fillStyle = m.color ?? "#f59e0b"; g.fillRect((m.t / (dur || 1)) * w, 0, 2, h); }
  }, [peaks, marks, dur]);
  return <canvas className="wave" ref={ref} onClick={(e) => { const r = (e.target as HTMLCanvasElement).getBoundingClientRect(); onSeek?.(((e.clientX - r.left) / r.width) * dur); }} title={peaks ? "Clique para posicionar" : "Carregando forma de onda…"} />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div><label>{label}</label>{children}{hint && <div className="tiny muted" style={{ marginTop: 3 }}>{hint}</div>}</div>;
}
