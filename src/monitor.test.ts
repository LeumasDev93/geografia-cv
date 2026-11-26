import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { comMonitor, middlewareGeografia } from "./index.js";
import { rotaDe } from "./monitor.js";

let portal: Server;
let urlPortal = "";
const recebidos: { pedidos: { rota: string; codigo: number }[] }[] = [];
let config = { manutencao: false, mensagem: null as string | null, bloqueados: [] as { metodo: string; caminho: string }[] };
let cabecalho = "";

beforeAll(async () => {
  portal = createServer((req, res) => {
    cabecalho = String(req.headers.authorization);
    if (req.url === "/api/monitor/config") return res.end(JSON.stringify(config));
    let corpo = "";
    req.on("data", (d) => (corpo += d)).on("end", () => (recebidos.push(JSON.parse(corpo)), res.end("{}")));
  });
  await new Promise<void>((r) => portal.listen(0, r));
  urlPortal = `http://localhost:${(portal.address() as { port: number }).port}`;
});
afterAll(() => portal.close());

it("agrupa rotas por código", () => {
  expect(rotaDe("/geografia/238704/filhos?x=1")).toBe("/geografia/:codigo/filhos");
});

it("envia métricas e respeita manutenção e bloqueios do portal", async () => {
  const h = comMonitor(middlewareGeografia(), { portalUrl: urlPortal, appId: "geografia-cv", chave: "k", semIntervalo: true });
  const srv = createServer((q, r) => void h(q, r));
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://localhost:${(srv.address() as { port: number }).port}`;
  expect((await fetch(`${base}/geografia/238704`)).status).toBe(200);
  await fetch(`${base}/geografia/saude`); // isento
  await h.enviar();
  expect(cabecalho).toBe("Bearer k");
  expect(recebidos.flatMap((r) => r.pedidos)).toEqual([expect.objectContaining({ rota: "/geografia/:codigo", codigo: 200 })]);

  config = { manutencao: false, mensagem: null, bloqueados: [{ metodo: "GET", caminho: "/geografia/pesquisa" }] };
  const h2 = comMonitor(middlewareGeografia(), { portalUrl: urlPortal, appId: "geografia-cv", chave: "k", semIntervalo: true });
  const srv2 = createServer((q, r) => void h2(q, r));
  await new Promise<void>((r) => srv2.listen(0, r));
  const base2 = `http://localhost:${(srv2.address() as { port: number }).port}`;
  expect((await fetch(`${base2}/geografia/pesquisa?q=praia`)).status).toBe(503);
  expect((await fetch(`${base2}/geografia/concelhos`)).status).toBe(200);
  srv.close();
  srv2.close();
});
