import { useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, fmtSec } from "../api";
import { useData, useJobEvents, Action, Chip, Progress, Waveform, Field, useToast, stateChip } from "../components/ui";

const TABS = ["Roteiro", "Voz e narração", "Personagens", "Storyboard e cenas", "Som", "Legendas", "Exportação", "Curtos", "Comando"] as const;

export function Projeto() {
  const { id } = useParams();
  const { data, reload } = useData<any>(`/api/projects/${id}`);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Roteiro");
  const jobs = useJobEvents((js) => { if (js.some((j) => j.project_id === id)) reload(); });
  if (!data) return <p className="muted">Carregando…</p>;
  const p = data.project;
  const running = jobs.filter((j) => j.project_id === id && ["em fila", "produzindo"].includes(j.status));
  const base = `/api/projects/${id}`;
  return (
    <div className="fade">
      <div className="row"><h1 style={{ marginRight: 8 }}>{p.title}</h1><Chip>{p.kind === "long" ? "Longo 16:9" : p.kind === "short" ? "Curto 9:16" : "Pacote"}</Chip>{p.is_demo ? <Chip kind="info">projeto demonstrativo</Chip> : null}{p.parent_id && <Link to={`/projetos/${p.parent_id}`}>← episódio de origem</Link>}</div>
      <div className="sub">{p.settings.premise} · meta {fmtSec(p.settings.targetSeconds)} · estilo <b>{p.style?.namePt ?? p.settings.styleId}</b> (versão fixada {String(JSON.parse(p.style_lock_json ?? "{}").hash ?? "").slice(0, 8)}) · modo {p.settings.visualMode} · cenas por IA: {p.settings.aiScenes?.enabled ? `sim (${p.settings.aiScenes.where === "runpod" ? "RunPod" : "minha máquina"})` : "não"}</div>
      <div className="steps">{data.steps.steps.map((s: any) => <span key={s.key} className={`step ${s.state}`}>{s.state === "concluída" ? "✓ " : s.state === "bloqueada" ? "🔒 " : ""}{s.label}</span>)}</div>
      <div className="banner"><b>Próxima ação:</b> {data.steps.nextAction}</div>
      {!data.steps.visualUnlocked && <div className="banner lock">🔒 Produção visual bloqueada até a narração completa ser aprovada. Próxima ação: <b>Gerar e aprovar narração</b>.</div>}
      {(data.stale.scenes.length > 0 || data.stale.subtitles.length > 0) && <div className="banner warn">A narração mudou: {data.stale.scenes.length} cena(s) e {data.stale.subtitles.length} legenda(s) estão desatualizadas. Os arquivos anteriores foram preservados; refaça só o que depende do novo áudio.</div>}
      {running.map((j) => <div key={j.id} className="card" style={{ marginBottom: 8 }}><div className="row"><b>{j.type}</b>{stateChip(j.status)}<span className="sp" /><Action onRun={() => api.post(`/api/jobs/${j.id}/cancelar`)} danger>Cancelar</Action></div><Progress value={j.progress} label={j.progress_label} estimated={!!j.progress_estimated} /></div>)}
      <div className="tabs">{TABS.map((t) => <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === "Roteiro" && <Roteiro data={data} base={base} reload={reload} />}
      {tab === "Voz e narração" && <Narracao data={data} base={base} reload={reload} />}
      {tab === "Personagens" && <Personagens data={data} base={base} />}
      {tab === "Storyboard e cenas" && <Cenas data={data} base={base} reload={reload} />}
      {tab === "Som" && <Som data={data} base={base} />}
      {tab === "Legendas" && <Legendas data={data} base={base} />}
      {tab === "Exportação" && <Exportacao data={data} base={base} />}
      {tab === "Curtos" && <Curtos data={data} base={base} />}
      {tab === "Comando" && <Comando base={base} reload={reload} />}
    </div>
  );
}

/* --------------------------------- roteiro --------------------------------- */
function Roteiro({ data, base, reload }: any) {
  const s = data.script;
  const toast = useToast();
  const [cc, setCc] = useState<any>(null);
  const [edit, setEdit] = useState<string | null>(null);
  return <div>
    <div className="grid g2">
      <div className="card"><h3>A. Automação por API (Claude)</h3><p className="small muted">Usa a sua chave Anthropic no backend. Modelo configurado em Configurações (padrão <code>claude-opus-5-5</code>); nunca é trocado em silêncio.</p>
        <div className="row"><Action primary onRun={() => api.post(`${base}/roteiro/gerar`)}>Gerar roteiro com Claude</Action>{s && <Action onRun={() => api.post(`${base}/roteiro/gerar`, { revisionNote: prompt("O que revisar?") ?? "" })}>Revisar roteiro</Action>}</div></div>
      <div className="card"><h3>B. Preparar projeto para Claude Code</h3><p className="small muted">Usa a sua instalação oficial e a sua conta. O app prepara a pasta e importa o resultado; não faz login nem usa a assinatura por você.</p>
        <div className="row"><Action onRun={async () => setCc(await api.post(`${base}/claude-code/preparar`))}>Preparar projeto para Claude Code</Action>
          <Action onRun={async () => toast((await api.post(`${base}/claude-code/abrir-pasta`)).dir)}>Abrir pasta</Action>
          <Action onRun={async () => { const r = await api.post(`${base}/claude-code/importar`); toast(`Roteiro v${r.version} importado e validado.`); reload(); }}>Importar resultados</Action></div>
        {cc && <div className="small" style={{ marginTop: 8 }}><div>Pasta: <code>{cc.dir}</code></div><div>No terminal: <code>{cc.terminal}</code></div>
          <div className="row" style={{ marginTop: 6 }}><code style={{ flex: 1 }}>{cc.instruction}</code><button onClick={() => { navigator.clipboard.writeText(cc.instruction); toast("Instrução copiada."); }}>Copiar instrução</button></div></div>}</div>
    </div>
    {!s ? <div className="empty" style={{ marginTop: 16 }}>Ainda não há roteiro.</div> : <>
      <h2>{s.data.title} <span className="small muted">v{s.version} · {s.origin} · modelo {s.model ?? "—"}</span></h2>
      <p className="muted">{s.data.logline}</p>
      <div className="grid g2">
        <div className="card"><h3>Cinco ganchos (yt-script · nota heurística, não prevê visualizações)</h3>
          {s.hooks.map((h: any, i: number) => <div key={i} className="seg"><div className="row"><b>{h.verdict}</b><Chip kind={h.band === "FORTE" ? "ok" : h.band === "FUNCIONA" ? "warn" : "err"}>{h.band}</Chip>{i === 0 && <Chip kind="info">recomendado</Chip>}</div><div>{h.hook}</div><div className="tiny muted">mais fraco: {h.weakest} — {h.fix}</div></div>)}</div>
        <div className="card"><h3>Revisão</h3>
          <div className="small">Palavras: {s.report.words} (meta ~{s.report.targetWords}) · estimativa {fmtSec(s.report.estimatedSeconds)} · gancho ~{s.report.hookSeconds?.toFixed(1)} s</div>
          {s.report.issues?.map((x: string) => <div key={x} className="banner warn small">{x}</div>)}
          <div className="small muted" style={{ marginTop: 8 }}>Autorrevisão do modelo: repetições {s.report.modelSelfReview?.repetitions?.length ?? 0} · contradições {s.report.modelSelfReview?.contradictions?.length ?? 0} · exposição {s.report.modelSelfReview?.excessiveExposition?.length ?? 0} · promessas {s.report.modelSelfReview?.unkeptPromises?.length ?? 0}</div>
          <div className="small" style={{ marginTop: 8 }}><b>Regras do mundo:</b> {s.data.worldRules.join(" · ")}</div></div>
      </div>
      <div className="row" style={{ marginTop: 12 }}><button onClick={() => setEdit(JSON.stringify(s.data, null, 2))}>Editar roteiro (JSON)</button></div>
      {edit != null && <div className="card" style={{ marginTop: 10 }}><textarea style={{ minHeight: 360, fontFamily: "monospace", fontSize: 12 }} value={edit} onChange={(e) => setEdit(e.target.value)} />
        <div className="row"><Action primary onRun={async () => { await api.put(`${base}/roteiro`, { doc: JSON.parse(edit) }); setEdit(null); reload(); }}>Salvar como nova versão</Action><button onClick={() => setEdit(null)}>Cancelar</button></div></div>}
      {s.data.scenes.map((sc: any) => <div key={sc.key} className="card" style={{ marginTop: 10 }}><div className="row"><b>{sc.key}</b><span className="muted small">ato {sc.act} · {sc.setting} · {sc.emotion} · ~{sc.estimatedSeconds}s</span></div><div className="small muted">{sc.goal} — {sc.visualIntent}</div>
        {sc.lines.map((l: any, i: number) => <p key={i}><b>{l.speaker}</b> <span className="tiny muted">({l.emotion}, pausa {l.pauseAfterMs} ms)</span>: {l.text}</p>)}</div>)}
    </>}
  </div>;
}

/* ----------------------------- voz e narração ----------------------------- */
function Narracao({ data, base, reload }: any) {
  const s = data.script;
  const engines = useData<any[]>("/api/voz/motores");
  const voices = useData<any[]>(`/api/voz/vozes?engine=${data.cast.narrador.engine}`, [data.cast.narrador.engine]);
  const [cast, setCast] = useState<any>(data.cast);
  const [sample, setSample] = useState<any>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const toast = useToast();
  const latest = data.masters[0];
  const approval = latest && data.approvals.find((a: any) => a.master_id === latest.id && !a.revoked_at);
  const pending = data.segments.filter((x: any) => !x.chosen_take_id).length;
  const sampleText = s?.data.scenes[0]?.lines[0]?.text ?? "Você acorda com o zíper da sua barraca abrindo sozinho.";
  const eng = engines.data?.find((e) => e.id === cast.narrador.engine);
  if (!s) return <div className="empty">Crie o roteiro primeiro: a narração é gerada a partir dele.</div>;
  return <div>
    <div className="grid g2">
      <div className="card"><h3>Voz do narrador</h3>
        <div className="grid g2">
          <Field label="Motor"><select value={cast.narrador.engine} onChange={(e) => setCast({ ...cast, narrador: { ...cast.narrador, engine: e.target.value } })}>{engines.data?.map((e) => <option key={e.id} value={e.id} disabled={e.status.state !== "disponível"}>{e.name} — {e.status.state}</option>)}</select></Field>
          <Field label="Voz"><select value={cast.narrador.voice} onChange={(e) => setCast({ ...cast, narrador: { ...cast.narrador, voice: e.target.value } })}>{voices.data?.filter((v) => !cast.narrador.language || v.language === cast.narrador.language || cast.narrador.engine !== "kokoro").map((v) => <option key={v.id} value={v.id}>{v.name} · {v.accent ?? v.language} · {v.gender ?? ""}</option>)}</select></Field>
          <Field label={`Velocidade: ${cast.narrador.speed.toFixed(2)}×`} hint="Nativo do motor. Alterar depois da aprovação cria nova versão."><input type="range" min={0.7} max={1.3} step={0.01} value={cast.narrador.speed} onChange={(e) => setCast({ ...cast, narrador: { ...cast.narrador, speed: Number(e.target.value) } })} /></Field>
          <Field label="Direção livre" hint={eng?.controls["descrição livre"]?.note}><input disabled={eng?.controls["descrição livre"]?.support === "indisponível"} value={cast.narrador.instruction ?? ""} onChange={(e) => setCast({ ...cast, narrador: { ...cast.narrador, instruction: e.target.value } })} placeholder="narrador brasileiro, grave, íntimo, apreensivo" /></Field>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <Action onRun={async () => { const r = await api.post(`${base}/voz/amostra`, { setting: cast.narrador, text: sampleText }); setSample(r); setTimeout(() => audioRef.current?.play(), 50); }}>▶ Ouvir com meu texto</Action>
          <Action onRun={async () => { await api.put(`${base}/voz/elenco`, cast); toast("Elenco salvo. Mudanças de voz exigem nova narração e nova aprovação."); reload(); }}>Salvar elenco</Action>
          <Link to="/voz"><button>Estúdio de voz completo →</button></Link></div>
        {sample && <div style={{ marginTop: 8 }}><audio ref={audioRef} controls src={sample.url} /><div className="tiny muted">Amostra gerada agora com a configuração exata acima ({sample.engine}, {sample.duration.toFixed(1)} s).</div></div>}
      </div>
      <div className="card"><h3>Controles do motor “{eng?.name}”</h3><table><tbody>{eng && Object.entries(eng.controls).map(([k, c]: any) => <tr key={k}><td>{k}</td><td><Chip kind={c.support === "nativo" ? "ok" : c.support === "indisponível" ? "lock" : "info"}>{c.support}</Chip></td><td className="tiny muted">{c.note}</td></tr>)}</tbody></table></div>
    </div>
    <h2>Trechos de fala <span className="small muted">({data.segments.length} trechos · {pending} sem take)</span></h2>
    <div className="row">
      {!data.segments.length && <Action primary onRun={async () => { await api.post(`${base}/voz/segmentos`, { scriptVersion: s.version }); reload(); }}>Dividir roteiro em trechos</Action>}
      {data.segments.length > 0 && <Action primary onRun={() => api.post(`${base}/narracao/gerar`, { scriptVersion: s.version })}>Gerar narração completa</Action>}
      {data.segments.length > 0 && pending === 0 && <Action onRun={() => api.post(`${base}/narracao/montar`, { scriptVersion: s.version })}>Remontar master com takes escolhidos</Action>}
      <label className="btn" style={{ margin: 0 }}>⬆ Enviar narração própria<input type="file" accept="audio/*" style={{ display: "none" }} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append("file", f); try { await api.upload(`${base}/narracao/upload`, fd); reload(); } catch (err: any) { toast(err, true); } }} /></label>
    </div>
    <div style={{ marginTop: 10 }}>{data.segments.map((sg: any) => <Segment key={sg.id} sg={sg} reload={reload} />)}</div>
    <h2>Master de narração e aprovação</h2>
    {!latest ? <div className="empty">Nenhum master ainda. Gere a narração completa.</div> : <div className={`card ${approval ? "" : "hl"}`}>
      <div className="row"><b>Master v{latest.version}</b>{approval ? <Chip kind="ok">aprovado em {new Date(approval.approved_at).toLocaleString("pt-BR")}</Chip> : <Chip kind="warn">aguardando sua aprovação</Chip>}<span className="muted small">{fmtSec(latest.duration)} · roteiro v{latest.script_version} · {latest.origin} · hash {latest.sha256.slice(0, 10)}</span></div>
      <audio controls src={`${base}/narracao/${latest.id}/audio`} style={{ marginTop: 8 }} />
      <Waveform src={`${base}/narracao/${latest.id}/audio`} />
      <div className="small" style={{ marginTop: 6 }}>Vozes: {JSON.parse(latest.speakers_json).map((x: any) => `${x.speaker} → ${x.engine ?? ""}:${x.voice ?? ""}`).join(", ")}</div>
      {data.durationCheck && <div className={`banner ${data.durationCheck.within ? "ok" : "warn"}`}>Duração real {fmtSec(data.durationCheck.duration)} · meta {fmtSec(data.durationCheck.target)} ± {data.durationCheck.tolerance}s — {data.durationCheck.advice}{data.durationCheck.longRange ? " " + data.durationCheck.longRange : ""}</div>}
      {!approval && <div className="row"><Action primary disabled={pending > 0} confirm="Você ouviu a narração completa e aprova esta versão como relógio do vídeo?" onRun={async () => { await api.post(`${base}/narracao/aprovar`, { masterId: latest.id, confirm: true }); reload(); }}>✓ Aprovar áudio e iniciar cenas</Action>{!data.durationCheck?.within && <span className="small" style={{ color: "var(--warn)" }}>A duração está fora da meta: o ideal é ajustar o roteiro antes de aprovar.</span>}</div>}
      {approval && <div className="row"><Action primary onRun={() => api.post(`${base}/narracao/alinhar`)}>Transcrever e alinhar a gravação</Action><span className="small muted">Gera tempos por frase e por palavra (faster-whisper local) e o SRT.</span></div>}
    </div>}
  </div>;
}

function Segment({ sg, reload }: any) {
  const [text, setText] = useState(sg.text);
  const [pause, setPause] = useState(sg.pause_after_ms);
  const take = sg.takes.find((t: any) => t.id === sg.chosen_take_id);
  const pid = sg.project_id;
  const url = (p: string) => `/api/projects/${pid}/arquivo/${p.split(`/projetos/${pid}/`)[1]}`;
  return <div className={`seg ${sg.chosen_take_id ? "gerado" : "pendente"}`}>
    <div className="row"><b>#{sg.idx + 1}</b><Chip>{sg.speaker}</Chip><Chip kind="info">{sg.direction?.emotion}</Chip><span className="tiny muted">cena {sg.scene_key}</span><span className="sp" />{take && <span className="tiny muted">{take.duration.toFixed(2)} s · {take.engine}</span>}</div>
    <textarea style={{ minHeight: 48, marginTop: 6 }} value={text} onChange={(e) => setText(e.target.value)} />
    <div className="row" style={{ marginTop: 6 }}>
      <span className="small muted">Pausa depois</span><input type="number" style={{ width: 90 }} value={pause} onChange={(e) => setPause(Number(e.target.value))} /><span className="small muted">ms</span>
      {(text !== sg.text || pause !== sg.pause_after_ms) && <Action onRun={async () => { await api.patch(`/api/segmentos/${sg.id}`, { text, pauseAfterMs: pause }); reload(); }}>Salvar (nova versão de áudio)</Action>}
      <Action onRun={() => api.post(`/api/segmentos/${sg.id}/take`)}>↻ Refazer trecho</Action>
      {take && <audio controls src={url(take.path)} style={{ width: 260, height: 32 }} />}
    </div>
    {sg.takes.length > 1 && <div className="row tiny" style={{ marginTop: 6 }}>Comparar takes: {sg.takes.map((t: any, i: number) => <span key={t.id} className="row"><audio controls src={url(t.path)} style={{ width: 200, height: 28 }} /><button disabled={t.id === sg.chosen_take_id} onClick={async () => { await api.post(`/api/segmentos/${sg.id}/escolher`, { takeId: t.id }); reload(); }}>{t.id === sg.chosen_take_id ? "escolhido" : `usar take ${i + 1}`}</button></span>)}</div>}
  </div>;
}

/* -------------------------------- personagens -------------------------------- */
function Personagens({ data, base }: any) {
  const chars = data.script?.data.characters ?? [];
  const toast = useToast();
  return <div><p className="muted small">Bíblia do projeto com IDs estáveis. Referências visuais enviadas aqui são reaproveitadas nas próximas imagens. Consistência perfeita de geradores não é garantida: confira os alertas e substitua manualmente quando necessário.</p>
    <div className="cards">{chars.map((c: any) => <div key={c.id} className="card"><div className="row"><b>{c.name}</b><code>{c.id}</code></div><div className="small">{c.role}</div><p className="small muted">{c.physical} · {c.clothes} · {c.proportions}</p><div className="row">{c.colors.map((x: string) => <span key={x} className="chip" style={{ background: /^#/.test(x) ? x : undefined, color: "#000" }}>{x}</span>)}</div><p className="small">{c.personality} · {c.relations}</p>
      <label className="btn" style={{ margin: 0 }}>⬆ Imagem de referência<input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append("kind", "referencia-personagem"); fd.append("characterKey", c.id); fd.append("file", f); try { await api.upload(`${base}/midia`, fd); toast("Referência salva."); } catch (er: any) { toast(er, true); } }} /></label></div>)}</div>
    {data.script && <><h2>Cenários e regras do mundo</h2><div className="grid g2"><div className="card">{data.script.data.settings.map((s: any) => <p key={s.id}><code>{s.id}</code> {s.description}</p>)}</div><div className="card">{data.script.data.worldRules.map((r: string) => <p key={r}>• {r}</p>)}</div></div></>}
  </div>;
}

/* ------------------------------ storyboard/cenas ------------------------------ */
function Cenas({ data, base, reload }: any) {
  const unlocked = data.steps.visualUnlocked;
  const [sel, setSel] = useState<string[]>([]);
  const [plan, setPlan] = useState<any>(null);
  const [aiPlan, setAiPlan] = useState<any>(null);
  const ai = data.project.settings.aiScenes;
  const lockMsg = "Bloqueado até a narração ser aprovada — Gerar e aprovar narração";
  return <div>
    {!unlocked && <div className="banner lock">🔒 {lockMsg}</div>}
    <div className="row">
      <Action primary disabled={!unlocked} title={unlocked ? "" : lockMsg} onRun={() => api.post(`${base}/storyboard`)}>Gerar storyboard sincronizado</Action>
      <Action disabled={!unlocked || !data.scenes.length} onRun={() => api.post(`${base}/cenas/render`, { keys: [data.scenes[0]?.stable_key] })}>Renderizar cena piloto</Action>
      <Action disabled={!unlocked || !sel.length} onRun={() => api.post(`${base}/cenas/render`, { keys: sel })}>Renderizar selecionadas ({sel.length})</Action>
      {data.project.settings.visualMode !== "codigo" && <Action disabled={!unlocked || !sel.length} onRun={async () => setPlan(await api.get(`${base}/imagens/plano?keys=${sel.join(",")}&roles=fundo`))}>Planejar imagens OpenAI</Action>}
      {ai?.enabled && <Action disabled={!unlocked || !sel.length} onRun={async () => setAiPlan(await api.get(`${base}/ia/plano?keys=${sel.join(",")}`))}>Planejar cenas por IA</Action>}
    </div>
    {plan && <div className="banner warn"><b>Plano de geração paga:</b> {plan.images} imagem(ns) · modelo {plan.model} · qualidade {plan.quality} · custo {plan.cost.kind === "estimado" ? `≈ US$ ${plan.cost.usd.toFixed(2)} (estimado)` : "indisponível (informe o preço por imagem em Configurações)"} · orçamento do projeto US$ {plan.budget}
      <div className="row" style={{ marginTop: 6 }}><Action primary onRun={async () => { const r = await api.post(`${base}/imagens`, { keys: sel, roles: ["fundo"], confirm: true }); setPlan(null); return r; }}>Confirmar e gerar</Action><button onClick={() => setPlan(null)}>Cancelar</button></div></div>}
    {aiPlan && <div className="banner warn"><b>Cenas por IA — {aiPlan.where === "runpod" ? "RunPod" : "minha máquina"}</b> · estado: {aiPlan.status.state} — {aiPlan.status.detail}<div className="small">{aiPlan.limits.note} · Envio: {aiPlan.uploads} · Custo: {aiPlan.cost.kind}</div>
      {aiPlan.scenes.map((s: any) => <div key={s.key} className="small">{s.key}: {s.clips.length} clipe(s) de ~{((s.t1 - s.t0) / s.clips.length).toFixed(1)} s</div>)}
      <div className="row" style={{ marginTop: 6 }}><Action primary disabled={aiPlan.status.state !== "disponível"} onRun={async () => { const r = await api.post(`${base}/ia`, { keys: sel, confirm: true }); setAiPlan(null); return r; }}>Confirmar e gerar</Action><button onClick={() => setAiPlan(null)}>Cancelar</button></div></div>}
    <div style={{ marginTop: 12 }}>{data.scenes.map((s: any) => <SceneCard key={s.id} s={s} base={base} sel={sel} setSel={setSel} reload={reload} />)}</div>
    {!data.scenes.length && <div className="empty">Sem storyboard ainda.</div>}
  </div>;
}

function SceneCard({ s, base, sel, setSel, reload }: any) {
  const on = sel.includes(s.stable_key);
  const url = s.render_path ? `${base}/arquivo/${s.render_path.split("/projetos/")[1].split("/").slice(1).join("/")}` : null;
  return <div className={`card ${s.stale ? "" : ""}`} style={{ marginBottom: 10, opacity: s.stale ? 0.7 : 1 }}>
    <div className="row"><input type="checkbox" style={{ width: "auto" }} checked={on} onChange={() => setSel(on ? sel.filter((k: string) => k !== s.stable_key) : [...sel, s.stable_key])} />
      <b>Cena {s.idx + 1} · {s.stable_key}</b><span className="muted small">{s.data.title}</span><span className="sp" />
      <span className="small">{fmtSec(s.t0)}–{fmtSec(s.t1)} ({(s.t1 - s.t0).toFixed(1)} s no master)</span>{s.stale ? <Chip kind="warn">desatualizada: {s.stale_reason}</Chip> : s.render_hash ? <Chip kind="ok">renderizada</Chip> : <Chip>{s.state}</Chip>}{s.data.ai?.use && <Chip kind="info">IA {s.data.ai.status}</Chip>}</div>
    <div className="grid g2" style={{ marginTop: 8 }}>
      <div><div className="small">“{s.data.narration}”</div>
        <table style={{ marginTop: 6 }}><tbody>{s.data.shots.map((sh: any, i: number) => <tr key={i}><td className="tiny">{sh.t0.toFixed(2)}–{sh.t1.toFixed(2)}</td><td className="tiny">{sh.setPiece} · {sh.light}</td><td className="tiny">{sh.camera.move} ({sh.camera.shot})</td><td className="tiny">{sh.actors.map((a: any) => `${a.id}:${a.action}`).join(", ")}</td><td className="tiny">{sh.transitionIn}</td></tr>)}</tbody></table>
        <div className="row" style={{ marginTop: 6 }}>
          <select style={{ width: 170 }} onChange={async (e) => { if (!e.target.value) return; await api.patch(`${base}/cenas/${s.stable_key}`, { shots: s.data.shots.map((sh: any) => ({ ...sh, camera: { ...sh.camera, move: e.target.value } })) }); reload(); }} defaultValue=""><option value="">Mudar movimento…</option>{["estatica", "push-in", "pull-out", "pan-esq", "pan-dir", "tremor", "travelling"].map((m) => <option key={m}>{m}</option>)}</select>
          <select style={{ width: 150 }} onChange={async (e) => { if (!e.target.value) return; await api.patch(`${base}/cenas/${s.stable_key}`, { shots: s.data.shots.map((sh: any) => ({ ...sh, light: e.target.value })) }); reload(); }} defaultValue=""><option value="">Mudar luz…</option>{["noite", "fogueira", "lanterna", "alerta", "entardecer", "dia"].map((m) => <option key={m}>{m}</option>)}</select>
          <label className="btn" style={{ margin: 0 }}>⬆ Trocar imagem<input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append("kind", "imagem-fundo"); fd.append("sceneKey", s.stable_key); fd.append("file", f); const r = await api.upload(`${base}/midia`, fd); await api.patch(`${base}/cenas/${s.stable_key}`, { media: [...(s.data.media ?? []).filter((m: any) => m.role !== "fundo"), { role: "fundo", assetId: r.assetId, prompt: "upload do usuário" }] }); reload(); }} /></label>
          <Action onRun={async () => { await api.patch(`${base}/cenas/${s.stable_key}`, { approved: true }); reload(); }}>Aprovar cena</Action>
        </div>
        <div className="tiny muted" style={{ marginTop: 4 }}>Mudanças visuais não regeneram a narração; invalidam só o render desta cena e a montagem.</div></div>
      <div>{url ? <video controls preload="none" src={url} className="thumb" /> : <div className="thumb" style={{ display: "grid", placeItems: "center" }}><span className="muted small">sem render</span></div>}</div>
    </div>
  </div>;
}

/* ------------------------------------ som ------------------------------------ */
function Som({ data, base }: any) {
  const som = useData<any>(`${base}/som`);
  const exp = data.exports[0];
  return <div>
    <p className="small muted">Sound pass pela skill <code>sound-effects</code>: mapa de cues da timeline atual, sons reais com licença, ponto de sincronismo medido no arquivo e conferência no MP4 exportado. Alvo padrão −16 LUFS / true peak −4 dBTP (configurável por projeto).</p>
    {exp && <div className="row"><a href={`${base}/arquivo/sons/RELATORIO_SOM.html`} target="_blank"><button className="primary">Abrir RELATORIO_SOM.html</button></a><a href={`${base}/arquivo/sons/CUES.csv`}><button>CUES.csv</button></a><a href={`${base}/arquivo/sons/CUES.json`}><button>CUES.json</button></a></div>}
    <h2>Cinco trechos para conferir de fone</h2>
    {data.reviewClips.length ? <div className="grid g2">{data.reviewClips.map((c: any) => <div key={c.id} className="card"><b>{c.idx}. {c.data.why}</b><div className="tiny muted">vídeo final {c.data.t0.toFixed(2)}–{c.data.t1.toFixed(2)} s {c.data.cueFrame != null ? `· cue no quadro ${c.data.cueFrame}` : ""} · {c.data.loudness.integrated} LUFS</div>
      <div className="grid g2" style={{ marginTop: 6 }}><div><div className="tiny">A — com efeitos</div><video controls preload="none" src={`${base}/arquivo/revisao_fone/${c.data.file}`} /></div><div><div className="tiny">B — sem efeitos</div><video controls preload="none" src={`${base}/arquivo/revisao_fone/${c.data.abFile}`} /></div></div>
      <div className="small">Confira: {c.data.check}</div>{c.verdict && <Chip kind={c.verdict === "aprovado" ? "ok" : "warn"}>{c.verdict}</Chip>}
      <div className="row"><Action onRun={() => api.post(`${base}/som/trechos/${c.export_id}/${c.idx}`, { verdict: "aprovado" })}>Aprovar</Action><Action onRun={() => api.post(`${base}/som/trechos/${c.export_id}/${c.idx}`, { verdict: "ajustar", note: prompt("O que ajustar?") ?? "" })}>Pedir ajuste</Action></div></div>)}</div> : <div className="empty">Os trechos são gerados a partir da timeline exportada. Monte o vídeo primeiro.</div>}
    <h2>Cues ({som.data?.cues.length ?? 0})</h2>
    <table><thead><tr><th>id</th><th>cena</th><th>evento</th><th>categoria</th><th>quadro</th><th>alvo</th><th>sinc.</th><th>offset</th><th>licença</th><th></th></tr></thead><tbody>{som.data?.cues.map((c: any) => <tr key={c.id}><td>{c.id}</td><td>{c.sceneKey}</td><td className="small">{c.event}</td><td>{c.category}</td><td>{c.frame}</td><td>{c.targetTime.toFixed(3)}</td><td>{c.syncType}</td><td>{c.syncOffset.toFixed(3)}</td><td className="tiny">{c.license}</td><td><Action onRun={async () => { await api.post(`${base}/som/cues/${c.id}/deslocar`, { frames: -1 }); som.reload(); }}>−1q</Action><Action onRun={async () => { await api.post(`${base}/som/cues/${c.id}/deslocar`, { frames: 1 }); som.reload(); }}>+1q</Action></td></tr>)}</tbody></table>
    {som.data?.kit && <><h2>Kit Openverse</h2><table><tbody>{som.data.kit.items.map((it: any) => <tr key={it.local}><td>{it.local}</td><td>{it.roleLabel}</td><td className="small">“{it.openverse.title}” — {it.openverse.creator}</td><td>{it.openverse.license.toUpperCase()} {it.openverse.license_version}</td><td><audio controls src={`/api/som/arquivo/${it.local}`} style={{ width: 220, height: 30 }} /></td></tr>)}</tbody></table></>}
  </div>;
}

/* --------------------------------- legendas --------------------------------- */
function Legendas({ data, base }: any) {
  const m = data.masters[0];
  return <div>{m ? <><p className="small muted">Legendas derivadas da gravação real do master aprovado (limites de frase exatos; palavras do alinhador com confiança). Exportadas como SRT e também desenhadas como camada editável no vídeo.</p>
    <a href={`${base}/arquivo/legendas/narracao_v${m.version}.srt`} target="_blank"><button>Abrir SRT v{m.version}</button></a></> : <div className="empty">Sem master ainda.</div>}</div>;
}

/* -------------------------------- exportação -------------------------------- */
function Exportacao({ data, base }: any) {
  const unlocked = data.steps.visualUnlocked;
  const toast = useToast();
  return <div>
    <div className="row"><Action primary disabled={!unlocked} onRun={() => api.post(`${base}/montar`, {})}>Montar e exportar {data.project.kind === "short" ? "curto 1080×1920" : "longo 1920×1080"}</Action></div>
    <p className="small muted">A exportação só é marcada como concluída depois de validar o MP4: codecs, resolução, FPS, duração por quadro, faststart, loudness estéreo/mono, quadros pretos não intencionais e sincronismo da fala.</p>
    {data.exports.map((e: any) => <div key={e.id} className="card" style={{ marginTop: 10 }}>
      <div className="row"><b>{e.kind}</b>{stateChip(e.status)}<span className="muted small">{new Date(e.created_at).toLocaleString("pt-BR")}</span><span className="sp" /><code className="tiny">{e.path}</code><button onClick={() => { navigator.clipboard.writeText(e.path); toast("Caminho copiado."); }}>Copiar caminho</button></div>
      {e.validation && <div className="grid g2" style={{ marginTop: 8 }}>
        <video controls preload="none" src={`${base}/arquivo/exportacao/${e.path.split("/exportacao/")[1]}`} />
        <div className="small"><div>Vídeo: {e.validation.video.codec} {e.validation.video.w}×{e.validation.video.h} @ {e.validation.video.fps} · {e.validation.video.duration.toFixed(3)} s · {e.validation.video.frames} quadros</div>
          <div>Áudio: {e.validation.audio.codec} {e.validation.audio.sampleRate} Hz · {e.validation.audio.channels} canais</div>
          <div>Loudness: {e.validation.loudness.stereo.integrated} LUFS · TP {e.validation.loudness.stereo.truePeak} dBTP · mono TP {e.validation.loudness.mono.truePeak} dBTP</div>
          <div>Sincronismo da fala: {e.validation.syncMs?.toFixed(0)} ms</div>
          {e.validation.problems.map((p: string) => <div key={p} className="banner err">{p}</div>)}
          <div style={{ marginTop: 6 }}>Desvio dos cues (medido no MP4): {(e.validation.cueCheck ?? []).map((c: any) => `${c.id} ${c.deviationMs} ms`).join(" · ")}</div></div></div>}
    </div>)}
  </div>;
}

/* ---------------------------------- curtos ---------------------------------- */
function Curtos({ data, base }: any) {
  const unlocked = data.steps.visualUnlocked;
  const sug = useData<any>(unlocked && data.project.kind !== "short" ? `${base}/curtos/sugestoes?count=${Math.max(1, data.project.settings.shortsCount || 3)}` : null);
  const [hook, setHook] = useState<Record<number, string>>({});
  const toast = useToast();
  if (data.project.kind === "short") return <div className="small muted">Este projeto já é um curto vertical (9:16) com aprovação de áudio própria.</div>;
  return <div>
    <p className="small muted">Cada curto vira um projeto próprio 9:16 com master e aprovação de áudio próprios. Trechos reaproveitam os takes aprovados; um gancho novo precisa ser falado e aprovado antes das cenas verticais. A composição é refeita para 9:16 (não é um corte do centro).</p>
    {!unlocked && <div className="banner lock">🔒 Aprove a narração do episódio para propor curtos.</div>}
    {sug.data?.suggestions.map((s: any, i: number) => <div key={i} className="card" style={{ marginBottom: 10 }}>
      <div className="row"><b>{fmtSec(s.t0)}–{fmtSec(s.t1)}</b><span className="small muted">{s.duration.toFixed(0)} s · gancho {s.hook.verdict} ({s.hook.band})</span><Chip>{s.kind}</Chip></div>
      <div className="small">“{s.firstLine}”</div>
      <Field label="Novo gancho (opcional — exigirá nova fala e aprovação)"><input value={hook[i] ?? ""} onChange={(e) => setHook({ ...hook, [i]: e.target.value })} /></Field>
      <div className="row" style={{ marginTop: 6 }}>{["história completa", "trecho com gancho", "teaser"].map((k) => <Action key={k} onRun={async () => { const dest = k === "teaser" ? prompt("Destino editorial do teaser (ex.: episódio completo no canal)") ?? "" : undefined; const r = await api.post(`${base}/curtos`, { segmentIds: s.segmentIds, newHook: hook[i] || undefined, kind: k, destination: dest }); toast(`Curto criado: ${r.next}`); }}>Criar como {k}</Action>)}</div>
    </div>)}
    {data.children.length > 0 && <><h2>Curtos deste episódio</h2>{data.children.map((c: any) => <p key={c.id}><Link to={`/projetos/${c.id}`}>{c.title}</Link> <span className="muted small">{c.status}</span></p>)}</>}
  </div>;
}

/* --------------------------------- comando --------------------------------- */
function Comando({ base, reload }: any) {
  const [text, setText] = useState("Deixe a cena 2 mais tensa e reduza a narração");
  const [plan, setPlan] = useState<any>(null);
  return <div className="card"><h3>Comando em linguagem natural</h3><p className="small muted">Mostramos o que muda antes de executar — principalmente o que é pago ou exige nova aprovação do áudio.</p>
    <div className="row"><input style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} /><Action onRun={async () => setPlan(await api.post(`${base}/comando/plano`, { text }))}>Ver plano</Action></div>
    {plan && <div style={{ marginTop: 10 }}>{plan.understood ? plan.changes.map((c: any, i: number) => <div key={i} className={`banner ${c.paid || c.kind.includes("áudio") ? "warn" : ""}`}><b>{c.kind}</b> — {c.description}{c.paid ? " · etapa paga" : ""}<div className="tiny">Invalida: {c.invalidates.join(", ")}</div></div>) : <div className="banner">{plan.message}</div>}
      {plan.understood && <Action primary onRun={async () => { await api.post(`${base}/comando/aplicar`, { text }); setPlan(null); reload(); }}>Aplicar</Action>}</div>}
  </div>;
}

