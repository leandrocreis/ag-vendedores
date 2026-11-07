import { useState } from "react";
import { api } from "../api";
import { useData, useJobEvents, Action, Progress, stateChip } from "../components/ui";

export function Fila() {
  const { data, reload } = useData<any[]>("/api/jobs");
  const [open, setOpen] = useState<any>(null);
  useJobEvents(() => reload());
  return <div className="fade"><h1>Fila de produção</h1><div className="sub">Jobs persistentes: sobrevivem a reinícios. Progresso marcado “estimado” quando não há medida exata. Cancelamento interrompe o processo de verdade.</div>
    <table><thead><tr><th>Tipo</th><th>Projeto</th><th>Estado</th><th style={{ width: 280 }}>Progresso</th><th>Criado</th><th></th></tr></thead><tbody>
      {data?.map((j) => <tr key={j.id}><td><b>{j.type}</b>{j.visual && <div className="tiny muted">visual · master {j.master_id?.slice(0, 10)}</div>}{j.paid ? <div className="tiny" style={{ color: "var(--warn)" }}>pago</div> : null}</td><td className="small">{j.project_id ?? "—"}</td><td>{stateChip(j.status)}</td>
        <td>{["produzindo", "em fila"].includes(j.status) ? <Progress value={j.progress} label={j.progress_label} estimated={!!j.progress_estimated} /> : <span className="tiny muted">{j.error ?? ""}</span>}</td>
        <td className="tiny muted">{new Date(j.created_at).toLocaleString("pt-BR")}</td>
        <td><div className="row">{["em fila", "produzindo", "pausado"].includes(j.status) && <Action danger onRun={async () => { await api.post(`/api/jobs/${j.id}/cancelar`); reload(); }}>Cancelar</Action>}{["falhou", "cancelado", "pausado"].includes(j.status) && <Action onRun={async () => { await api.post(`/api/jobs/${j.id}/retomar`); reload(); }}>Retomar</Action>}<button onClick={async () => setOpen(await api.get(`/api/jobs/${j.id}`))}>Detalhes</button></div></td></tr>)}
    </tbody></table>
    {open && <div className="card" style={{ marginTop: 14 }}><div className="row"><h3>{open.type} · {open.id}</h3><span className="sp" /><button onClick={() => setOpen(null)}>Fechar</button></div>
      {open.remote?.length > 0 && <div className="banner small">Job remoto: {open.remote.map((r: any) => `${r.provider} ${r.remote_id} (${r.status})`).join(", ")} — a retomada consulta este ID, sem reenviar.</div>}
      <pre>{open.events.map((e: any) => `${e.at}  [${e.level}] ${e.message}`).join("\n")}</pre>
      {open.result && <pre>{JSON.stringify(open.result, null, 1).slice(0, 4000)}</pre>}</div>}
  </div>;
}
