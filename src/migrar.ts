#!/usr/bin/env node
/**
 * `npm run migrate`: cria a tabela `geografia` na base (DATABASE_URL) e, se estiver vazia, carrega
 * o dump oficial (dados/geografia.sql). Pode correr várias vezes: não duplica nem apaga nada.
 *   --substituir   apaga os dados da tabela e volta a carregar o dump (para atualizar a regionalização)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ligar } from "./bd.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✖ Falta DATABASE_URL (ponha-a no ficheiro .env, ver .env.example).");
  process.exit(1);
}
const substituir = process.argv.includes("--substituir");
const ficheiro = resolve(dirname(fileURLToPath(import.meta.url)), "..", process.env.FICHEIRO_SQL ?? "dados/geografia.sql");

const DDL = `
CREATE TABLE IF NOT EXISTS geografia (
  id varchar(50) NOT NULL PRIMARY KEY,
  nome varchar(300) NOT NULL,
  pais varchar(50),
  ilha varchar(50),
  concelho varchar(50),
  freguesia varchar(50),
  zona varchar(50),
  nome_norm varchar(300),
  nivel_detalhe varchar(2) NOT NULL
);
CREATE INDEX IF NOT EXISTS geografia_nivel ON geografia (nivel_detalhe);
CREATE INDEX IF NOT EXISTS geografia_concelho ON geografia (concelho);
`;

const pool = await ligar(url);
try {
  await pool.query(DDL);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM geografia");
  const existentes = Number(rows[0]?.n ?? 0);
  if (existentes && !substituir) {
    console.log(`Tabela geografia já tem ${existentes} registos. Nada a fazer (use --substituir para recarregar o dump).`);
  } else {
    const bytes = readFileSync(ficheiro);
    let texto = bytes.toString("utf8");
    if (texto.includes("�")) texto = bytes.toString("latin1"); // dump em Latin-1
    const inserts = texto
      .split(/\r?\n/)
      .filter((l) => /^\s*insert\s+into\s+geografia\b/i.test(l))
      .map((l) => l.trim().replace(/;\s*$/, "") + " ON CONFLICT (id) DO NOTHING;");
    await pool.query("BEGIN");
    if (substituir) await pool.query("DELETE FROM geografia");
    for (let i = 0; i < inserts.length; i += 300) await pool.query(inserts.slice(i, i + 300).join("\n"));
    await pool.query("COMMIT");
    const n = (await pool.query("SELECT count(*)::int AS n FROM geografia")).rows[0]?.n;
    console.log(`✔ Tabela geografia carregada: ${n} registos (de ${inserts.length} no dump).`);
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  console.error(`✖ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
