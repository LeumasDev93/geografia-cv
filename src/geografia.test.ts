import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { geografia, middlewareGeografia, normalizar, responder } from "./index.js";

const g = geografia();

describe("núcleo", () => {
  it("carrega a hierarquia de Santiago", () => {
    expect(g.total).toBeGreaterThan(2300);
    expect(g.listar("concelho").map((c) => c.nome)).toContain("Praia");
    expect(g.listar("concelho", "2387")).toHaveLength(9);
  });
  it("caminho e antepassados", () => {
    const l = g.encontrar("ACHADA SANTO ANTONIO", { nivel: "lugar", dentro: "238704" })!;
    expect(l.nome).toBe("Achada Santo António");
    expect(g.caminho(l.id).map((x) => x.nivel)).toEqual(["ilha", "concelho", "freguesia", "zona", "lugar"]);
    expect(g.acima(l.id, "concelho")?.nome).toBe("Praia");
  });
  it("pesquisa sem acentos e por partes", () => {
    expect(normalizar("São Lourenço dos Órgãos")).toBe("sao lourenco orgaos");
    expect(g.pesquisar("sao lourenco", { nivel: "concelho" })[0]?.nome).toBe("São Lourenço dos Órgãos");
    const r = g.pesquisar("palmarejo", { dentro: "238704" });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => g.acima(x.id, "concelho")?.id === "238704")).toBe(true);
  });
  it("descendentes por nível", () => {
    const zonasPraia = g.listar("zona", "238704");
    expect(zonasPraia.length).toBeGreaterThan(5);
    expect(zonasPraia.every((z) => z.nivel === "zona")).toBe(true);
  });
});

describe("http", () => {
  it("responder", () => {
    expect(responder("/concelhos", { dentro: "2387" }).corpo).toHaveLength(9);
    expect(responder("/238704").corpo).toMatchObject({ nome: "Praia", nivel: "concelho" });
    expect(responder("/238704/filhos").status).toBe(200);
    expect(responder("/999").status).toBe(404);
    expect(responder("/saude")).toMatchObject({ status: 200, corpo: { estado: "ok" } });
    expect(responder("/pesquisa", { q: "a" }).status).toBe(400);
    expect(responder("/concelhos", { dentro: "x;drop" }).status).toBe(400);
  });
  it("middleware em Node puro (passa o resto ao next)", async () => {
    const mw = middlewareGeografia({ prefixo: "/geo" });
    const srv = createServer((req, res) => mw(req, res, () => res.writeHead(418).end()));
    await new Promise<void>((r) => srv.listen(0, r));
    const porta = (srv.address() as { port: number }).port;
    const r = await fetch(`http://localhost:${porta}/geo/pesquisa?q=praia&nivel=concelho`);
    expect(r.headers.get("cache-control")).toContain("max-age");
    expect((await r.json())[0].nome).toBe("Praia");
    expect((await fetch(`http://localhost:${porta}/outra`)).status).toBe(418);
    const spec = await (await fetch(`http://localhost:${porta}/geo/openapi.json`)).json();
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.servers[0].url).toBe("/geo");
    expect((await fetch(`http://localhost:${porta}/geo/docs`)).headers.get("content-type")).toContain("text/html");
    srv.close();
  });
});
