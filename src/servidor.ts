#!/usr/bin/env node
/** Serviço autónomo: `PORT=4100 node dist/servidor.js` → http://localhost:4100/geografia/concelhos */
import { createServer } from "node:http";
import { middlewareGeografia } from "./http.js";

const porta = Number(process.env.PORT ?? 4100);
const prefixo = process.env.PREFIXO ?? "/geografia";
createServer(middlewareGeografia({ prefixo })).listen(porta, () => console.log(`Geografia de Cabo Verde em http://localhost:${porta}${prefixo}`));
