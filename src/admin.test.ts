/** Gestão (precisa de Postgres): TEST_DATABASE_URL=postgres://… npm test */
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { geografiaDaBase, middlewareGeografia } from "./index.js";

const url = process.env.TEST_DATABASE_URL;
const CHAVE = "chave-de-teste-muito-longa";

describe.skipIf(!url)("gestão (Portal 360)", () => {
  let srv: Server;
  let base = "";
  beforeAll(async () => {
    execFileSync("node", ["dist/migrar.js", "--substituir"], { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });
    const fonte = geografiaDaBase(url!, 60);
    const mw = middlewareGeografia({ prefixo: "/geo", geografia: fonte, fonteBase: fonte, chaveAdmin: CHAVE });
    srv = createServer((q, r) => mw(q, r));
    await new Promise<void>((r) => srv.listen(0, r));
    base = `http://localhost:${(srv.address() as { port: number }).port}/geo`;
  });
  afterAll(() => srv?.close());
  const admin = (metodo: string, caminho: string, corpo?: unknown, chave = CHAVE) =>
    fetch(`${base}/admin${caminho}`, { method: metodo, headers: { authorization: `Bearer ${chave}`, "content-type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined });

  it("exige a chave", async () => {
    expect((await admin("GET", "/estado", undefined, "errada")).status).toBe(401);
    const e = await (await admin("GET", "/estado")).json();
    expect(e).toMatchObject({ fonte: "base_de_dados", total: 2363 });
  });
  it("cria, renomeia e remove; as leituras públicas mudam logo", async () => {
    const r = await admin("POST", "/locais", { nome: "Bairro Novo", pai: "238704001001" });
    expect(r.status).toBe(201);
    const novo = await r.json();
    expect(novo).toMatchObject({ nome: "Bairro Novo", nivel: "lugar", pai: "238704001001" });
    expect(novo.id).toMatch(/^238704001001\d{3}$/);
    expect((await admin("POST", "/locais", { nome: "bairro novo", pai: "238704001001" })).status).toBe(409);
    expect((await (await fetch(`${base}/pesquisa?q=bairro%20novo`)).json())[0].id).toBe(novo.id);

    expect((await (await admin("PATCH", `/locais/${novo.id}`, { nome: "Bairro Renovado" })).json()).nome).toBe("Bairro Renovado");
    expect((await admin("DELETE", "/locais/238704")).status).toBe(409); // tem filhos
    expect((await admin("DELETE", `/locais/${novo.id}`)).status).toBe(200);
    expect((await fetch(`${base}/${novo.id}`)).status).toBe(404);
  });
  it("ilha nova em Cabo Verde (pai = 238), com código indicado ou gerado", async () => {
    const r = await admin("POST", "/locais", { nome: "Sal", pai: "238", id: "2384" });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: "2384", nome: "Sal", nivel: "ilha", pai: "238" });
    expect((await (await fetch(`${base}/ilhas`)).json()).map((i: { nome: string }) => i.nome)).toContain("Sal");
    expect((await admin("POST", "/locais", { nome: "sal", pai: "238" })).status).toBe(409);
    const g = await (await admin("POST", "/locais", { nome: "Ilha Teste", pai: "238" })).json();
    expect(g.id).toMatch(/^238\d$/);
    await admin("DELETE", `/locais/${g.id}`);
    await admin("DELETE", "/locais/2384");
  });
  it("concelho novo numa ilha ganha código de 2 dígitos", async () => {
    const c = await (await admin("POST", "/locais", { nome: "Concelho Teste", pai: "2387" })).json();
    expect(c.id).toMatch(/^2387\d{2}$/);
    expect(c.nivel).toBe("concelho");
    await admin("DELETE", `/locais/${c.id}`);
  });
});
