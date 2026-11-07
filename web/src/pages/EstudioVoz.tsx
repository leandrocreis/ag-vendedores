import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useData, Action, Chip, Field, useToast, stateChip, Waveform } from "../components/ui";

type Setting = { engine: string; voice: string; speed: number; language: string; instruction?: string; recipe?: any[] };
const favKey = "ese.vozes.favoritas";
const loadFav = (): string[] => { try { return JSON.parse(localStorage.getItem(favKey) ?? "[]"); } catch { return []; } };

export function EstudioVoz() {
  const engines = useData<any[]>("/api/voz/motores");
  const [engineId, setEngineId] = useState("kokoro");
  const voices = useData<any[]>(`/api/voz/vozes?engine=${engineId}`, [engineId]);
  const profiles = useData<any[]>("/api/voz/perfis");
  const recipes = useData<any[]>("/api/voz/receitas");
  const [lang, setLang] = useState("pt-br");
  const [q, setQ] = useState("");
  const [fav, setFav] = useState<string[]>(loadFav());
  const [text, setText] = useState("Você acorda com o zíper da sua barraca abrindo sozinho. Lá fora, a fogueira ainda estala… mas ninguém responde.");
  const [A, setA] = useState<Setting>({ engine: "kokoro", voice: "pm_alex", speed: 1, language: "pt-br" });
  const [Bs, setB] = useState<Setting>({ engine: "kokoro", voice: "pf_dora", speed: 1, language: "pt-br" });
  const [ra, setRa] = useState<any>(null);
  const [rb, setRb] = useState<any>(null);
  const eng = engines.data?.find((e) => e.id === engineId);
  const toast = useToast();
  useEffect(() => { try { localStorage.setItem(favKey, JSON.stringify(fav)); } catch {} }, [fav]);
  const shown = (voices.data ?? []).filter((v) => (!lang || v.language === lang) && (!q || v.name.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => Number(fav.includes(b.id)) - Number(fav.includes(a.id)));
  // volume equivalente no A/B: atenua o mais alto até a loudness do mais baixo (sem normalizar o arquivo)
  const vol = (me: any, other: any) => (me && other && Number.isFinite(me.loudness) && Number.isFinite(other.loudness) && me.loudness > other.loudness ? Math.pow(10, (other.loudness - me.loudness) / 20) : 1);
  return (
    <div className="fade">
      <h1>Estúdio de voz</h1>
      <div className="sub">Escolha, compare, clone (com autorização) e combine vozes antes de gerar o episódio. Cada amostra é gerada agora, com o seu texto e a configuração exata exibida.</div>
      <div className="grid g3">
        {engines.data?.map((e) => <div key={e.id} className={`card ${engineId === e.id ? "hl" : ""}`} onClick={() => setEngineId(e.id)} style={{ cursor: "pointer" }}>
          <div className="row"><b>{e.name}</b>{stateChip(e.status.state)}</div><div className="tiny muted">{e.status.detail}</div><div className="tiny" style={{ marginTop: 4 }}>{e.license} · pesos: {e.weightsLicense}</div><div className="tiny muted">{e.local ? "Roda localmente" : "Serviço externo"}</div></div>)}
      </div>
      <div className="grid" style={{ gridTemplateColumns: "300px 1fr 340px", marginTop: 16, alignItems: "start" }}>
        <div className="card"><h3>Catálogo de vozes</h3>
          <div className="row"><input placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} /><select value={lang} onChange={(e) => setLang(e.target.value)}><option value="">Todos idiomas</option>{[...new Set((voices.data ?? []).map((v) => v.language))].map((l) => <option key={l}>{l}</option>)}</select></div>
          <div style={{ maxHeight: 520, overflowY: "auto", marginTop: 8 }}>{shown.map((v) => <div key={v.id} className="seg" style={{ padding: 8 }}>
            <div className="row"><b>{v.name}</b><span className="tiny muted">{v.accent ?? v.language} · {v.gender}</span><span className="sp" /><button style={{ padding: "2px 8px" }} onClick={() => setFav(fav.includes(v.id) ? fav.filter((x) => x !== v.id) : [...fav, v.id])}>{fav.includes(v.id) ? "★" : "☆"}</button></div>
            <div className="row"><button onClick={() => setA({ ...A, engine: engineId, voice: v.id, language: v.language })}>→ A</button><button onClick={() => setB({ ...Bs, engine: engineId, voice: v.id, language: v.language })}>→ B</button><code className="tiny">{v.id}</code></div></div>)}</div>
          {engineId === "kokoro" && <div className="tiny muted">Português disponível no Kokoro: apenas pt-BR (pf_dora, pm_alex, pm_santa). Sotaques não suportados não são oferecidos.</div>}
        </div>
        <div className="card"><h3>Texto e comparação A/B</h3>
          <textarea value={text} onChange={(e) => setText(e.target.value)} />
          <div className="grid g2" style={{ marginTop: 10 }}>
            {([["A", A, setA, ra, setRa, rb], ["B", Bs, setB, rb, setRb, ra]] as const).map(([k, st, set, res, setRes, other]: any) => <div key={k} className="card" style={{ background: "var(--card2)" }}>
              <div className="row"><b>{k}</b><code className="tiny">{st.engine}:{st.voice}</code></div>
              <Field label={`Velocidade ${st.speed.toFixed(2)}×`}><input type="range" min={0.7} max={1.3} step={0.01} value={st.speed} onChange={(e) => set({ ...st, speed: Number(e.target.value) })} /></Field>
              <Action onRun={async () => setRes(await api.post("/api/voz/amostra", { setting: st, text }))}>▶ Ouvir com meu texto</Action>
              {res && <><audio controls src={res.url} ref={(el) => { if (el) el.volume = vol(res, other); }} /><Waveform src={res.url} /><div className="tiny muted">{res.duration.toFixed(1)} s · {Number.isFinite(res.loudness) ? `${res.loudness} LUFS` : ""} · controles: {Object.entries(res.controlsApplied).map(([a, b]) => `${a} (${b})`).join(", ")}</div></>}
            </div>)}
          </div>
          {ra && rb && <div className="tiny muted" style={{ marginTop: 6 }}>Volume de reprodução equalizado pelo nível medido (o mais alto é atenuado); os arquivos não são alterados.</div>}
          <Mixer engineId={engineId} voices={voices.data ?? []} text={text} onSaved={() => recipes.reload()} eng={eng} />
        </div>
        <div><div className="card"><h3>Direção interpretativa — {eng?.name}</h3>
          <table><tbody>{eng && Object.entries(eng.controls).map(([k, c]: any) => <tr key={k}><td className="small">{k}</td><td><Chip kind={c.support === "nativo" ? "ok" : c.support === "indisponível" ? "lock" : "info"}>{c.support}</Chip></td></tr>)}</tbody></table>
          <div className="tiny muted" style={{ marginTop: 6 }}>Passe o mouse para ver o motivo. Controles indisponíveis ficam desabilitados; mudar pitch não muda sotaque.</div>
          {eng && <details style={{ marginTop: 6 }}><summary className="small">Detalhes</summary>{Object.entries(eng.controls).map(([k, c]: any) => <p key={k} className="tiny"><b>{k}:</b> {c.note}</p>)}</details>}
        </div>
        <Clonar engines={engines.data ?? []} onDone={() => profiles.reload()} />
        <div className="card" style={{ marginTop: 14 }}><h3>Perfis salvos</h3>{profiles.data?.length ? profiles.data.map((p) => <div key={p.id} className="seg"><div className="row"><b>{p.name}</b><Chip>{p.kind}</Chip><span className="sp" /><Action danger confirm="Excluir o perfil e a amostra local?" onRun={async () => { await api.del(`/api/voz/perfis/${p.id}`); profiles.reload(); }}>Excluir</Action></div><div className="tiny muted">{p.engine} · {p.data?.state} · autorização: {p.consent ? `${p.consent.origin}, ${new Date(p.consent.at).toLocaleDateString("pt-BR")}` : "—"}</div></div>) : <div className="tiny muted">Nenhum.</div>}
          <h3 style={{ marginTop: 12 }}>Receitas</h3>{recipes.data?.map((r) => <div key={r.id} className="tiny">{r.name}: {r.parts.map((p: any) => `${p.weight}% ${p.label}`).join(", ")} → {r.translation.mode.join(" + ") || "não suportada"}</div>)}</div>
        </div>
      </div>
    </div>
  );
}

function Mixer({ engineId, voices, text, onSaved, eng }: any) {
  const [parts, setParts] = useState<any[]>([{ label: "narrador grave", weight: 60, voice: "pm_alex" }, { label: "interpretação calma", weight: 25, voice: "pm_santa" }, { label: "suspense", weight: 15, descriptor: "suspense, apreensivo" }]);
  const [tr, setTr] = useState<any>(null);
  const [res, setRes] = useState<any>(null);
  const toast = useToast();
  useEffect(() => { api.post("/api/voz/receita/traduzir", { engine: engineId, parts }).then(setTr).catch(() => setTr(null)); }, [engineId, JSON.stringify(parts)]);
  return <div className="card" style={{ marginTop: 14, background: "var(--card2)" }}><h3>Combinar estilos vocais</h3>
    <div className="tiny muted">Percentuais são uma interface editorial. Abaixo, exatamente como viram parâmetros do motor.</div>
    {parts.map((p, i) => <div key={i} className="slider" style={{ marginTop: 6 }}>
      <input value={p.label} onChange={(e) => setParts(parts.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} />
      <input type="range" min={0} max={100} value={p.weight} onChange={(e) => setParts(parts.map((x, k) => (k === i ? { ...x, weight: Number(e.target.value) } : x)))} />
      <span>{p.weight}%</span>
      <select value={p.voice ?? ""} onChange={(e) => setParts(parts.map((x, k) => (k === i ? { ...x, voice: e.target.value || undefined, descriptor: e.target.value ? undefined : x.label } : x)))} style={{ gridColumn: "1 / span 3" }}><option value="">(descritor de interpretação, não uma voz)</option>{voices.map((v: any) => <option key={v.id} value={v.id}>{v.name} ({v.id})</option>)}</select>
    </div>)}
    <div className="row" style={{ marginTop: 6 }}><button onClick={() => setParts([...parts, { label: "nova parte", weight: 10, descriptor: "calma" }])}>＋ parte</button></div>
    {tr && <div className="banner small">Modo: <b>{tr.mode.join(" + ") || "nenhum"}</b>{tr.blend && <div>Mistura de embeddings: {tr.blend.map((b: any) => `${b.voice} ${(b.weight * 100).toFixed(0)}%`).join(" + ")}</div>}{tr.instruction && <div>Instrução textual: “{tr.instruction}”</div>}{tr.unsupported.map((u: string) => <div key={u} style={{ color: "var(--warn)" }}>{u}</div>)}</div>}
    <div className="row"><Action disabled={!tr || !tr.mode.length} onRun={async () => setRes(await api.post("/api/voz/amostra", { setting: { engine: engineId, voice: parts.find((p) => p.voice)?.voice ?? "pm_alex", speed: 1, language: "pt-br", recipe: parts }, text }))}>▶ Ouvir receita</Action>
      <Action onRun={async () => { const name = prompt("Nome da receita"); if (!name) return; await api.post("/api/voz/receitas", { name, engine: engineId, parts }); toast("Receita salva com a tradução para o motor."); onSaved(); }}>Salvar receita</Action></div>
    {res && <audio controls src={res.url} />}
    {eng?.controls["mistura de vozes"]?.support === "indisponível" && <div className="tiny" style={{ color: "var(--warn)" }}>{eng.controls["mistura de vozes"].note}</div>}
  </div>;
}

function Clonar({ engines, onDone }: any) {
  const [file, setFile] = useState<File | null>(null);
  const [q, setQ] = useState<any>(null);
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [auth, setAuth] = useState(false);
  const [name, setName] = useState("Minha voz");
  const [origin, setOrigin] = useState("gravação própria");
  const [refText, setRefText] = useState("");
  const chunks = useRef<Blob[]>([]);
  const toast = useToast();
  const vs = engines.find((e: any) => e.id === "voicestudio");
  async function analyze(f: File) { const fd = new FormData(); fd.append("file", f); setQ(await api.upload("/api/voz/analisar-referencia", fd)); }
  return <div className="card" style={{ marginTop: 14 }}><h3>Clonar e criar vozes</h3>
    <div className="tiny muted">Requisitos do motor (VoiceStudio/OmniVoice): fala limpa de ~6–30 s, um único falante, sem música. A amostra fica neste computador.</div>
    <div className="row" style={{ marginTop: 6 }}>
      <label className="btn" style={{ margin: 0 }}>⬆ Enviar amostra<input type="file" accept="audio/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); analyze(f).catch((er) => toast(er, true)); } }} /></label>
      {!rec ? <button onClick={async () => { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); const r = new MediaRecorder(s); chunks.current = []; r.ondataavailable = (e) => chunks.current.push(e.data); r.onstop = () => { s.getTracks().forEach((t) => t.stop()); const f = new File(chunks.current, "gravacao.webm", { type: "audio/webm" }); setFile(f); analyze(f).catch((er) => toast(er, true)); }; r.start(); setRec(r); }}>● Gravar</button> : <button onClick={() => { rec.stop(); setRec(null); }}>■ Parar</button>}
    </div>
    {file && <audio controls src={URL.createObjectURL(file)} />}
    {q && <div className={`banner ${q.issues.length ? "warn" : "ok"} small`}>{q.duration.toFixed(1)} s · relação fala/ruído ≈ {q.snrDb.toFixed(0)} dB · pico {q.peakDb.toFixed(1)} dBFS · silêncio {(q.silentRatio * 100).toFixed(0)}%<div>{q.issues.length ? q.issues.join(" ") : "Sem problemas detectados."}</div><div className="tiny">Múltiplos falantes: {q.multiSpeaker}</div></div>}
    <Field label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
    <Field label="Origem da amostra"><input value={origin} onChange={(e) => setOrigin(e.target.value)} /></Field>
    <Field label="Transcrição da amostra (ajuda o motor)"><input value={refText} onChange={(e) => setRefText(e.target.value)} /></Field>
    <label className="row" style={{ margin: "8px 0" }}><input type="checkbox" style={{ width: "auto" }} checked={auth} onChange={(e) => setAuth(e.target.checked)} /> Esta é a minha voz ou tenho autorização do titular para cloná-la.</label>
    <Action primary disabled={!file || !auth} onRun={async () => { const fd = new FormData(); fd.append("name", name); fd.append("origin", origin); fd.append("refText", refText); fd.append("authorized", String(auth)); fd.append("engine", "voicestudio"); fd.append("file", file!); const r = await api.upload("/api/voz/clonar", fd); toast(`Perfil salvo: ${r.state}`); onDone(); }}>Salvar perfil clonado</Action>
    {vs?.status.state !== "disponível" && <div className="tiny" style={{ color: "var(--warn)", marginTop: 6 }}>VoiceStudio indisponível ({vs?.status.detail}). O perfil fica salvo com a amostra e a autorização, pendente de clonagem.</div>}
    <h3 style={{ marginTop: 12 }}>Criar voz por descrição</h3>
    <Action disabled={vs?.status.state !== "disponível"} title={vs?.status.state !== "disponível" ? "Exige um motor com voice design (VoiceStudio/OmniVoice)" : ""} onRun={async () => { const instruct = prompt("Descreva a voz (tags de voice design, ex.: male, low pitch, calm)"); if (!instruct) return; await api.post("/api/voz/design", { name: `Voz: ${instruct.slice(0, 20)}`, instruct, language: "pt-BR" }); onDone(); }}>Criar por descrição</Action>
  </div>;
}
