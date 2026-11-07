/** `npm -w server run sons` — busca, avalia e grava os três whooshes Openverse em sons/. */
import { fetchWhooshes, writeKit } from "../sound/openverse.js";
const r = await fetchWhooshes();
console.log("candidatos:", r.candidates.length, "analisados:", r.candidates.filter((c) => c.features).length, "falhas:", r.candidates.filter((c) => c.error).map((c) => c.error).slice(0, 5));
for (const c of r.chosen) console.log(c.role.key, c.score.toFixed(2), c.c.item.title, "|", c.c.item.creator, "|", c.c.item.license, c.c.item.license_version, JSON.stringify(c.c.features));
if (r.chosen.length < 3) { console.error("Menos de três candidatos válidos — etapa fica pendente."); process.exit(2); }
const m = await writeKit(r.chosen);
console.log("gravados:", m.map((x: any) => x.local));
