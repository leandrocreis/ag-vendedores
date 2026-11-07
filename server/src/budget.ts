import { db, j } from "./db.js";
import { getConfig, spentUsd } from "./providers/config.js";
import { UserError } from "./util.js";

/** No limite de orçamento, pausa ANTES da próxima geração paga. */
export function assertBudget(projectId: string, nextCostUsd: number | null, label: string) {
  const p = db().prepare("SELECT settings_json FROM projects WHERE id=?").get(projectId) as any;
  const limit = j<any>(p?.settings_json, {}).budgetUsd ?? getConfig("budget").projectDefaultUsd;
  const spent = spentUsd(projectId);
  if (nextCostUsd == null) return { limit, spent, next: null, note: "custo desta etapa indisponível — confirme manualmente" };
  if (spent + nextCostUsd > limit + 1e-9) {
    throw new UserError(`Orçamento do projeto atingido: gasto estimado US$ ${spent.toFixed(2)} + ${label} US$ ${nextCostUsd.toFixed(2)} > limite US$ ${limit.toFixed(2)}. Aumente o limite em Configurações do projeto.`, 402, "Revisar orçamento");
  }
  return { limit, spent, next: nextCostUsd };
}
