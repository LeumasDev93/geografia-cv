/**
 * Rotas HTTP da geografia, independentes de framework.
 * `responder(caminho, query)` devolve { status, corpo }; os adaptadores (Node/Express/Connect, Fastify)
 * só tratam de ler o pedido e escrever a resposta.
 *
 *   GET /docs                 → Swagger UI; /openapi.json → especificação OpenAPI
 *   GET /saude                → { estado: "ok", total } (monitorização)
 *   GET /niveis
 *   GET /ilhas | /concelhos | /freguesias | /zonas | /lugares   ?dentro=<código>
 *   GET /pesquisa?q=<texto>&nivel=zona,lugar&dentro=<código>&limite=20
 *   GET /<código>            → o local com o caminho
 *   GET /<código>/filhos     → os filhos diretos
 */
import { NIVEIS, ROTULO_NIVEL, geografia, type Geografia, type NomeNivel } from "./nucleo.js";
import { lerCorpo, responderAdmin } from "./admin.js";
import type { FonteBase } from "./bd.js";
import { especificacao, paginaSwagger } from "./openapi.js";

export interface Resposta {
  status: number;
  corpo: unknown;
}
type Query = Record<string, string | string[] | undefined>;

const PLURAL: Record<string, NomeNivel> = { ilhas: "ilha", concelhos: "concelho", freguesias: "freguesia", zonas: "zona", lugares: "lugar" };
const um = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const codigo = /^[0-9]{1,20}$/;

export function responder(caminho: string, query: Query = {}, g: Geografia = geografia()): Resposta {
  const partes = caminho.split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
  const dentro = um(query.dentro);
  if (dentro && !codigo.test(dentro)) return { status: 400, corpo: { erro: "Código inválido em 'dentro'" } };

  // Saúde (monitorização do Portal 360): responde 200 com quantos locais estão carregados.
  if (partes.length === 1 && partes[0] === "saude") return { status: g.total > 0 ? 200 : 503, corpo: { estado: g.total > 0 ? "ok" : "sem_dados", total: g.total } };

  if (partes.length === 0 || partes[0] === "niveis")
    return { status: 200, corpo: Object.entries(NIVEIS).map(([chave, n]) => ({ chave, nivel: n, rotulo: ROTULO_NIVEL[chave as NomeNivel] })) };

  if (partes.length === 1 && PLURAL[partes[0]!]) return { status: 200, corpo: g.listar(PLURAL[partes[0]!]!, dentro) };

  if (partes.length === 1 && partes[0] === "pesquisa") {
    const q = um(query.q) ?? "";
    if (q.length < 2) return { status: 400, corpo: { erro: "Escreva pelo menos 2 letras em 'q'" } };
    const niveis = (um(query.nivel) ?? "").split(",").filter((n): n is NomeNivel => n in NIVEIS);
    const limite = Math.min(100, Math.max(1, Number(um(query.limite)) || 20));
    return { status: 200, corpo: g.pesquisar(q.slice(0, 80), { nivel: niveis.length ? niveis : undefined, dentro, limite }) };
  }

  if (codigo.test(partes[0]!)) {
    const d = g.detalhe(partes[0]!);
    if (!d) return { status: 404, corpo: { erro: "Local não encontrado" } };
    if (partes.length === 1) return { status: 200, corpo: d };
    if (partes.length === 2 && partes[1] === "filhos") return { status: 200, corpo: g.filhos(d.id) };
  }
  return { status: 404, corpo: { erro: "Rota não encontrada" } };
}

/** Cabeçalhos: dados públicos que quase nunca mudam (cache de um dia). */
export const CABECALHOS = { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" };

interface PedidoNode {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined> & { authorization?: string };
}
interface RespostaNode {
  statusCode: number;
  setHeader(n: string, v: string): unknown;
  end(corpo?: string): unknown;
}

/**
 * Middleware para Node puro, Express ou Connect: atende os pedidos que começam pelo prefixo
 * e passa os outros ao `next` (ou responde 404 quando não há `next`).
 *
 *   app.use(middlewareGeografia({ prefixo: "/geografia" }))           // Express
 *   http.createServer(middlewareGeografia({ prefixo: "" })).listen(…)  // Node puro
 */
export function middlewareGeografia(
  opcoes: { prefixo?: string; geografia?: Geografia | (() => Geografia | Promise<Geografia>); chaveAdmin?: string; fonteBase?: FonteBase } = {},
) {
  const prefixo = (opcoes.prefixo ?? "/geografia").replace(/\/$/, "");
  return async (req: PedidoNode, res: RespostaNode, next?: (e?: unknown) => void) => {
    const url = new URL(req.url ?? "/", "http://local");
    // Gestão (Portal 360): {prefixo}/admin/...
    if (url.pathname.startsWith(`${prefixo}/admin/`)) {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      let r: Resposta;
      try {
        const corpo = req.method === "GET" || req.method === "DELETE" ? {} : await lerCorpo(req as never);
        r = await responderAdmin(req.method ?? "GET", url.pathname.slice(prefixo.length + 7), corpo, req.headers?.authorization, { chave: opcoes.chaveAdmin, fonte: opcoes.fonteBase });
      } catch (e) {
        r = { status: e instanceof SyntaxError ? 400 : 500, corpo: { erro: e instanceof SyntaxError ? "JSON inválido" : (e as Error).message } };
      }
      res.statusCode = r.status;
      return res.end(JSON.stringify(r.corpo));
    }
    const dentro = url.pathname === prefixo || url.pathname.startsWith(`${prefixo}/`);
    if (!dentro || (req.method && !["GET", "HEAD", "OPTIONS"].includes(req.method))) {
      if (next) return next();
      res.statusCode = 404;
      return res.end();
    }
    // Documentação: {prefixo}/openapi.json e {prefixo}/docs (Swagger UI)
    if (url.pathname === `${prefixo}/openapi.json` || url.pathname === `${prefixo}/docs`) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("cache-control", "public, max-age=300");
      res.statusCode = 200;
      if (url.pathname.endsWith(".json")) {
        res.setHeader("content-type", "application/json; charset=utf-8");
        return res.end(JSON.stringify(especificacao(prefixo)));
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(paginaSwagger(`${prefixo}/openapi.json`));
    }
    for (const [n, v] of Object.entries(CABECALHOS)) res.setHeader(n, v);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }
    let g: Geografia | undefined;
    try {
      g = typeof opcoes.geografia === "function" ? await opcoes.geografia() : opcoes.geografia;
    } catch (e) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ erro: "Dados da regionalização indisponíveis", detalhe: (e as Error).message }));
    }
    const r = responder(url.pathname.slice(prefixo.length), Object.fromEntries(url.searchParams), g);
    res.statusCode = r.status;
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(r.corpo));
  };
}

/** Plugin Fastify (sem depender do Fastify): `app.register(pluginFastifyGeografia, { prefix: "/geografia" })`. */
export async function pluginFastifyGeografia(
  app: { get: (rota: string, h: (req: { url: string; query: unknown; routeOptions?: { url?: string } }, rep: { code: (s: number) => { headers: (h: Record<string, string>) => { send: (c: unknown) => unknown } } }) => unknown) => unknown; prefix?: string },
  opcoes: { geografia?: Geografia } = {},
) {
  const tratar = (req: { url: string; query: unknown }, rep: { code: (s: number) => { headers: (h: Record<string, string>) => { send: (c: unknown) => unknown } } }) => {
    const caminho = new URL(req.url, "http://local").pathname;
    const base = app.prefix ?? "";
    const r = responder(caminho.startsWith(base) ? caminho.slice(base.length) : caminho, (req.query ?? {}) as Query, opcoes.geografia);
    return rep.code(r.status).headers(CABECALHOS).send(r.corpo);
  };
  app.get("/", tratar);
  app.get("/*", tratar);
}
