/**
 * Fonte de dados em PostgreSQL (tabela `geografia`, o mesmo formato do dump oficial).
 * Usado pelo servidor e pela função da Vercel quando há DATABASE_URL; sem ela, ficam os dados incluídos no pacote.
 * O driver `pg` só é carregado aqui (é opcional para quem usa só a biblioteca).
 */
import { Geografia, formatarNome } from "./nucleo.js";
import type { Linha } from "./dados.js";

type Consulta = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, string | null>[]; rowCount?: number | null }>;
export type Pool = { query: Consulta; end: () => Promise<void>; connect: () => Promise<{ query: Consulta; release: () => void }> };

/** Corre `f` numa transação, sempre na mesma ligação (BEGIN/COMMIT; ROLLBACK se falhar). */
export async function transacao<T>(pool: Pool, f: (c: { query: Consulta }) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await f(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function ligar(url: string): Promise<Pool> {
  const pg = (await import("pg")).default as unknown as { Pool: new (o: object) => Pool };
  return new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000 });
}

/** Lê a tabela `geografia` e devolve as linhas [código, nome, nível, pai]. */
export async function lerLinhas(pool: Pool): Promise<Linha[]> {
  const { rows } = await pool.query("SELECT id, nome, pais, ilha, concelho, freguesia, zona, nivel_detalhe FROM geografia");
  return rows.map((r) => {
    const nivel = Number(r.nivel_detalhe);
    const pai = nivel >= 6 ? r.zona : nivel === 5 ? r.freguesia : nivel === 4 ? r.concelho : nivel === 3 ? r.ilha : nivel === 2 ? r.pais : null;
    return [String(r.id), formatarNome(String(r.nome)), nivel, pai ?? null] as const;
  });
}

/** Tabela com a "versão" dos dados: cada alteração aumenta-a; todas as instâncias do serviço a seguem. */
const META = `CREATE TABLE IF NOT EXISTS geografia_meta (id int PRIMARY KEY DEFAULT 1, versao bigint NOT NULL DEFAULT 0, alterado_em timestamptz NOT NULL DEFAULT now());
INSERT INTO geografia_meta (id, versao) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;`;
export async function garantirMeta(c: { query: Consulta }) {
  await c.query(META);
}
/** Marca que os dados mudaram (chamar na mesma transação da alteração, quando houver). */
export async function marcarAlteracao(c: { query: Consulta }) {
  await c.query("UPDATE geografia_meta SET versao = versao + 1, alterado_em = now() WHERE id = 1");
}
async function lerVersao(c: { query: Consulta }): Promise<string> {
  const { rows } = await c.query("SELECT versao::text AS v FROM geografia_meta WHERE id = 1");
  return String(rows[0]?.v ?? "0");
}

export interface FonteBase {
  /** A geografia atual (vê a versão na base a cada `verificarSegundos` e recarrega se mudou). */
  (): Promise<Geografia>;
  /** Volta a ler a base já. */
  recarregar: () => Promise<Geografia>;
  /** Marca a alteração (para as outras instâncias) e recarrega esta. */
  alterado: () => Promise<Geografia>;
  /** Quando foi lida pela última vez. */
  carregadaEm: () => Date | null;
  /** Ligação à base (para a gestão). */
  pool: () => Promise<Pool>;
}

/**
 * Geografia carregada da base de dados. Na Vercel há várias instâncias do serviço, cada uma com os dados
 * em memória: todas consultam a versão (uma consulta pequena) no máximo a cada `verificarSegundos` e
 * recarregam quando outra instância (ou o Portal 360) alterou os dados. De `recarregarMin` em
 * `recarregarMin` minutos recarregam de qualquer forma. Se a base falhar, continuam com os últimos dados.
 */
export function geografiaDaBase(url: string, recarregarMin = 60, verificarSegundos = 10): FonteBase {
  let pool: Pool | null = null;
  let atual: Geografia | null = null;
  let quando = 0;
  let versao: string | null = null;
  let verificadoEm = 0;
  let aCarregar: Promise<Geografia> | null = null;
  let metaPronta = false;
  const obterPool = async () => {
    pool ??= await ligar(url);
    if (!metaPronta) {
      await garantirMeta(pool);
      metaPronta = true;
    }
    return pool;
  };
  const carregar = async () => {
    const p = await obterPool();
    const v = await lerVersao(p);
    const linhas = await lerLinhas(p);
    if (!linhas.length) throw new Error("A tabela geografia está vazia (corra npm run migrate)");
    atual = new Geografia(linhas);
    versao = v;
    quando = verificadoEm = Date.now();
    return atual;
  };
  const recarregarUmaVez = () => (aCarregar ??= carregar().finally(() => (aCarregar = null)));
  const fonte = (async () => {
    const agora = Date.now();
    try {
      if (!atual || agora - quando >= recarregarMin * 60_000) return await recarregarUmaVez();
      if (agora - verificadoEm >= verificarSegundos * 1000) {
        verificadoEm = agora;
        if ((await lerVersao(await obterPool())) !== versao) return await recarregarUmaVez();
      }
      return atual;
    } catch (e) {
      if (atual) return atual;
      throw e;
    }
  }) as FonteBase;
  fonte.recarregar = () => carregar();
  fonte.alterado = async () => {
    await marcarAlteracao(await obterPool());
    return carregar();
  };
  fonte.carregadaEm = () => (quando ? new Date(quando) : null);
  fonte.pool = obterPool;
  return fonte;
}
