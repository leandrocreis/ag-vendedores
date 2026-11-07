import { doctor } from "../diagnostics.js";
const r = await doctor();
const icon = { ok: "✔", aviso: "!", falta: "✘" } as const;
let area = "";
for (const i of r.items) {
  if (i.area !== area) { area = i.area; console.log(`\n${area}`); }
  console.log(`  ${icon[i.state]} ${i.item.padEnd(28)} ${i.detail}`);
}
console.log(`\nResumo: ${r.summary.ok} ok · ${r.summary.aviso} avisos · ${r.summary.falta} faltando`);
process.exit(r.summary.falta ? 1 : 0);
