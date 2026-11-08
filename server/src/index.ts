import { buildApp } from "./app.js";
import { refreshCatalog } from "./catalog/catalog.js";
import { db } from "./db.js";

/** Servidor local: SEMPRE em loopback (127.0.0.1). Não exponha esta porta na rede. */
const port = Number(process.env.PORTA ?? 4870);
const dev = process.argv.includes("--dev");
const app = await buildApp({ port, devOrigins: dev ? ["http://127.0.0.1:5173", "http://localhost:5173"] : [] });
const count = (db().prepare("SELECT COUNT(*) n FROM styles").get() as any).n;
if (!count) {
  const r = await refreshCatalog();
  console.log(`[catálogo] ${r.added.length} estilos importados`);
}
// Modo servidor: escuta na rede interna do Docker; só o Caddy (HTTPS) é exposto.
await app.listen({ host: process.env.ESE_MODO === "servidor" ? "0.0.0.0" : "127.0.0.1", port });
console.log(`E Se? Studio em http://127.0.0.1:${port}`);
