import "./setup.js";
process.env.ESE_MODO = "servidor";
process.env.ESE_SENHA = "senha-de-teste-123";
process.env.ESE_DOMINIO = "1-2-3-4.sslip.io";
import { test } from "node:test";
import assert from "node:assert/strict";

test("modo servidor: exige login, senha, domínio e cabeçalho anti-CSRF", async () => {
  const { buildApp } = await import("../src/app.js");
  const app = await buildApp({ port: 4870 });
  const h = { host: "1-2-3-4.sslip.io" };
  assert.equal((await app.inject({ method: "GET", url: "/api/painel", headers: h })).statusCode, 401, "sem sessão");
  assert.equal((await app.inject({ method: "GET", url: "/api/painel", headers: { host: "evil.com" } })).statusCode, 403, "host errado");
  assert.equal((await app.inject({ method: "POST", url: "/api/login", headers: { ...h, "x-ese": "1" }, payload: { senha: "errada" } })).statusCode, 401);
  const ok = await app.inject({ method: "POST", url: "/api/login", headers: { ...h, "x-ese": "1" }, payload: { senha: "senha-de-teste-123" } });
  assert.equal(ok.statusCode, 200);
  const cookie = String(ok.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  const c = cookie.split(";")[0];
  assert.equal((await app.inject({ method: "GET", url: "/api/painel", headers: { ...h, cookie: c } })).statusCode, 200, "com sessão");
  assert.equal((await app.inject({ method: "PUT", url: "/api/segredos/openai", headers: { ...h, cookie: c }, payload: { value: "x" } })).statusCode, 403, "sem x-ese");
  assert.equal((await app.inject({ method: "GET", url: "/api/painel", headers: { ...h, cookie: c.slice(0, -2) + "00" } })).statusCode, 401, "cookie adulterado");
  for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/api/login", headers: { ...h, "x-ese": "1" }, payload: { senha: "x" } });
  assert.equal((await app.inject({ method: "POST", url: "/api/login", headers: { ...h, "x-ese": "1" }, payload: { senha: "senha-de-teste-123" } })).statusCode, 429, "limite de tentativas");
  await app.close();
});
