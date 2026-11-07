import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useData, Action, Field } from "../components/ui";

export function Series() {
  const { data, reload } = useData<any[]>("/api/series");
  const projects = useData<any[]>("/api/projects");
  const [t, setT] = useState(""); const [p, setP] = useState("");
  return <div className="fade"><h1>Séries</h1><div className="sub">Temporadas, episódios, resumo do anterior e continuidade dos personagens. Escolhas do público só entram se você inserir a escolha e a origem — nunca inventamos uma votação.</div>
    <div className="card"><div className="grid g2"><Field label="Título da série"><input value={t} onChange={(e) => setT(e.target.value)} /></Field><Field label="Premissa"><input value={p} onChange={(e) => setP(e.target.value)} /></Field></div>
      <Action primary disabled={!t} onRun={async () => { await api.post("/api/series", { title: t, premise: p }); setT(""); setP(""); reload(); }}>Criar série</Action></div>
    {data?.map((s) => <div key={s.id} className="card" style={{ marginTop: 12 }}><h3>{s.title}</h3><div className="small muted">{s.premise}</div>
      <table><tbody>{s.episodes.map((e: any) => <tr key={e.id}><td>T{e.season}E{e.number}</td><td>{e.project_id ? <Link to={`/projetos/${e.project_id}`}>{e.title}</Link> : "—"}</td><td className="small">{e.recap ?? <span className="muted">sem resumo</span>}</td><td className="small">{e.audience_choice ? `${e.audience_choice} (fonte: ${e.audience_choice_source})` : ""}</td></tr>)}</tbody></table>
      <EpForm s={s} projects={(projects.data ?? []).filter((x) => !x.is_test)} reload={reload} /></div>)}
  </div>;
}
function EpForm({ s, projects, reload }: any) {
  const [f, setF] = useState<any>({ projectId: "", recap: "", audienceChoice: "", audienceChoiceSource: "" });
  return <div className="grid g4" style={{ marginTop: 8, alignItems: "end" }}>
    <Field label="Projeto"><select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">—</option>{projects.map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
    <Field label="Resumo do anterior"><input value={f.recap} onChange={(e) => setF({ ...f, recap: e.target.value })} /></Field>
    <Field label="Escolha do público (opcional)"><input value={f.audienceChoice} onChange={(e) => setF({ ...f, audienceChoice: e.target.value })} /></Field>
    <Field label="Origem da escolha"><input value={f.audienceChoiceSource} onChange={(e) => setF({ ...f, audienceChoiceSource: e.target.value })} placeholder="ex.: enquete da comunidade, 07/11" /></Field>
    <Action onRun={async () => { await api.post(`/api/series/${s.id}/episodios`, f); reload(); }}>Adicionar episódio</Action></div>;
}
