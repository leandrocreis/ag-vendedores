import { useState } from "react";
import { api } from "../api";
import { useData, Action, Chip, Field, useToast } from "../components/ui";

export function Configuracoes() {
  const { data, reload } = useData<any>("/api/config");
  const diag = useData<any>("/api/diagnostico");
  const toast = useToast();
  if (!data) return <p className="muted">Carregando…</p>;
  const c = (k: string) => data.config[k].config;
  const save = async (k: string, patch: any) => { await api.put(`/api/config/${k}`, patch); toast("Salvo."); reload(); };
  return <div className="fade" style={{ maxWidth: 1080 }}>
    <h1>Configurações</h1>
    <div className="sub">Chaves ficam só no backend ({data.keyring ? "cofre do sistema operacional" : "cofre indisponível — arquivo local com permissão 0600 ou variáveis de ambiente"}). O frontend vê apenas a versão mascarada.</div>
    <h2>Integrações</h2>
    <div className="grid g2">
      <div className="card"><h3>Anthropic (Claude) — caminho A: API</h3><p className="tiny muted">{data.notes.claude}</p>
        <Secret name="anthropic" s={data.secrets.anthropic} reload={reload} />
        <Field label="Modelo do roteiro" hint="Padrão claude-opus-5-5. Se indisponível, o app avisa — nunca troca em silêncio."><input defaultValue={c("anthropic").model} onBlur={(e) => save("anthropic", { model: e.target.value })} /></Field>
        <Field label="Esforço"><select defaultValue={c("anthropic").effort} onChange={(e) => save("anthropic", { effort: e.target.value })}>{["low", "medium", "high", "xhigh", "max"].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <label className="row" style={{ margin: "8px 0" }}><input type="checkbox" style={{ width: "auto" }} defaultChecked={c("anthropic").allowFallbacks} onChange={(e) => save("anthropic", { allowFallbacks: e.target.checked })} /> Permitir fallback do servidor em caso de recusa (troca de modelo registrada; desligado por padrão)</label>
        <Test k="anthropic" st={data.config.anthropic.status} reload={reload} /></div>
      <div className="card"><h3>OpenAI — imagens</h3><p className="tiny muted">{data.notes.openai}</p>
        <Secret name="openai" s={data.secrets.openai} reload={reload} />
        <ImageModel cur={c("openai").imageModel} save={(m: string) => save("openai", { imageModel: m })} />
        <Field label="Qualidade"><select defaultValue={c("openai").quality} onChange={(e) => save("openai", { quality: e.target.value })}>{data.imageQualities.map((q: string) => <option key={q}>{q}</option>)}</select></Field>
        <Field label="Preço por imagem (US$) para estimativas" hint="Sem este valor, o custo aparece como “indisponível”."><input type="number" step="0.001" defaultValue={c("openai").pricePerImageUsd ?? ""} onBlur={(e) => save("openai", { pricePerImageUsd: e.target.value ? Number(e.target.value) : undefined })} /></Field>
        <Test k="openai" st={data.config.openai.status} reload={reload} /></div>
      <div className="card"><h3>RunPod — cenas por IA</h3><p className="tiny muted">{data.notes.runpod}</p>
        <Secret name="runpod" s={data.secrets.runpod} reload={reload} />
        <div className="grid g2"><Field label="ID do endpoint Serverless"><input defaultValue={c("runpod").endpointId} onBlur={(e) => save("runpod", { endpointId: e.target.value.trim() })} /></Field>
          <Field label="Imagem/versão do worker"><input defaultValue={c("runpod").workerImage} onBlur={(e) => save("runpod", { workerImage: e.target.value })} placeholder="registro/ese-wan-worker:0.1.0" /></Field>
          <Field label="GPU"><input defaultValue={c("runpod").gpu} onBlur={(e) => save("runpod", { gpu: e.target.value })} /></Field>
          <Field label="Concorrência máx."><input type="number" defaultValue={c("runpod").maxConcurrency} onBlur={(e) => save("runpod", { maxConcurrency: Number(e.target.value) })} /></Field>
          <Field label="Timeout por job (s)"><input type="number" defaultValue={c("runpod").timeoutSec} onBlur={(e) => save("runpod", { timeoutSec: Number(e.target.value) })} /></Field>
          <Field label="Preço por segundo (US$)"><input type="number" step="0.00001" defaultValue={c("runpod").pricePerSecondUsd ?? ""} onBlur={(e) => save("runpod", { pricePerSecondUsd: e.target.value ? Number(e.target.value) : undefined })} /></Field></div>
        <div className="tiny muted">Armazenamento: {c("runpod").storagePolicy}</div>
        <Test k="runpod" st={data.config.runpod.status} reload={reload} /></div>
      <div className="card"><h3>Vozes e cenas locais</h3>
        <Field label="URL do VoiceStudio" hint="Somente loopback sem chave; remoto exige OMNIVOICE_API_KEY."><input defaultValue={c("voicestudio").url} onBlur={(e) => save("voicestudio", { url: e.target.value })} /></Field>
        <Secret name="voicestudio" s={data.secrets.voicestudio} reload={reload} label="OMNIVOICE_API_KEY (opcional)" />
        <Test k="voicestudio" reload={reload} /> <Test k="kokoro" reload={reload} />
        <Field label="Modelo de vídeo local"><input defaultValue={c("local_video").model} onBlur={(e) => save("local_video", { model: e.target.value })} /></Field>
        <Test k="local_video" reload={reload} /> <Test k="muapi" reload={reload} /></div>
    </div>
    <h2>Sons</h2>
    <div className="card"><p className="small">Kit de três whooshes do Openverse (CC0/CC BY) em <code>sons/</code> com <code>CREDITOS.txt</code>.</p><Action onRun={() => api.post("/api/som/kit-openverse")}>Buscar/atualizar kit no Openverse</Action></div>
    <h2>Renderização e orçamento</h2>
    <div className="card grid g3">
      <Field label="Qualidade JPEG de captura"><input type="number" defaultValue={c("render").jpegQuality} onBlur={(e) => save("render", { jpegQuality: Number(e.target.value) })} /></Field>
      <Field label="Orçamento padrão por projeto (US$)"><input type="number" defaultValue={c("budget").projectDefaultUsd} onBlur={(e) => save("budget", { projectDefaultUsd: Number(e.target.value) })} /></Field>
      <Field label="Pasta de saída extra (opcional)"><input defaultValue={c("output").exportDir} onBlur={(e) => save("output", { exportDir: e.target.value })} /></Field>
    </div>
    <h2>Diagnóstico da instalação</h2>
    <div className="row"><Action onRun={async () => diag.reload()}>Executar diagnóstico</Action>{diag.data && <span className="small muted">{diag.data.summary.ok} ok · {diag.data.summary.aviso} avisos · {diag.data.summary.falta} faltando</span>}</div>
    <table style={{ marginTop: 8 }}><tbody>{diag.data?.items.map((i: any, k: number) => <tr key={k}><td className="small muted">{i.area}</td><td>{i.item}</td><td><Chip kind={i.state === "ok" ? "ok" : i.state === "aviso" ? "warn" : "err"}>{i.state}</Chip></td><td className="small">{i.detail}</td></tr>)}</tbody></table>
  </div>;
}

function Secret({ name, s, reload, label }: any) {
  const [v, setV] = useState("");
  return <div><label>{label ?? `Chave (${s.envVar})`}</label><div className="row"><input type="password" autoComplete="off" placeholder={s.configured ? `${s.masked} · ${s.backend}` : "não configurada"} value={v} onChange={(e) => setV(e.target.value)} style={{ flex: 1 }} />
    <Action disabled={!v} onRun={async () => { await api.put(`/api/segredos/${name}`, { value: v }); setV(""); reload(); }}>Salvar</Action>{s.configured && s.backend !== "env" && <Action danger onRun={async () => { await api.del(`/api/segredos/${name}`); reload(); }}>Remover</Action>}</div></div>;
}
function Test({ k, st, reload }: any) {
  const [r, setR] = useState<any>(st);
  return <span style={{ display: "inline-block", marginTop: 8, marginRight: 8 }}><Action onRun={async () => { setR(await api.post(`/api/config/${k}/testar`)); reload?.(); }}>Testar {k}</Action>{r && <div className="tiny" style={{ marginTop: 4, color: r.ok || r.state === "disponível" ? "var(--ok)" : "var(--warn)" }}>{r.ok ? `ok — ${r.model ?? ""} ${r.displayName ?? ""}` : r.error ?? `${r.state ?? ""}: ${r.detail ?? ""}`}</div>}</span>;
}
function ImageModel({ cur, save }: any) {
  const [list, setList] = useState<string[] | null>(null);
  const toast = useToast();
  return <Field label="Modelo de imagem" hint="Liste os modelos disponíveis para a sua chave; não fixamos nomes inventados."><div className="row"><input defaultValue={cur} onBlur={(e) => save(e.target.value)} style={{ flex: 1 }} /><button onClick={async () => { try { setList(await api.get("/api/config/openai/modelos")); } catch (e: any) { toast(e, true); } }}>Listar modelos</button></div>
    {list && <div className="row" style={{ marginTop: 4 }}>{list.map((m) => <button key={m} onClick={() => save(m)}>{m}</button>)}</div>}</Field>;
}
