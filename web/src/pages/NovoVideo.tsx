import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useData, useToast, Field } from "../components/ui";

const GENRES = ["sobrevivência", "mistério", "ficção científica", "fantasia", "aventura", "humor", "terror"];

export function NovoVideo() {
  const nav = useNavigate();
  const toast = useToast();
  const [sp] = useSearchParams();
  const styles = useData<any[]>("/api/estilos");
  const series = useData<any[]>("/api/series");
  const [f, setF] = useState<any>({
    title: "", premise: "", genre: "sobrevivência", audience: "jovens e adultos", language: "pt-BR", perspective: "segunda pessoa",
    mode: "long", minutes: 7, customSeconds: "", shortSeconds: 45, shortsCount: 3, styleId: sp.get("estilo") ?? "autoral:cartoon-narrativo", visualMode: "codigo",
    suspense: 7, violence: 3, wpm: 150, music: "tensa e discreta", aiEnabled: false, aiWhere: "", aiModel: "", aiBudget: 0, budgetUsd: 5, freeText: "", links: "",
    serieMode: "independente", seriesId: "",
  });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.type === "number" || e.target.type === "range" ? Number(e.target.value) : e.target.value });
  const target = f.mode === "short" ? f.shortSeconds : f.customSeconds ? Number(f.customSeconds) : f.minutes * 60;
  async function create() {
    try {
      if (f.mode !== "short" && (target < 300 || target > 600)) throw new Error("O longo precisa ter entre 300 e 600 segundos.");
      if (f.aiEnabled && !f.aiWhere) throw new Error("Escolha onde gerar as cenas por IA.");
      const kind = f.mode === "short" ? "short" : f.mode === "package" ? "package" : "long";
      const r = await api.post("/api/projects", {
        kind, title: f.title || undefined,
        settings: {
          premise: f.premise, genre: f.genre, audience: f.audience, language: f.language, perspective: f.perspective, targetSeconds: target,
          toleranceSeconds: f.mode === "short" ? 5 : 20, styleId: f.styleId, visualMode: f.visualMode, suspense: f.suspense, violence: f.violence,
          voice: { wpm: f.wpm }, music: f.music, shortsCount: kind === "package" ? f.shortsCount : 0,
          aiScenes: { enabled: f.aiEnabled, where: f.aiEnabled ? f.aiWhere : undefined, model: f.aiModel || undefined, budgetUsd: f.aiBudget },
          budgetUsd: f.budgetUsd, freeText: f.freeText, referenceLinks: f.links.split(/\s+/).filter(Boolean), mode: f.serieMode, seriesId: f.seriesId || undefined,
        },
      });
      nav(`/projetos/${r.id}`);
    } catch (e: any) { toast(e, true); }
  }
  const st = (styles.data ?? []).find((s) => s.id === f.styleId);
  return (
    <div className="fade" style={{ maxWidth: 980 }}>
      <h1>Novo vídeo</h1>
      <div className="sub">Ideia → formato e estilo → roteiro → voz → <b>narração aprovada</b> → storyboard → cenas → som → exportação. As cenas só são produzidas depois que você aprovar o áudio.</div>
      <div className="card">
        <h3>1. A ideia</h3>
        <Field label="Premissa (“E se…?”)"><textarea value={f.premise} onChange={set("premise")} placeholder="E se um apocalipse zumbi começasse enquanto você estivesse acampando?" /></Field>
        <div className="grid g3">
          <Field label="Gênero"><select value={f.genre} onChange={set("genre")}>{GENRES.map((g) => <option key={g}>{g}</option>)}</select></Field>
          <Field label="Público"><input value={f.audience} onChange={set("audience")} /></Field>
          <Field label="Idioma"><select value={f.language} onChange={set("language")}><option value="pt-BR">Português (Brasil)</option><option value="en-US">Inglês (EUA)</option><option value="es">Espanhol</option></select></Field>
          <Field label="Perspectiva"><select value={f.perspective} onChange={set("perspective")}><option>segunda pessoa</option><option>primeira pessoa</option><option>terceira pessoa</option></select></Field>
          <Field label={`Suspense: ${f.suspense}/10`}><input type="range" min={0} max={10} value={f.suspense} onChange={set("suspense")} /></Field>
          <Field label={`Violência: ${f.violence}/10`}><input type="range" min={0} max={10} value={f.violence} onChange={set("violence")} /></Field>
        </div>
        <div className="grid g2">
          <Field label="Texto livre / observações"><textarea value={f.freeText} onChange={set("freeText")} /></Field>
          <Field label="Links de referência (um por linha)" hint="Usados só para estudar recursos narrativos; nada é copiado."><textarea value={f.links} onChange={set("links")} /></Field>
        </div>
        <div className="grid g2">
          <Field label="História"><select value={f.serieMode} onChange={set("serieMode")}><option value="independente">Independente</option><option value="serie">Episódio de série</option></select></Field>
          {f.serieMode === "serie" && <Field label="Série"><select value={f.seriesId} onChange={set("seriesId")}><option value="">—</option>{(series.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></Field>}
        </div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>2. Formato</h3>
        <div className="row">{[["long", "Longo 16:9 (5–10 min)"], ["short", "Curto independente 9:16"], ["package", "Pacote: longo + curtos"]].map(([k, l]) => <button key={k} className={f.mode === k ? "primary" : ""} onClick={() => setF({ ...f, mode: k })}>{l}</button>)}</div>
        {f.mode !== "short" ? <div className="row" style={{ marginTop: 10 }}>{[5, 7, 10].map((m) => <button key={m} className={!f.customSeconds && f.minutes === m ? "primary" : ""} onClick={() => setF({ ...f, minutes: m, customSeconds: "" })}>{m} min</button>)}
          <input style={{ width: 200 }} type="number" min={300} max={600} placeholder="personalizado (s)" value={f.customSeconds} onChange={set("customSeconds")} /></div>
          : <div className="row" style={{ marginTop: 10 }}>{[15, 30, 45, 60, 90].map((s) => <button key={s} className={f.shortSeconds === s ? "primary" : ""} onClick={() => setF({ ...f, shortSeconds: s })}>{s} s</button>)}</div>}
        {f.mode === "package" && <Field label="Quantidade de curtos derivados"><input type="number" min={0} max={10} value={f.shortsCount} onChange={set("shortsCount")} /></Field>}
        <p className="small muted">Meta: {target} s de narração · ~{Math.round(target * 0.92 * f.wpm / 60)} palavras a {f.wpm} palavras/min. A duração real é medida no áudio e ajustada pelo roteiro.</p>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>3. Estilo e produção visual</h3>
        <div className="grid g2">
          <Field label="Estilo" hint={st ? `${st.collection} · ${st.restrictions?.[0] ?? ""}` : ""}><select value={f.styleId} onChange={set("styleId")}>{(styles.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.namePt} — {s.nameOriginal} ({s.collection})</option>)}</select></Field>
          <Field label="Modo visual" hint="Animação por código desenha tudo no motor; camadas usa imagens (OpenAI ou suas) com parallax; híbrido mistura."><select value={f.visualMode} onChange={set("visualMode")}><option value="codigo">Animação por código</option><option value="camadas">Imagens animadas em camadas</option><option value="hibrido">Híbrido</option></select></Field>
          <Field label="Música (descrição)"><input value={f.music} onChange={set("music")} /></Field>
          <Field label="Orçamento máximo do projeto (US$)" hint="Gerações pagas pausam antes de ultrapassar."><input type="number" min={0} value={f.budgetUsd} onChange={set("budgetUsd")} /></Field>
        </div>
        <label style={{ marginTop: 14 }}>O vídeo terá cenas geradas por IA?</label>
        <div className="row"><button className={!f.aiEnabled ? "primary" : ""} onClick={() => setF({ ...f, aiEnabled: false })}>Não — só animação por código/camadas</button><button className={f.aiEnabled ? "primary" : ""} onClick={() => setF({ ...f, aiEnabled: true })}>Sim, em cenas que eu escolher</button></div>
        {f.aiEnabled && <div className="grid g3">
          <Field label="Onde gerar"><select value={f.aiWhere} onChange={set("aiWhere")}><option value="">Escolha…</option><option value="local">Minha máquina (GPU local)</option><option value="runpod">RunPod (endpoint Serverless seu)</option></select></Field>
          <Field label="Modelo" hint="Padrão: Wan2.1 T2V 1.3B (Apache-2.0)"><input value={f.aiModel} onChange={set("aiModel")} placeholder="Wan-AI/Wan2.1-T2V-1.3B-Diffusers" /></Field>
          <Field label="Orçamento para IA (US$)"><input type="number" min={0} value={f.aiBudget} onChange={set("aiBudget")} /></Field>
        </div>}
      </div>
      <div className="row" style={{ marginTop: 16 }}><button className="primary" disabled={f.premise.length < 5} onClick={create}>Criar projeto e ir para o roteiro →</button></div>
    </div>
  );
}
