#!/usr/bin/env node
/**
 * Serviço autónomo: `npm start` → http://localhost:4100/geografia/concelhos
 * Com DATABASE_URL (ex.: Neon), lê a tabela `geografia` da base; sem ela, usa os dados incluídos.
 */
import { createServer } from "node:http";
import { middlewareGeografia } from "./http.js";
import { geografiaDaBase } from "./bd.js";
import { comMonitor } from "./monitor.js";

const porta = Number(process.env.PORT ?? 4100);
const prefixo = process.env.PREFIXO ?? "/geografia";
const url = process.env.DATABASE_URL;
const fonte = url ? geografiaDaBase(url, Number(process.env.RECARREGAR_MINUTOS ?? 60), Number(process.env.VERIFICAR_SEGUNDOS ?? 10)) : undefined;

if (fonte) {
  try {
    const g = await fonte();
    console.log(`Base de dados: ${g.total} registos carregados.`);
  } catch (e) {
    console.error(`✖ Não foi possível ler a base de dados: ${(e as Error).message}`);
    process.exit(1);
  }
}
const chaveAdmin = process.env.CHAVE_ADMIN?.trim() || undefined;
// Monitorização do Portal 360 (PORTAL_URL + PORTAL_APP_ID + MONITOR_CHAVE); sem elas, não faz nada.
const tratar = comMonitor(middlewareGeografia({ prefixo, geografia: fonte, fonteBase: fonte, chaveAdmin }), { isentos: [`${prefixo}/saude`] });
if (tratar.ativo) console.log("Monitorização do Portal 360 ligada.");
createServer(tratar).listen(porta, () =>
  console.log(`Geografia de Cabo Verde em http://localhost:${porta}${prefixo}${fonte ? " (dados da base de dados)" : " (dados incluídos)"}`),
);
