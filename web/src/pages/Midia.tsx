import { useData, Chip } from "../components/ui";

export function Midia() {
  const { data } = useData<any[]>("/api/midia");
  const kit = useData<any>("/api/som/creditos");
  return <div className="fade"><h1>Biblioteca de mídia</h1><div className="sub">Imagens, renders, clipes e sons com procedência e licença.</div>
    <div className="cards">{data?.map((a) => <div key={a.id} className="card">
      {a.mime?.startsWith("image/") ? <img className="thumb" loading="lazy" src={a.url} /> : a.mime?.startsWith("video/") ? <video className="thumb" preload="none" controls src={a.url} /> : null}
      <div className="row" style={{ marginTop: 6 }}><Chip>{a.kind}</Chip>{a.scene_key && <Chip kind="info">{a.scene_key}</Chip>}</div>
      <div className="tiny muted">{a.provenance.provider ?? a.provenance.origin ?? (a.provenance.engine ? `motor ${a.provenance.engine}` : "")} {a.provenance.model ?? ""} {a.provenance.license ?? ""}</div></div>)}</div>
    {!data?.length && <div className="empty">Sem mídia ainda.</div>}
    <h2>Créditos dos sons (sons/CREDITOS.txt)</h2><pre style={{ whiteSpace: "pre-wrap" }}>{kit.data?.text ?? "Kit Openverse ainda não baixado (Configurações → Sons)."}</pre>
  </div>;
}
