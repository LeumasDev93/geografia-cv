#!/usr/bin/env node
/**
 * Gera src/dados.ts a partir do dump SQL da tabela `geografia` (regionalização de Cabo Verde).
 * Uso: node scripts/importar.mjs [ficheiro.sql]   (por omissão: dados/geografia.sql)
 * Aceita o ficheiro em UTF-8 ou em Latin-1 (ISO-8859-1), como sai do Oracle/SQL Developer.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ficheiro = resolve(process.argv[2] ?? `${raiz}/dados/geografia.sql`);
const bytes = readFileSync(ficheiro);
let texto = bytes.toString("utf8");
if (texto.includes("�")) texto = bytes.toString("latin1"); // não era UTF-8

// Apóstrofos "tipográficos" que vêm mal convertidos (ex.: PONTA D’ACHADA).
const limpar = (s) => s.replace(/[\u0091\u0092‘’´`]/g, "’").replace(/\s+/g, " ").trim();

const COLUNAS = ["id", "nome", "pais", "ilha", "concelho", "freguesia", "zona", "nome_norm", "nivel_detalhe"];
const valores = (dentro) => {
  const out = [];
  const re = /\s*(?:'((?:[^']|'')*)'|(null))\s*(?:,|$)/giy;
  let m;
  while ((m = re.exec(dentro)) && out.length < COLUNAS.length) out.push(m[2] ? null : m[1].replace(/''/g, "'"));
  return out;
};

const PEQUENAS = new Set(["de", "da", "do", "das", "dos", "e", "d’"]);
/** "ACHADA SANTO ANTÓNIO" → "Achada Santo António"; "PONTA D’ACHADA" → "Ponta d’Achada". */
const formatar = (s) =>
  s
    .toLocaleLowerCase("pt")
    .split(" ")
    .map((p, i) => {
      if (i > 0 && PEQUENAS.has(p)) return p;
      if (/^d’./.test(p)) return `d’${p[2].toLocaleUpperCase("pt")}${p.slice(3)}`;
      return p.charAt(0).toLocaleUpperCase("pt") + p.slice(1);
    })
    .join(" ");

const linhas = [];
const vistos = new Set();
for (const l of texto.split(/\r?\n/)) {
  const m = /^\s*insert\s+into\s+geografia\s*\(([^)]*)\)\s*values\s*\((.*)\)\s*;\s*$/i.exec(l);
  if (!m) continue;
  const cols = m[1].split(",").map((c) => c.trim().toLowerCase());
  const v = valores(m[2]);
  const r = Object.fromEntries(cols.map((c, i) => [c, v[i] ?? null]));
  if (!r.id || vistos.has(r.id)) continue;
  vistos.add(r.id);
  const nivel = Number(r.nivel_detalhe);
  // O "pai" é o nível de cima que estiver preenchido (zona → freguesia → concelho → ilha → país).
  const pai = nivel >= 6 ? r.zona : nivel === 5 ? r.freguesia : nivel === 4 ? r.concelho : nivel === 3 ? r.ilha : nivel === 2 ? r.pais : null;
  const nome = limpar(r.nome);
  linhas.push([r.id, formatar(nome), nivel, pai ?? null]);
}
linhas.sort((a, b) => a[2] - b[2] || a[0].localeCompare(b[0]));

const saida = `/* Gerado por scripts/importar.mjs a partir de ${ficheiro.split("/").pop()} — não editar à mão. */
/** [código, nome, nível, código do pai] */
export type Linha = readonly [string, string, number, string | null];
export const DADOS: readonly Linha[] = ${JSON.stringify(linhas).replace(/\],\[/g, "],\n[")};
`;
writeFileSync(`${raiz}/src/dados.ts`, saida);
const porNivel = linhas.reduce((a, l) => ((a[l[2]] = (a[l[2]] ?? 0) + 1), a), {});
console.log(`${linhas.length} registos →`, porNivel);
