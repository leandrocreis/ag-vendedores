import { Link } from "react-router-dom";
import { useData, Chip } from "../components/ui";

export function Projetos() {
  const { data } = useData<any[]>("/api/projects");
  const list = (data ?? []).filter((p) => !p.is_test);
  return <div className="fade"><h1>Projetos</h1><div className="sub">Episódios longos, curtos e pacotes. Curtos derivados aparecem ligados ao episódio de origem.</div>
    {list.length ? <table><thead><tr><th>Título</th><th>Tipo</th><th>Estado</th><th>Atualizado</th></tr></thead><tbody>{list.map((p) => <tr key={p.id}><td><Link to={`/projetos/${p.id}`}>{p.title}</Link> {p.is_demo ? <Chip kind="info">demonstrativo</Chip> : null}{p.parent_id && <span className="tiny muted"> · derivado</span>}</td><td>{p.kind === "long" ? "Longo 16:9" : p.kind === "short" ? "Curto 9:16" : "Pacote"}</td><td>{p.status}</td><td className="small muted">{new Date(p.updated_at).toLocaleString("pt-BR")}</td></tr>)}</tbody></table> : <div className="empty">Nenhum projeto.</div>}
  </div>;
}
