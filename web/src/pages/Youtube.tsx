import { useState } from "react";
import { api } from "../api";
import { useData, Action, Chip, Field, useToast } from "../components/ui";

const TABS: [string, string[]][] = [["Ideias", ["yt-viral", "yt-script"]], ["Calendário", ["yt-plan"]], ["Embalagem do vídeo", ["yt-package"]], ["Metadados", ["yt-seo", "yt-chapters"]], ["Comentários", ["yt-comment"]], ["Retenção", ["yt-retention", "yt-edit", "yt-shorts"]], ["Diagnóstico", ["yt-audit"]]];

export function Youtube() {
  const skills = useData<any>("/api/youtube/skills");
  const projects = useData<any[]>("/api/projects");
  const reports = useData<any[]>("/api/youtube/relatorios");
  const [tab, setTab] = useState("Ideias");
  const [pid, setPid] = useState("");
  const [out, setOut] = useState<Record<string, any>>({});
  const [inp, setInp] = useState<Record<string, string>>({});
  const toast = useToast();
  const run = async (skill: string, input: any) => { const r = await api.post(`/api/youtube/${skill}`, { projectId: pid || null, input }); setOut({ ...out, [skill]: r }); reports.reload(); };
  return <div className="fade">
    <h1>Canal YouTube</h1>
    <div className="sub">As onze skills da youtube-agent-skill como ações. Nada é publicado: tudo vira relatório revisável, com projeto, versão, dados de entrada e data.</div>
    <div className="row"><Field label="Projeto analisado"><select value={pid} onChange={(e) => setPid(e.target.value)} style={{ minWidth: 320 }}><option value="">(nenhum)</option>{(projects.data ?? []).filter((p) => !p.is_test).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field></div>
    {skills.data && <div className="small muted" style={{ marginTop: 6 }}>Skills encontradas na instalação: {skills.data.catalog.found.length}/11{skills.data.catalog.missing.length ? ` · faltando: ${skills.data.catalog.missing.join(", ")}` : ""}{skills.data.catalog.extra.length ? ` · novas: ${skills.data.catalog.extra.join(", ")}` : ""}</div>}
    <div className="tabs">{TABS.map(([t]) => <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t}</button>)}<button className={`tab ${tab === "Perfil" ? "on" : ""}`} onClick={() => setTab("Perfil")}>Perfil editorial</button></div>
    {tab === "Perfil" ? <Perfil /> : TABS.find(([t]) => t === tab)![1].map((sk) => <div key={sk} className="card" style={{ marginBottom: 12 }}>
      <div className="row"><b>{skills.data?.skills[sk]?.acao}</b><code>{sk}</code><span className="tiny muted">entrada: {skills.data?.skills[sk]?.entrada} · ferramenta local: {skills.data?.skills[sk]?.local}</span></div>
      {sk === "yt-package" && <><Field label="Títulos (um por linha)"><textarea value={inp[sk] ?? ""} onChange={(e) => setInp({ ...inp, [sk]: e.target.value })} /></Field><Field label="Texto da thumbnail"><input value={inp[sk + ":thumb"] ?? ""} onChange={(e) => setInp({ ...inp, [sk + ":thumb"]: e.target.value })} /></Field>
        <div className="row"><Action onRun={() => run(sk, { titles: (inp[sk] ?? "").split("\n").filter(Boolean), thumbText: inp[sk + ":thumb"] })}>Revisar pares</Action><Action disabled={!pid} onRun={() => run(sk, { titles: (inp[sk] ?? "").split("\n").filter(Boolean), thumbText: inp[sk + ":thumb"], generate: true })}>Revisar e propor alternativas (Claude)</Action></div>
        <div className="tiny muted">Prévia em tamanho de feed e imagens de thumbnail via OpenAI só depois da aprovação do áudio do projeto.</div></>}
      {sk === "yt-comment" && <><Field label="Cole os comentários (um por linha)"><textarea value={inp[sk] ?? ""} onChange={(e) => setInp({ ...inp, [sk]: e.target.value })} /></Field><Action onRun={() => run(sk, { text: inp[sk] })}>Analisar (não envia respostas)</Action></>}
      {sk === "yt-retention" && <><Field label="CSV de retenção do YouTube Studio"><textarea value={inp[sk] ?? ""} onChange={(e) => setInp({ ...inp, [sk]: e.target.value })} placeholder="posição,%" /></Field><Field label="Duração do vídeo publicado (s)"><input value={inp[sk + ":d"] ?? ""} onChange={(e) => setInp({ ...inp, [sk + ":d"]: e.target.value })} /></Field><Action onRun={() => run(sk, { csv: inp[sk], durationSec: Number(inp[sk + ":d"]) || undefined })}>Examinar</Action></>}
      {(sk === "yt-viral" || sk === "yt-audit") && <><Field label="Dados importados (JSON: [{channel,title,views,url}])"><textarea value={inp[sk] ?? ""} onChange={(e) => setInp({ ...inp, [sk]: e.target.value })} /></Field><Field label="Fonte e data da coleta"><input value={inp[sk + ":s"] ?? ""} onChange={(e) => setInp({ ...inp, [sk + ":s"]: e.target.value })} /></Field><Action onRun={async () => { let videos; try { videos = JSON.parse(inp[sk] ?? "[]"); } catch { toast("JSON inválido", true); return; } return run(sk, { videos, source: inp[sk + ":s"] }); }}>Analisar</Action></>}
      {sk === "yt-plan" && <Action onRun={() => run(sk, { weeks: 4, perWeek: 1 })}>Montar calendário (4 semanas)</Action>}
      {["yt-script", "yt-seo", "yt-chapters", "yt-edit", "yt-shorts"].includes(sk) && <Action disabled={!pid} onRun={() => run(sk, {})}>Executar para o projeto</Action>}
      {out[sk] && <Result r={out[sk]} />}
    </div>)}
    <h2>Relatórios</h2>
    <table><tbody>{reports.data?.map((r) => <tr key={r.id}><td><code>{r.skill}</code></td><td className="small">{r.project_id ?? "—"} {r.project_version ?? ""}</td><td className="small muted">{new Date(r.created_at).toLocaleString("pt-BR")}</td><td><details><summary className="small">ver</summary><pre>{JSON.stringify(r.data, null, 1).slice(0, 4000)}</pre></details></td></tr>)}</tbody></table>
  </div>;
}

function Result({ r }: any) {
  const d = r.data;
  if (r.skill === "yt-seo") return <div style={{ marginTop: 8 }}><div className="row"><b>Descrição</b><Chip kind={d.description.chars <= 5000 ? "ok" : "err"}>{d.description.chars} / 5.000</Chip>{d.description.truncatedSummary && <Chip kind="warn">resumo encurtado; créditos preservados</Chip>}</div><textarea readOnly style={{ minHeight: 220 }} value={d.description.text} /><b>Palavras-chave</b><textarea readOnly value={d.keywords} /><div className="tiny muted">{d.chaptersNote}</div></div>;
  if (r.skill === "yt-chapters") return <pre>{d.text}{"\n\n"}{d.valid ? "Válido" : "INVÁLIDO para o YouTube"} — {d.rules}</pre>;
  return <pre style={{ marginTop: 8 }}>{JSON.stringify(d, null, 1).slice(0, 6000)}</pre>;
}

function Perfil() {
  const { data, reload } = useData<any>("/api/canal");
  const [f, setF] = useState<any>(null);
  if (!data) return null;
  const v = f ?? data.data;
  const set = (k: string, arr = false) => (e: any) => setF({ ...v, [k]: arr ? e.target.value.split("\n").filter(Boolean) : e.target.value });
  return <div className="card"><div className="row"><h3>Perfil editorial do canal — v{data.version}</h3><span className="tiny muted">Alterações criam nova versão e orientam só as próximas gerações.</span></div>
    <div className="grid g2">
      <Field label="Proposta"><textarea value={v.proposal} onChange={set("proposal")} /></Field>
      <Field label="Público"><textarea value={v.audience} onChange={set("audience")} /></Field>
      <Field label="Tom"><input value={v.tone} onChange={set("tone")} /></Field>
      <Field label="Ritmo"><input value={v.pacing} onChange={set("pacing")} /></Field>
      <Field label="Temas (um por linha)"><textarea value={v.themes.join("\n")} onChange={set("themes", true)} /></Field>
      <Field label="Regras (uma por linha)"><textarea value={v.rules.join("\n")} onChange={set("rules", true)} /></Field>
      <Field label="Vocabulário"><textarea value={v.vocabulary} onChange={set("vocabulary")} /></Field>
      <Field label="Restrições"><textarea value={v.restrictions.join("\n")} onChange={set("restrictions", true)} /></Field>
      <Field label="Critérios de qualidade"><textarea value={v.qualityCriteria.join("\n")} onChange={set("qualityCriteria", true)} /></Field>
      <Field label="Exemplos aprovados"><textarea value={v.approvedExamples.join("\n")} onChange={set("approvedExamples", true)} /></Field>
      <Field label="Personagens recorrentes"><textarea value={v.recurringCharacters.join("\n")} onChange={set("recurringCharacters", true)} /></Field>
      <Field label="Disponibilidade de produção"><input value={v.productionAvailability} onChange={set("productionAvailability")} /></Field>
    </div>
    <Field label="Voz editorial (template voice.md da skill)" hint="“Voz editorial” = maneira de escrever. É diferente do timbre/perfil clonado do Estúdio de voz."><textarea style={{ minHeight: 220 }} value={v.editorialVoice} onChange={set("editorialVoice")} /></Field>
    <Action primary onRun={async () => { await api.put("/api/canal", v); setF(null); reload(); }}>Salvar nova versão</Action></div>;
}
