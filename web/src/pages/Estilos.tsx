import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useData, Action, Chip, useToast } from "../components/ui";

const PAGE = 24;

export function Estilos() {
  const { data, reload } = useData<any[]>("/api/estilos");
  const reports = useData<any[]>("/api/estilos/relatorios");
  const [q, setQ] = useState("");
  const [col, setCol] = useState("");
  const [cat, setCat] = useState("");
  const [fav, setFav] = useState(false);
  const [page, setPage] = useState(0);
  const [cmp, setCmp] = useState<string[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const toast = useToast();
  const nav = useNavigate();
  const cols = useMemo(() => [...new Set((data ?? []).map((s) => s.collection))], [data]);
  const cats = useMemo(() => [...new Set((data ?? []).filter((s) => !col || s.collection === col).map((s) => s.categoryPt))], [data, col]);
  const list = (data ?? []).filter((s) => (!col || s.collection === col) && (!cat || s.categoryPt === cat) && (!fav || s.favorite) && (!q || `${s.namePt} ${s.nameOriginal} ${s.description} ${s.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (a.source === "autoral" ? -1 : 0));
  const pages = Math.ceil(list.length / PAGE);
  const shown = list.slice(page * PAGE, page * PAGE + PAGE);
  const comparing = (data ?? []).filter((s) => cmp.includes(s.id));
  return (
    <div className="fade">
      <h1>Estilos</h1>
      <div className="sub">{data?.length ?? "…"} estilos descobertos nos arquivos reais dos repositórios (sem contagem fixa). Miniaturas carregam sob demanda; vídeos só ao tocar, sem som automático.</div>
      <div className="row">
        <input style={{ maxWidth: 280 }} placeholder="Pesquisar…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        <select style={{ maxWidth: 280 }} value={col} onChange={(e) => { setCol(e.target.value); setCat(""); setPage(0); }}><option value="">Todas as coleções</option>{cols.map((c) => <option key={c}>{c}</option>)}</select>
        <select style={{ maxWidth: 260 }} value={cat} onChange={(e) => { setCat(e.target.value); setPage(0); }}><option value="">Todas as categorias</option>{cats.map((c) => <option key={c}>{c}</option>)}</select>
        <label className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: "auto" }} checked={fav} onChange={(e) => setFav(e.target.checked)} /> Favoritos</label>
        <span className="sp" />
        <Action onRun={async () => { const r = await api.post("/api/estilos/atualizar"); toast(`Catálogo atualizado: ${r.added.length} novos, ${r.changed.length} alterados, ${r.removed.length} removidos, ${r.unchanged} iguais.`); reload(); reports.reload(); }}>↻ Atualizar catálogo</Action>
      </div>
      {reports.data?.[0] && <div className="tiny muted" style={{ marginTop: 6 }}>Última atualização {new Date(reports.data[0].created_at).toLocaleString("pt-BR")}: +{reports.data[0].data.added.length} / Δ{reports.data[0].data.changed.length} / −{reports.data[0].data.removed.length}. Projetos já iniciados mantêm a versão fixada.</div>}
      {comparing.length === 2 && <div className="card" style={{ margin: "14px 0" }}><div className="row"><h3>Comparar</h3><span className="sp" /><button onClick={() => setCmp([])}>Fechar</button></div>
        <div className="grid g2">{comparing.map((s) => <div key={s.id}>{s.thumb ? <img className="thumb" src={`/api/estilos/${encodeURIComponent(s.id)}/miniatura`} /> : null}<b>{s.namePt}</b><div className="small muted">{s.nameOriginal} · {s.renderFamily}</div><div className="row">{s.palette.map((c: string) => <span key={c} style={{ width: 22, height: 22, borderRadius: 6, background: c, display: "inline-block" }} />)}</div><p className="small">{s.description}</p></div>)}</div></div>}
      <div className="cards" style={{ marginTop: 14 }}>{shown.map((s) => <div key={s.id} className="card">
        {playing === s.id ? <Demo s={s} /> : s.thumb ? <img className="thumb" loading="lazy" src={`/api/estilos/${encodeURIComponent(s.id)}/miniatura`} alt={s.nameOriginal} /> : <div className="thumb" style={{ display: "grid", placeItems: "center", background: `linear-gradient(135deg, ${s.palette.join(",")})` }}><b style={{ color: "#111" }}>{s.namePt}</b></div>}
        <div className="row" style={{ marginTop: 8 }}><b>{s.namePt}</b>{s.favorite && <span>★</span>}</div>
        <div className="tiny muted">{s.nameOriginal} · {s.collection}</div>
        <div className="small" style={{ marginTop: 4 }}>{s.description.slice(0, 140)}{s.description.length > 140 ? "…" : ""} {s.descriptionLang === "en" && <span className="tiny muted">(descrição original em inglês)</span>}</div>
        <div className="row" style={{ marginTop: 6 }}><Chip kind={s.availability === "disponível" ? "ok" : "warn"}>{s.availability}</Chip><Chip>{s.renderFamily}</Chip>{s.demo && <Chip kind="info">{({ "video-oficial-remoto": "vídeo oficial", "trecho-de-filme-remoto": "trecho do filme", imagem: "só imagem", "demo-local-gerada": "demo local" } as any)[s.demo.kind]}</Chip>}</div>
        {s.restrictions?.length > 0 && <div className="tiny muted" style={{ marginTop: 4 }} title={s.restrictions.join("\n")}>⚠ {s.restrictions[0].slice(0, 110)}…</div>}
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => setPlaying(playing === s.id ? null : s.id)}>{playing === s.id ? "■ Fechar" : "▶ Ver demonstração"}</button>
          <button className="primary" onClick={() => nav(`/novo?estilo=${encodeURIComponent(s.id)}`)}>Usar este estilo</button>
          <Action onRun={async () => { await api.post(`/api/estilos/${encodeURIComponent(s.id)}/favorito`, { on: !s.favorite }); reload(); }}>{s.favorite ? "★" : "☆"} Favoritar</Action>
          <button onClick={() => setCmp(cmp.includes(s.id) ? cmp.filter((x) => x !== s.id) : [...cmp.slice(-1), s.id])}>{cmp.includes(s.id) ? "✓ comparar" : "Comparar"}</button>
          <Action onRun={async () => { const name = prompt("Nome da sua variação pessoal (o original não é alterado):"); if (!name) return; const pal = prompt("Paleta (cores hex separadas por vírgula) — deixe vazio para manter", s.palette.join(",")); await api.post(`/api/estilos/${encodeURIComponent(s.id)}/variacao`, { name, overrides: { palette: pal ? pal.split(",").map((x) => x.trim()) : undefined } }); toast("Variação salva."); }}>Salvar variação</Action>
        </div>
        <div className="tiny muted" style={{ marginTop: 6 }}>Origem: {s.origin.repo} {s.origin.commit ? `@${s.origin.commit.slice(0, 7)}` : ""} · {s.license.media.slice(0, 80)}</div>
      </div>)}</div>
      {pages > 1 && <div className="row" style={{ marginTop: 16, justifyContent: "center" }}><button disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button><span className="muted">{page + 1} / {pages}</span><button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>›</button></div>}
    </div>
  );
}

function Demo({ s }: { s: any }) {
  const [local, setLocal] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const toast = useToast();
  async function genLocal() {
    setWaiting(true);
    try {
      await api.post(`/api/estilos/${encodeURIComponent(s.id)}/demo-local`);
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 2000)); const r = await fetch(`/api/estilos/${encodeURIComponent(s.id)}/demo-local`, { method: "HEAD" }); if (r.ok) { setLocal(`/api/estilos/${encodeURIComponent(s.id)}/demo-local?t=${Date.now()}`); break; } }
    } catch (e: any) { toast(e, true); } finally { setWaiting(false); }
  }
  if (local) return <div><video className="thumb" src={local} autoPlay muted loop playsInline controls /><div className="tiny muted">Demonstração LOCAL gerada pelo nosso motor (família {s.renderFamily}, paleta extraída da miniatura). Não é o filme oficial.</div></div>;
  if (s.demo?.kind === "video-oficial-remoto" || s.demo?.kind === "trecho-de-filme-remoto") {
    const src = s.demo.kind === "trecho-de-filme-remoto" ? `${s.demo.url}#t=${s.demo.start},${s.demo.start + s.demo.duration}` : s.demo.url;
    return <div><video className="thumb" src={src} autoPlay muted playsInline controls preload="none" /><div className="tiny muted">{s.demo.note} (carregado do repositório oficial, internet necessária)</div><button style={{ marginTop: 4 }} disabled={waiting} onClick={genLocal}>{waiting ? "Gerando demo local…" : "Gerar demo local"}</button></div>;
  }
  return <div>{s.thumb && <img className="thumb" src={`/api/estilos/${encodeURIComponent(s.id)}/miniatura`} />}<div className="tiny muted">{s.demo?.note ?? "Sem demonstração."}</div><button style={{ marginTop: 4 }} disabled={waiting} onClick={genLocal}>{waiting ? "Gerando demo local…" : "Gerar demo local"}</button></div>;
}
