/**
 * Agente de monitorização do Portal 360 (mesmo protocolo das outras aplicações):
 *  - mede cada pedido (rota, código, tempo) e envia ao portal em lotes (POST {PORTAL_URL}/api/monitor/ingest);
 *  - lê do portal a configuração (GET /api/monitor/config, cache de 30 s): em manutenção responde 503
 *    com a mensagem; um endpoint bloqueado responde 503 "temporariamente indisponível".
 * Autenticação: X-App-Id = PORTAL_APP_ID e Authorization: Bearer MONITOR_CHAVE (gerada no portal).
 * Sem estas variáveis não faz nada. O portal nunca faz falhar um pedido: se não responder, fica a última configuração.
 */
type Bloqueio = { metodo: string; caminho: string };
type Config = { manutencao: boolean; mensagem: string | null; bloqueados: Bloqueio[] };
type Pedido = { metodo: string; rota: string; codigo: number; ms: number; em: number };

interface Req {
  method?: string;
  url?: string;
}
interface Res {
  statusCode: number;
  setHeader(n: string, v: string): unknown;
  end(corpo?: string): unknown;
}
type Handler = (req: Req, res: Res, next?: () => void) => unknown;

const CACHE_MS = 30_000;
const LOTE_MS = 15_000;
const LOTE_MAX = 100;

/** "/geografia/238704/filhos" → "/geografia/:codigo/filhos" (agrupa as métricas por rota). */
export function rotaDe(caminho: string) {
  return caminho.split("?")[0]!.replace(/\/[0-9]{2,20}(?=\/|$)/g, "/:codigo") || "/";
}

export function corresponde(b: Bloqueio, metodo: string, caminho: string) {
  if (b.metodo !== "*" && b.metodo.toUpperCase() !== metodo) return false;
  if (b.caminho === caminho) return true;
  const partes = b.caminho.split("/");
  const reais = caminho.split("/");
  if (partes[partes.length - 1] === "*") return reais.slice(0, partes.length - 1).join("/") === partes.slice(0, -1).join("/");
  return partes.length === reais.length && partes.every((p, i) => p === reais[i] || p.startsWith(":"));
}

export function comMonitor(
  handler: Handler,
  opcoes: { portalUrl?: string; appId?: string; chave?: string; isentos?: string[]; fetch?: typeof fetch; semIntervalo?: boolean } = {},
): Handler & { enviar: () => Promise<void>; ativo: boolean } {
  const portal = (opcoes.portalUrl ?? process.env.PORTAL_URL ?? "").trim().replace(/\/+$/, "");
  const appId = (opcoes.appId ?? process.env.PORTAL_APP_ID ?? "").trim();
  const chave = (opcoes.chave ?? process.env.MONITOR_CHAVE ?? "").trim();
  const f = opcoes.fetch ?? fetch;
  const isentos = opcoes.isentos ?? ["/geografia/saude", "/saude"];
  if (!portal || !appId || !chave) return Object.assign(handler, { enviar: async () => {}, ativo: false });

  const cabecalhos = { "X-App-Id": appId, Authorization: `Bearer ${chave}`, "Content-Type": "application/json" };
  let config: Config = { manutencao: false, mensagem: null, bloqueados: [] };
  let configEm = 0;
  let aLer: Promise<void> | null = null;
  let lote: Pedido[] = [];
  let ultimoEnvio = Date.now();

  const lerConfig = () =>
    (aLer ??= (async () => {
      try {
        const r = await f(`${portal}/api/monitor/config`, { headers: cabecalhos, signal: AbortSignal.timeout(3000) });
        if (r.ok) config = (await r.json()) as Config;
      } catch {
        /* portal indisponível */
      } finally {
        configEm = Date.now();
        aLer = null;
      }
    })());

  const enviar = async () => {
    if (!lote.length) return;
    const pedidos = lote;
    lote = [];
    ultimoEnvio = Date.now();
    await f(`${portal}/api/monitor/ingest`, { method: "POST", headers: cabecalhos, body: JSON.stringify({ pedidos }), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  };
  if (!opcoes.semIntervalo) setInterval(() => void enviar(), LOTE_MS).unref?.();

  const envolvido = async (req: Req, res: Res, next?: () => void) => {
    const caminho = (req.url ?? "/").split("?")[0]!;
    if (req.method === "OPTIONS" || isentos.some((i) => caminho === i || caminho.startsWith(`${i}/`))) return handler(req, res, next);
    if (!configEm) await lerConfig();
    else if (Date.now() - configEm > CACHE_MS) void lerConfig();

    const inicio = performance.now();
    const registar = () => {
      lote.push({ metodo: req.method ?? "GET", rota: rotaDe(caminho), codigo: res.statusCode, ms: Math.round(performance.now() - inicio), em: Date.now() });
      if (lote.length >= LOTE_MAX || Date.now() - ultimoEnvio >= LOTE_MS) void enviar();
    };
    const responder503 = (corpo: object) => {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("retry-after", "120");
      res.end(JSON.stringify(corpo));
      registar();
    };
    if (config.manutencao) return responder503({ erro: config.mensagem || "Estamos em manutenção. Voltamos dentro de momentos.", codigo: "manutencao", manutencao: true });
    if (config.bloqueados.some((b) => corresponde(b, req.method ?? "GET", caminho)))
      return responder503({ erro: "Este serviço está temporariamente indisponível.", codigo: "bloqueado", bloqueado: true });

    await handler(req, res, next);
    registar();
  };
  return Object.assign(envolvido, { enviar, ativo: true });
}
