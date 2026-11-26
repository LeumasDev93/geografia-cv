/**
 * Fonte de dados em PostgreSQL (tabela `geografia`, o mesmo formato do dump oficial).
 * Usado pelo servidor e pela função da Vercel quando há DATABASE_URL; sem ela, ficam os dados incluídos no pacote.
 * O driver `pg` só é carregado aqui (é opcional para quem usa só a biblioteca).
 */
import { Geografia, formatarNome } from "./nucleo.js";
import type { Linha } from "./dados.js";

export type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, string | null>[] }>; end: () => Promise<void> };

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

export interface FonteBase {
  /** A geografia atual (recarrega quando passa o tempo). */
  (): Promise<Geografia>;
  /** Volta a ler a base já (depois de uma alteração). */
  recarregar: () => Promise<Geografia>;
  /** Quando foi lida pela última vez. */
  carregadaEm: () => Date | null;
  /** Ligação à base (para a gestão). */
  pool: () => Promise<Pool>;
}

/**
 * Geografia carregada da base de dados, recarregada de tempos a tempos (para as alterações feitas
 * no Portal 360 aparecerem sem reiniciar). Se a base falhar depois de já ter dados, continua com os últimos.
 */
export function geografiaDaBase(url: string, recarregarMin = 60): FonteBase {
  let pool: Pool | null = null;
  let atual: Geografia | null = null;
  let quando = 0;
  let aCarregar: Promise<Geografia> | null = null;
  const obterPool = async () => (pool ??= await ligar(url));
  const carregar = async () => {
    const linhas = await lerLinhas(await obterPool());
    if (!linhas.length) throw new Error("A tabela geografia está vazia (corra npm run migrate)");
    atual = new Geografia(linhas);
    quando = Date.now();
    return atual;
  };
  const fonte = (async () => {
    if (atual && Date.now() - quando < recarregarMin * 60_000) return atual;
    aCarregar ??= carregar().finally(() => (aCarregar = null));
    try {
      return await aCarregar;
    } catch (e) {
      if (atual) return atual;
      throw e;
    }
  }) as FonteBase;
  fonte.recarregar = () => carregar();
  fonte.carregadaEm = () => (quando ? new Date(quando) : null);
  fonte.pool = obterPool;
  return fonte;
}
