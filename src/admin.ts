/**
 * Gestão da regionalização (para o Portal 360): criar, renomear e remover locais na tabela `geografia`.
 * Só funciona com base de dados (DATABASE_URL) e com a chave CHAVE_ADMIN no cabeçalho
 * `Authorization: Bearer <chave>`. Nunca exponha a chave no browser: chame a partir do servidor.
 *
 *   GET    {prefixo}/admin/estado
 *   POST   {prefixo}/admin/locais            { nome, pai, id? }   → cria um filho de `pai`
 *   PATCH  {prefixo}/admin/locais/<código>   { nome }
 *   DELETE {prefixo}/admin/locais/<código>                         → só sem filhos
 *   POST   {prefixo}/admin/recarregar
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NIVEIS, normalizar, type NomeNivel } from "./nucleo.js";
import type { FonteBase } from "./bd.js";
import type { Resposta } from "./http.js";

const COLUNA: Record<number, string> = { 1: "pais", 2: "ilha", 3: "concelho", 4: "freguesia", 5: "zona" };
/** Quantos dígitos o código ganha em cada nível (ilha 2387 → concelho 238704 → freguesia 238704001 …). */
const DIGITOS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 3, 6: 3 };

const igual = (a: string, b: string) => {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
};
const erro = (status: number, mensagem: string): Resposta => ({ status, corpo: { erro: mensagem } });

export async function responderAdmin(
  metodo: string,
  caminho: string,
  corpo: unknown,
  autorizacao: string | undefined,
  opcoes: { chave?: string; fonte?: FonteBase },
): Promise<Resposta> {
  if (!opcoes.chave) return erro(503, "Gestão desligada: defina CHAVE_ADMIN no serviço");
  const dada = (autorizacao ?? "").replace(/^Bearer\s+/i, "");
  if (!dada || !igual(dada, opcoes.chave)) return erro(401, "Chave de gestão inválida");
  const fonte = opcoes.fonte;
  if (!fonte) return erro(409, "A gestão precisa de base de dados (DATABASE_URL)");

  const partes = caminho.split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
  const g = await fonte();
  const pool = await fonte.pool();
  const b = (corpo ?? {}) as Record<string, unknown>;

  if (metodo === "GET" && partes[0] === "estado") {
    const porNivel = Object.fromEntries(Object.keys(NIVEIS).map((n) => [n, g.listar(n as NomeNivel).length]));
    return { status: 200, corpo: { fonte: "base_de_dados", total: g.total, porNivel, carregadaEm: fonte.carregadaEm() } };
  }
  if (metodo === "POST" && partes[0] === "recarregar") {
    const n = await fonte.recarregar();
    return { status: 200, corpo: { total: n.total, carregadaEm: fonte.carregadaEm() } };
  }

  if (partes[0] !== "locais") return erro(404, "Rota não encontrada");
  const nome = typeof b.nome === "string" ? b.nome.replace(/\s+/g, " ").trim() : "";
  if ((metodo === "POST" || metodo === "PATCH") && (nome.length < 2 || nome.length > 120)) return erro(400, "O nome tem de ter entre 2 e 120 letras");
  const nomeBd = nome.toLocaleUpperCase("pt");

  // Criar um filho
  if (metodo === "POST" && partes.length === 1) {
    const pai = typeof b.pai === "string" ? g.obter(b.pai) : null;
    if (!pai) return erro(400, "Indique o local de cima (pai) com um código existente");
    const nivelPai = NIVEIS[pai.nivel];
    const nivel = nivelPai + 1;
    if (nivel > 6) return erro(400, "Um lugar não pode ter locais por baixo");
    const irmaos = g.filhos(pai.id);
    if (irmaos.some((l) => normalizar(l.nome) === normalizar(nome))) return erro(409, `Já existe «${nome}» em ${pai.nome}`);
    let id = typeof b.id === "string" && b.id.trim() ? b.id.trim() : "";
    if (id) {
      if (!/^[0-9]{2,20}$/.test(id)) return erro(400, "O código só pode ter algarismos");
      if (g.obter(id)) return erro(409, "Já existe um local com esse código");
    } else {
      // Próximo número livre por baixo do pai (ex.: 238704 → 238704002).
      const d = DIGITOS[nivel]!;
      const usados = irmaos.map((l) => l.id).filter((x) => x.startsWith(pai.id) && x.length === pai.id.length + d).map((x) => Number(x.slice(pai.id.length)));
      let n = usados.length ? Math.max(...usados) + 1 : 1;
      while (g.obter(pai.id + String(n).padStart(d, "0"))) n++;
      if (String(n).length > d) return erro(409, "Não há mais códigos livres neste nível; indique o código (id)");
      id = pai.id + String(n).padStart(d, "0");
    }
    // Colunas de cima: copiadas do caminho do pai.
    const cols: Record<string, string | null> = { pais: null, ilha: null, concelho: null, freguesia: null, zona: null };
    for (const l of g.caminho(pai.id)) cols[COLUNA[NIVEIS[l.nivel]]!] = l.id;
    if (nivel === 2) cols.pais = pai.id;
    if (!cols.pais) cols.pais = g.caminho(pai.id)[0]?.pai ?? null;
    await pool.query(
      `INSERT INTO geografia (id, nome, pais, ilha, concelho, freguesia, zona, nome_norm, nivel_detalhe) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, nomeBd, cols.pais, cols.ilha, cols.concelho, cols.freguesia, cols.zona, normalizar(nome).toUpperCase(), String(nivel)],
    );
    const nova = await fonte.recarregar();
    return { status: 201, corpo: nova.detalhe(id) };
  }

  const id = partes[1];
  if (!id || partes.length !== 2) return erro(404, "Rota não encontrada");
  const local = g.obter(id);
  if (!local) return erro(404, "Local não encontrado");

  if (metodo === "PATCH") {
    const irmaos = local.pai ? g.filhos(local.pai) : [];
    if (irmaos.some((l) => l.id !== id && normalizar(l.nome) === normalizar(nome))) return erro(409, `Já existe «${nome}» no mesmo sítio`);
    await pool.query("UPDATE geografia SET nome = $2, nome_norm = $3 WHERE id = $1", [id, nomeBd, normalizar(nome).toUpperCase()]);
    const nova = await fonte.recarregar();
    return { status: 200, corpo: nova.detalhe(id) };
  }
  if (metodo === "DELETE") {
    const filhos = g.filhos(id).length;
    if (filhos) return erro(409, `${local.nome} tem ${filhos} local(is) por baixo: remova-os primeiro`);
    await pool.query("DELETE FROM geografia WHERE id = $1", [id]);
    await fonte.recarregar();
    return { status: 200, corpo: { ok: true } };
  }
  return erro(405, "Método não suportado");
}

/** Lê o corpo JSON de um pedido Node (até 64 KB). */
export async function lerCorpo(req: AsyncIterable<Buffer | string> & { body?: unknown }): Promise<unknown> {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body; // Vercel/Express já leram
  let texto = "";
  for await (const parte of req) {
    texto += parte.toString();
    if (texto.length > 65536) throw new Error("Pedido demasiado grande");
  }
  return texto ? JSON.parse(texto) : {};
}
