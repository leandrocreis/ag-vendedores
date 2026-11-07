import { Link } from "react-router-dom";
import { useData, useJobEvents, Progress, stateChip, Chip } from "../components/ui";
import { fmtBytes } from "../api";

export function Painel() {
  const { data, reload } = useData<any>("/api/painel");
  useJobEvents(() => reload());
  if (!data) return <p className="muted">Carregando…</p>;
  const costs = data.costs as any[];
  const sum = (k: string) => costs.filter((c) => c.kind === k).reduce((s, c) => s + (c.usd ?? 0), 0);
  return (
    <div className="fade">
      <h1>Painel</h1>
      <div className="sub">Projetos recentes, produção em andamento e o que precisa da sua atenção.</div>
      <div className="row" style={{ marginBottom: 16 }}>
        <Link to="/novo"><button className="primary">＋ Novo vídeo</button></Link>
        <Link to="/estilos"><button>◐ Ver estilos</button></Link>
        <Link to="/voz"><button>🎙 Estúdio de voz</button></Link>
      </div>
      <div className="grid g4">
        <div className="card"><div className="muted small">Em produção</div><h1>{data.running.length}</h1><div className="tiny muted">{data.queued.length} na fila</div></div>
        <div className="card"><div className="muted small">Falhas (7 dias)</div><h1 style={{ color: data.failed.length ? "var(--err)" : undefined }}>{data.failed.length}</h1></div>
        <div className="card"><div className="muted small">Espaço ocupado</div><h1>{fmtBytes(data.storage.projetosBytes)}</h1><div className="tiny muted">cache {fmtBytes(data.storage.cacheBytes)} · modelos {fmtBytes(data.storage.modelosBytes)}</div></div>
        <div className="card"><div className="muted small">Custos</div>
          <div>Estimado: <b>US$ {sum("estimado").toFixed(2)}</b></div><div>Confirmado: <b>US$ {sum("confirmado").toFixed(2)}</b></div>
          <div className="tiny muted">{costs.filter((c) => c.kind === "indisponível").reduce((s, c) => s + c.n, 0)} chamada(s) com custo indisponível</div></div>
      </div>
      <h2>Projetos recentes</h2>
      {data.projects.length ? <div className="cards">{data.projects.map((p: any) => (
        <Link key={p.id} to={`/projetos/${p.id}`} className="card" style={{ color: "inherit" }}>
          <div className="row"><b>{p.title}</b>{p.is_demo ? <Chip kind="info">demonstrativo</Chip> : null}</div>
          <div className="small muted">{p.kind === "long" ? "Longo 16:9" : p.kind === "short" ? "Curto 9:16" : "Pacote"} · {p.status}</div>
        </Link>))}</div> : <div className="empty">Nenhum projeto ainda. Comece em “Novo vídeo”.</div>}
      {data.running.length > 0 && <><h2>Produzindo agora</h2>{data.running.map((j: any) => <div className="card" key={j.id} style={{ marginBottom: 8 }}><div className="row"><b>{j.type}</b>{stateChip(j.status)}</div><Progress value={j.progress} label={j.progress_label} estimated={!!j.progress_estimated} /></div>)}</>}
      {data.failed.length > 0 && <><h2>Falhas que precisam de atenção</h2><table><tbody>{data.failed.map((j: any) => <tr key={j.id}><td>{j.type}</td><td className="small">{j.error}</td><td><Link to="/fila">abrir fila</Link></td></tr>)}</tbody></table></>}
    </div>
  );
}
