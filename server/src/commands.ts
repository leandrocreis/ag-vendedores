import { listScenes, editScene } from "./pipeline/storyboard.js";
import { enqueue } from "./jobs.js";
import { getSecret } from "./secrets.js";
import { UserError } from "./util.js";

/**
 * Comando em linguagem natural ("Deixe a cena 4 mais tensa e reduza a narração").
 * Primeiro devolve o PLANO (o que muda, o que é pago, o que é invalidado); só executa com confirmação.
 */
export function planCommand(projectId: string, text: string) {
  const t = text.toLowerCase();
  const scenes = listScenes(projectId);
  const m = t.match(/cena\s+(\d+)/);
  const target = m ? scenes[Number(m[1]) - 1] : null;
  if (m && !target) throw new UserError(`Não existe a cena ${m[1]}`, 400);
  const changes: any[] = [];
  const where = target ? `cena ${target.idx + 1} (${target.stable_key})` : "todas as cenas";
  if (/tens|suspense|assustad|sombri/.test(t)) changes.push({ kind: "visual", target: target?.stable_key ?? null, description: `${where}: câmera com push-in mais intenso, luz noturna/lanterna e neblina`, paid: false, invalidates: ["render da cena", "montagem final", "cues sonoros da cena"], op: "tensao" });
  if (/rápid|agitad|ação/.test(t)) changes.push({ kind: "visual", target: target?.stable_key ?? null, description: `${where}: travelling e cortes em chicote`, paid: false, invalidates: ["render da cena", "montagem final"], op: "ritmo" });
  if (/(reduz|encurt|diminu|cort).*(narra|texto|fala)|menos narra/.test(t)) changes.push({ kind: "roteiro+áudio", target: target?.stable_key ?? null, description: `${where}: reescrever o trecho mais curto; gera NOVA versão da narração que precisa ser aprovada de novo`, paid: !!getSecret("anthropic"), invalidates: ["master de narração (nova versão)", "aprovação do áudio", "legendas", "cenas e cues dependentes"], op: "reduzir_narracao" });
  if (/(troq|nova|outra).*(imagem|ilustra)/.test(t)) changes.push({ kind: "visual", target: target?.stable_key ?? null, description: `${where}: gerar nova imagem (OpenAI)`, paid: true, invalidates: ["render da cena"], op: "imagem" });
  if (!changes.length) return { understood: false, changes, message: "Não reconheci a alteração. Exemplos: “deixe a cena 4 mais tensa”, “reduza a narração da cena 2”, “troque a imagem da cena 3”." };
  return { understood: true, changes, requiresAudioReapproval: changes.some((c) => c.kind.includes("áudio")), paidSteps: changes.filter((c) => c.paid).length };
}

export function applyCommand(projectId: string, text: string) {
  const plan = planCommand(projectId, text);
  const done: any[] = [];
  for (const c of plan.changes) {
    const targets = listScenes(projectId).filter((s) => !c.target || s.stable_key === c.target);
    if (c.op === "tensao" || c.op === "ritmo") {
      for (const s of targets) {
        const shots = s.data.shots.map((sh: any, i: number) => c.op === "tensao"
          ? { ...sh, camera: { ...sh.camera, move: "push-in", intensity: Math.min(1, (sh.camera.intensity ?? 0.5) + 0.3) }, light: sh.light === "dia" ? "entardecer" : sh.light === "fogueira" ? "fogueira" : "lanterna", fx: [...new Set([...(sh.fx ?? []), "neblina"])] }
          : { ...sh, camera: { ...sh.camera, move: "travelling", intensity: 0.9 }, transitionIn: i > 0 ? "whip" : sh.transitionIn });
        done.push(editScene(projectId, s.stable_key, { shots }));
      }
    } else if (c.op === "reduzir_narracao") {
      if (!getSecret("anthropic")) { done.push({ pending: "Sem chave Anthropic: edite o texto do trecho no Estúdio de voz (ou use o Claude Code) e gere a nova narração." }); continue; }
      done.push({ job: enqueue("script_generate", projectId, { revisionNote: `Reduza a narração ${c.target ? `da cena ${c.target}` : "geral"} mantendo os acontecimentos. Pedido: ${text}` }, { paid: true }).id });
    } else if (c.op === "imagem") {
      done.push({ job: enqueue("image", projectId, { keys: targets.map((s) => s.stable_key), roles: ["fundo"], force: true }, { paid: true }).id });
    }
  }
  return { plan, done };
}
