// Vercel: todas as rotas vêm para aqui (ver vercel.json). Usa o build em dist/.
// Com DATABASE_URL lê a tabela `geografia` da base; sem ela, usa os dados incluídos.
import { middlewareGeografia } from "../dist/index.js";
import { geografiaDaBase } from "../dist/bd.js";
import { comMonitor } from "../dist/monitor.js";

const prefixo = process.env.PREFIXO ?? "/geografia";
const fonte = process.env.DATABASE_URL ? geografiaDaBase(process.env.DATABASE_URL, Number(process.env.RECARREGAR_MINUTOS ?? 60), Number(process.env.VERIFICAR_SEGUNDOS ?? 10)) : undefined;
const mw0 = middlewareGeografia({ prefixo, geografia: fonte, fonteBase: fonte, chaveAdmin: process.env.CHAVE_ADMIN?.trim() || undefined });

// Monitorização do Portal 360 (PORTAL_URL + PORTAL_APP_ID + MONITOR_CHAVE). Na Vercel envia no fim de cada pedido.
const mw = comMonitor(mw0, { isentos: [`${prefixo}/saude`], semIntervalo: true });

export default async function handler(req, res) {
  await mw(req, res, () => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ erro: `Use ${prefixo}/…`, exemplo: `${prefixo}/concelhos` }));
  });
  await mw.enviar();
}
