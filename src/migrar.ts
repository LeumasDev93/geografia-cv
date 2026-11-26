#!/usr/bin/env node
/**
 * `npm run migrate`: cria a tabela `geografia` na base (DATABASE_URL) e, se estiver vazia, carrega
 * o dump oficial (dados/geografia.sql). Pode correr várias vezes: não duplica nem apaga nada.
 *   --substituir   apaga os dados da tabela e volta a carregar o dump (para atualizar a regionalização)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { garantirMeta, ligar, marcarAlteracao, transacao } from "./bd.js";

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

-- Vistas por nível (para relatórios e consultas diretas): os dados continuam só na tabela geografia.
CREATE OR REPLACE VIEW vw_ilhas AS
  SELECT g.id, g.nome, g.pais FROM geografia g WHERE g.nivel_detalhe = '2';
CREATE OR REPLACE VIEW vw_concelhos AS
  SELECT g.id, g.nome, g.ilha, i.nome AS ilha_nome
    FROM geografia g LEFT JOIN geografia i ON i.id = g.ilha
   WHERE g.nivel_detalhe = '3';
CREATE OR REPLACE VIEW vw_freguesias AS
  SELECT g.id, g.nome, g.concelho, c.nome AS concelho_nome, g.ilha, i.nome AS ilha_nome
    FROM geografia g LEFT JOIN geografia c ON c.id = g.concelho LEFT JOIN geografia i ON i.id = g.ilha
   WHERE g.nivel_detalhe = '4';
CREATE OR REPLACE VIEW vw_zonas AS
  SELECT g.id, g.nome, g.freguesia, f.nome AS freguesia_nome, g.concelho, c.nome AS concelho_nome, g.ilha, i.nome AS ilha_nome
    FROM geografia g LEFT JOIN geografia f ON f.id = g.freguesia LEFT JOIN geografia c ON c.id = g.concelho LEFT JOIN geografia i ON i.id = g.ilha
   WHERE g.nivel_detalhe = '5';
CREATE OR REPLACE VIEW vw_lugares AS
  SELECT g.id, g.nome, g.zona, z.nome AS zona_nome, g.freguesia, f.nome AS freguesia_nome, g.concelho, c.nome AS concelho_nome, g.ilha, i.nome AS ilha_nome
    FROM geografia g LEFT JOIN geografia z ON z.id = g.zona LEFT JOIN geografia f ON f.id = g.freguesia
    LEFT JOIN geografia c ON c.id = g.concelho LEFT JOIN geografia i ON i.id = g.ilha
   WHERE g.nivel_detalhe = '6';
`;

const pool = await ligar(url);
try {
  await pool.query(DDL);
  await garantirMeta(pool);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM geografia");
  const existentes = Number(rows[0]?.n ?? 0);
  if (existentes && !substituir) {
    console.log(`Tabela geografia já tem ${existentes} registos; vistas vw_* atualizadas (use --substituir para recarregar o dump).`);
  } else {
    const bytes = readFileSync(ficheiro);
    let texto = bytes.toString("utf8");
    if (texto.includes("�")) texto = bytes.toString("latin1"); // dump em Latin-1
    const inserts = texto
      .split(/\r?\n/)
      .filter((l) => /^\s*insert\s+into\s+geografia\b/i.test(l))
      .map((l) => l.trim().replace(/;\s*$/, "") + " ON CONFLICT (id) DO NOTHING;");
    await transacao(pool, async (c) => {
      await marcarAlteracao(c);
      if (substituir) await c.query("DELETE FROM geografia");
      for (let i = 0; i < inserts.length; i += 300) await c.query(inserts.slice(i, i + 300).join("\n"));
    });
    const n = (await pool.query("SELECT count(*)::int AS n FROM geografia")).rows[0]?.n;
    console.log(`✔ Tabela geografia carregada: ${n} registos (de ${inserts.length} no dump).`);
  }
} catch (e) {
  console.error(`✖ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
