/**
 * Gestão da regionalização (para o Portal 360): criar, renomear e remover locais na tabela `geografia`.
 * Só funciona com base de dados (DATABASE_URL) e com a chave CHAVE_ADMIN no cabeçalho
 * `Authorization: Bearer <chave>`. Nunca exponha a chave no browser: chame a partir do servidor.
 *
 *   GET    {prefixo}/admin/estado
 *   POST   {prefixo}/admin/locais            { nome, pai, id? }   → cria um filho de `pai` (ilha nova: pai = "238")
 *   PATCH  {prefixo}/admin/locais/<código>   { nome }
 *   DELETE {prefixo}/admin/locais/<código>                         → só sem filhos
 *   POST   {prefixo}/admin/recarregar
 *   GET    {prefixo}/admin/exportar                           → todas as linhas da tabela (formato do dump)
 *   POST   {prefixo}/admin/importar          { linhas, modo: "atualizar" | "substituir", simular }
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NIVEIS, normalizar, type NomeNivel } from "./nucleo.js";
import { transacao, type FonteBase } from "./bd.js";
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

  if (metodo === "GET" && partes[0] === "exportar") {
    const { rows } = await pool.query("SELECT id, nome, pais, ilha, concelho, freguesia, zona, nome_norm, nivel_detalhe FROM geografia ORDER BY nivel_detalhe, id");
    return { status: 200, corpo: rows };
  }
  if (metodo === "POST" && partes[0] === "importar") return importar(b, pool, fonte);

  if (partes[0] !== "locais") return erro(404, "Rota não encontrada");
  const nome = typeof b.nome === "string" ? b.nome.replace(/\s+/g, " ").trim() : "";
  if ((metodo === "POST" || metodo === "PATCH") && (nome.length < 2 || nome.length > 120)) return erro(400, "O nome tem de ter entre 2 e 120 letras");
  const nomeBd = nome.toLocaleUpperCase("pt");

  // Criar um filho
  if (metodo === "POST" && partes.length === 1) {
    // O país não é uma linha da tabela: uma ilha nova tem como "pai" o código do país (ex.: 238 = Cabo Verde).
    const paisId = typeof b.pai === "string" && /^[0-9]{1,5}$/.test(b.pai) && !g.obter(b.pai) && (g.listar("ilha").some((i) => i.pai === b.pai) || b.pai === "238") ? b.pai : null;
    const pai = paisId ? { id: paisId, nome: "Cabo Verde", nivel: "pais" as const, pai: null } : typeof b.pai === "string" ? g.obter(b.pai) : null;
    if (!pai) return erro(400, "Indique o local de cima (pai) com um código existente");
    const nivelPai = NIVEIS[pai.nivel];
    const nivel = nivelPai + 1;
    if (nivel > 6) return erro(400, "Um lugar não pode ter locais por baixo");
    const irmaos = paisId ? g.listar("ilha").filter((i) => i.pai === paisId) : g.filhos(pai.id);
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
    if (!paisId) for (const l of g.caminho(pai.id)) cols[COLUNA[NIVEIS[l.nivel]]!] = l.id;
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

/** Lê o corpo JSON de um pedido Node (até 8 MB: a importação envia a tabela inteira). */
export async function lerCorpo(req: AsyncIterable<Buffer | string> & { body?: unknown }, maximo = 8 * 1024 * 1024): Promise<unknown> {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body; // Vercel/Express já leram
  let texto = "";
  for await (const parte of req) {
    texto += parte.toString();
    if (texto.length > maximo) throw new Error("Pedido demasiado grande");
  }
  return texto ? JSON.parse(texto) : {};
}

// ---------------------------------------------------------------- Importação (tabela inteira ou parte)

type LinhaTabela = { id: string; nome: string; pais: string | null; ilha: string | null; concelho: string | null; freguesia: string | null; zona: string | null; nome_norm: string; nivel_detalhe: string };
const COLS = ["pais", "ilha", "concelho", "freguesia", "zona"] as const;
const PAI_DO_NIVEL: Record<number, (typeof COLS)[number]> = { 2: "pais", 3: "ilha", 4: "concelho", 5: "freguesia", 6: "zona" };

/**
 * Importa linhas no formato da tabela (id, nome, pais, ilha, concelho, freguesia, zona, nivel_detalhe).
 *  - modo "atualizar" (por omissão): cria as novas e atualiza as que mudaram; não apaga nada.
 *  - modo "substituir": a tabela fica igual ao ficheiro (as que não vierem são apagadas).
 *  - simular: só devolve o resumo (nada é gravado).
 * Tudo numa transação: ou entra tudo, ou nada.
 */
async function importar(b: Record<string, unknown>, pool: Awaited<ReturnType<FonteBase["pool"]>>, fonte: FonteBase): Promise<Resposta> {
  const modo = b.modo === "substituir" ? "substituir" : "atualizar";
  const simular = b.simular !== false;
  if (!Array.isArray(b.linhas) || !b.linhas.length) return erro(400, "Envie as linhas em «linhas»");
  if (b.linhas.length > 50_000) return erro(400, "Demasiadas linhas (máx. 50 000)");

  const invalidas: { linha: number; id?: string; motivo: string }[] = [];
  const validas = new Map<string, LinhaTabela>();
  const texto = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" || String(v).trim().toLowerCase() === "null" ? null : String(v).trim());
  (b.linhas as Record<string, unknown>[]).forEach((l, i) => {
    const id = texto(l.id);
    const nome = texto(l.nome); // como vem no ficheiro (o serviço formata ao mostrar)
    const nivel = Number(texto(l.nivel_detalhe) ?? texto(l.nivel));
    if (!id || !/^[0-9]{1,20}$/.test(id)) return invalidas.push({ linha: i + 1, id: id ?? undefined, motivo: "Código (id) em falta ou com letras" });
    if (!nome || nome.length < 2) return invalidas.push({ linha: i + 1, id, motivo: "Nome em falta" });
    if (!(nivel >= 2 && nivel <= 6)) return invalidas.push({ linha: i + 1, id, motivo: "Nível (nivel_detalhe) tem de ser 2 a 6" });
    if (validas.has(id)) return invalidas.push({ linha: i + 1, id, motivo: "Código repetido no ficheiro" });
    const linha: LinhaTabela = { id, nome, pais: null, ilha: null, concelho: null, freguesia: null, zona: null, nome_norm: texto(l.nome_norm) ?? normalizar(nome).toUpperCase(), nivel_detalhe: String(nivel) };
    for (const c of COLS) linha[c] = texto(l[c]);
    if (nivel >= 3 && !linha[PAI_DO_NIVEL[nivel]!]) return invalidas.push({ linha: i + 1, id, motivo: `Falta o código do nível de cima (${PAI_DO_NIVEL[nivel]})` });
    validas.set(id, linha);
  });

  const atuais = new Map((await pool.query("SELECT id, nome, pais, ilha, concelho, freguesia, zona, nome_norm, nivel_detalhe FROM geografia")).rows.map((r) => [String(r.id), r as unknown as LinhaTabela]));
  // O "pai" de cada linha tem de existir no ficheiro ou (no modo atualizar) na tabela.
  const existe = (id: string) => validas.has(id) || (modo === "atualizar" && atuais.has(id));
  for (const [id, l] of [...validas]) {
    const n = Number(l.nivel_detalhe);
    const pai = n >= 3 ? l[PAI_DO_NIVEL[n]!] : null;
    if (pai && !existe(pai)) {
      validas.delete(id);
      invalidas.push({ linha: 0, id, motivo: `O ${PAI_DO_NIVEL[n]} ${pai} não existe` });
    }
  }
  if (invalidas.length) return { status: 422, corpo: { erro: `${invalidas.length} linha(s) com problemas: nada foi gravado`, invalidas: invalidas.slice(0, 200), totalInvalidas: invalidas.length } };

  const campos = ["nome", "pais", "ilha", "concelho", "freguesia", "zona", "nivel_detalhe"] as const;
  const novas: LinhaTabela[] = [];
  const mudadas: { antes: LinhaTabela; depois: LinhaTabela }[] = [];
  let iguais = 0;
  for (const l of validas.values()) {
    const a = atuais.get(l.id);
    if (!a) novas.push(l);
    else if (campos.some((c) => (a[c]?.trim() || null) !== (l[c]?.trim() || null))) mudadas.push({ antes: a, depois: l });
    else iguais++;
  }
  const apagar = modo === "substituir" ? [...atuais.keys()].filter((id) => !validas.has(id)) : [];
  const resumo = {
    modo,
    simulacao: simular,
    total: validas.size,
    novas: novas.length,
    atualizadas: mudadas.length,
    iguais,
    apagadas: apagar.length,
    exemplos: {
      novas: novas.slice(0, 10).map((l) => ({ id: l.id, nome: l.nome, nivel: Number(l.nivel_detalhe) })),
      atualizadas: mudadas.slice(0, 10).map((m) => ({ id: m.depois.id, antes: m.antes.nome, depois: m.depois.nome })),
      apagadas: apagar.slice(0, 10).map((id) => ({ id, nome: atuais.get(id)!.nome })),
    },
  };
  if (simular) return { status: 200, corpo: resumo };

  try {
    await transacao(pool, async (c) => {
      if (apagar.length) await c.query("DELETE FROM geografia WHERE id = ANY($1::text[])", [apagar]);
      const todas = [...novas, ...mudadas.map((m) => m.depois)];
      for (let i = 0; i < todas.length; i += 500) {
        const lote = todas.slice(i, i + 500);
        const col = (k: keyof LinhaTabela) => lote.map((l) => l[k]);
        await c.query(
          `INSERT INTO geografia (id, nome, pais, ilha, concelho, freguesia, zona, nome_norm, nivel_detalhe)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
           ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, pais = excluded.pais, ilha = excluded.ilha, concelho = excluded.concelho,
             freguesia = excluded.freguesia, zona = excluded.zona, nome_norm = excluded.nome_norm, nivel_detalhe = excluded.nivel_detalhe`,
          [col("id"), col("nome"), col("pais"), col("ilha"), col("concelho"), col("freguesia"), col("zona"), col("nome_norm"), col("nivel_detalhe")],
        );
      }
    });
  } catch (e) {
    return erro(500, `A importação falhou e nada foi gravado: ${(e as Error).message}`);
  }
  const g = await fonte.recarregar();
  return { status: 200, corpo: { ...resumo, totalAgora: g.total } };
}
