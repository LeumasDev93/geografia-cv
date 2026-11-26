// Vercel: todas as rotas vêm para aqui (ver vercel.json). Usa o build em dist/.
import { middlewareGeografia } from "../dist/index.js";

const prefixo = process.env.PREFIXO ?? "/geografia";
const mw = middlewareGeografia({ prefixo });

export default function handler(req, res) {
  mw(req, res, () => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ erro: `Use ${prefixo}/…`, exemplo: `${prefixo}/concelhos` }));
  });
}
