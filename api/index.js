// Vercel: todas as rotas vêm para aqui (ver vercel.json). Usa o build em dist/.
// Com DATABASE_URL lê a tabela `geografia` da base; sem ela, usa os dados incluídos.
import { middlewareGeografia } from "../dist/index.js";
import { geografiaDaBase } from "../dist/bd.js";

const prefixo = process.env.PREFIXO ?? "/geografia";
const fonte = process.env.DATABASE_URL ? geografiaDaBase(process.env.DATABASE_URL, Number(process.env.RECARREGAR_MINUTOS ?? 60)) : undefined;
const mw = middlewareGeografia({ prefixo, geografia: fonte, fonteBase: fonte, chaveAdmin: process.env.CHAVE_ADMIN?.trim() || undefined });

export default function handler(req, res) {
  return mw(req, res, () => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ erro: `Use ${prefixo}/…`, exemplo: `${prefixo}/concelhos` }));
  });
}
