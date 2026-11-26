/**
 * Regionalização de Cabo Verde (ilha → concelho → freguesia → zona → lugar).
 * Núcleo sem dependências: funciona em Node, no browser, em Workers, etc.
 */
import { DADOS, type Linha } from "./dados.js";

export const NIVEIS = { pais: 1, ilha: 2, concelho: 3, freguesia: 4, zona: 5, lugar: 6 } as const;
export type NomeNivel = keyof typeof NIVEIS;
const NOME_NIVEL: Record<number, NomeNivel> = { 1: "pais", 2: "ilha", 3: "concelho", 4: "freguesia", 5: "zona", 6: "lugar" };
export const ROTULO_NIVEL: Record<NomeNivel, string> = { pais: "País", ilha: "Ilha", concelho: "Concelho", freguesia: "Freguesia", zona: "Zona", lugar: "Lugar" };

export interface Local {
  /** Código oficial (ex.: "238704" = concelho da Praia). */
  id: string;
  nome: string;
  nivel: NomeNivel;
  /** Código do nível de cima (null no topo). */
  pai: string | null;
}
export interface LocalDetalhado extends Local {
  /** Do topo até ao próprio (ex.: Santiago › Praia › Nossa Senhora da Graça › …). */
  caminho: Local[];
  /** Quantos filhos diretos tem. */
  filhos: number;
}

/** Texto para comparar: sem acentos, minúsculas, sem "de/da/do", espaços simples. */
export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`´]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((p) => p && !["de", "da", "do", "das", "dos", "d", "e"].includes(p))
    .join(" ");
}

const PEQUENAS = new Set(["de", "da", "do", "das", "dos", "e", "d’"]);
/** "ACHADA SANTO ANTÓNIO" → "Achada Santo António"; "PONTA D’ACHADA" → "Ponta d’Achada". */
export function formatarNome(s: string): string {
  return s
    .replace(/[\u0091\u0092\u2018\u2019\u00B4`']/g, "’")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("pt")
    .split(" ")
    .map((p, i) => {
      if (i > 0 && PEQUENAS.has(p)) return p;
      if (/^d’./.test(p)) return `d’${p.charAt(2).toLocaleUpperCase("pt")}${p.slice(3)}`;
      return p.charAt(0).toLocaleUpperCase("pt") + p.slice(1);
    })
    .join(" ");
}

export class Geografia {
  private readonly porId = new Map<string, Local>();
  private readonly filhosDe = new Map<string, Local[]>();
  private readonly norm = new Map<string, string>();

  constructor(linhas: readonly Linha[] = DADOS) {
    for (const [id, nome, nivel, pai] of linhas) {
      const l: Local = { id, nome, nivel: NOME_NIVEL[nivel] ?? "lugar", pai };
      this.porId.set(id, l);
      this.norm.set(id, normalizar(nome));
    }
    for (const l of this.porId.values()) {
      const chave = l.pai ?? "";
      if (!this.filhosDe.has(chave)) this.filhosDe.set(chave, []);
      this.filhosDe.get(chave)!.push(l);
    }
    for (const f of this.filhosDe.values()) f.sort((a, b) => a.nome.localeCompare(b.nome, "pt"));
  }

  /** Total de registos. */
  get total(): number {
    return this.porId.size;
  }

  obter(id: string): Local | null {
    return this.porId.get(id) ?? null;
  }

  /** O local com o caminho completo e o número de filhos. */
  detalhe(id: string): LocalDetalhado | null {
    const l = this.porId.get(id);
    return l ? { ...l, caminho: this.caminho(id), filhos: this.filhosDe.get(id)?.length ?? 0 } : null;
  }

  /** Do topo até ao local (inclui o próprio). */
  caminho(id: string): Local[] {
    const out: Local[] = [];
    let atual = this.porId.get(id);
    while (atual && out.length < 10) {
      out.unshift(atual);
      atual = atual.pai ? this.porId.get(atual.pai) : undefined;
    }
    return out;
  }

  /** Filhos diretos (ex.: concelhos de uma ilha). */
  filhos(id: string): Local[] {
    return this.filhosDe.get(id) ?? [];
  }

  /** Todos os descendentes de um local, opcionalmente só de um nível (ex.: todas as zonas de um concelho). */
  descendentes(id: string, nivel?: NomeNivel): Local[] {
    const out: Local[] = [];
    const pilha = [...this.filhos(id)];
    while (pilha.length) {
      const l = pilha.shift()!;
      if (!nivel || l.nivel === nivel) out.push(l);
      if (!nivel || NIVEIS[l.nivel] < NIVEIS[nivel]) pilha.push(...this.filhos(l.id));
    }
    return out.sort((a, b) => a.nome.localeCompare(b.nome, "pt"));
  }

  /** Lista por nível; `dentro` limita a um local de cima (ex.: freguesias do concelho 238704). */
  listar(nivel: NomeNivel, dentro?: string | null): Local[] {
    if (dentro) return this.descendentes(dentro, nivel);
    return [...this.porId.values()].filter((l) => l.nivel === nivel).sort((a, b) => a.nome.localeCompare(b.nome, "pt"));
  }

  /** O antepassado de um dado nível (ex.: o concelho de um lugar). */
  acima(id: string, nivel: NomeNivel): Local | null {
    return this.caminho(id).find((l) => l.nivel === nivel) ?? null;
  }

  /**
   * Pesquisa por nome, sem acentos (ex.: "achada sto antonio" não; "achada santo antonio" sim; "palmarejo" sim).
   * Primeiro os que começam pelo texto, depois os que o contêm.
   */
  pesquisar(texto: string, opcoes: { nivel?: NomeNivel | NomeNivel[]; dentro?: string | null; limite?: number } = {}): Local[] {
    const q = normalizar(texto);
    if (!q) return [];
    const niveis = opcoes.nivel ? new Set(Array.isArray(opcoes.nivel) ? opcoes.nivel : [opcoes.nivel]) : null;
    const base = opcoes.dentro ? this.descendentes(opcoes.dentro) : [...this.porId.values()];
    const comeca: Local[] = [];
    const contem: Local[] = [];
    for (const l of base) {
      if (niveis && !niveis.has(l.nivel)) continue;
      const n = this.norm.get(l.id)!;
      if (n === q || n.startsWith(q)) comeca.push(l);
      else if (n.includes(q) || q.split(" ").every((p) => n.includes(p))) contem.push(l);
    }
    const ordem = (a: Local, b: Local) => NIVEIS[a.nivel] - NIVEIS[b.nivel] || a.nome.localeCompare(b.nome, "pt");
    return [...comeca.sort(ordem), ...contem.sort(ordem)].slice(0, opcoes.limite ?? 50);
  }

  /** O melhor local para um nome (ex.: ligar "Achada Santo António" ao código oficial). */
  encontrar(nome: string, opcoes: { nivel?: NomeNivel | NomeNivel[]; dentro?: string | null } = {}): Local | null {
    const q = normalizar(nome);
    const r = this.pesquisar(nome, { ...opcoes, limite: 20 });
    return r.find((l) => this.norm.get(l.id) === q) ?? null;
  }
}

/** Instância partilhada com os dados incluídos no pacote. */
let padrao: Geografia | null = null;
export function geografia(): Geografia {
  return (padrao ??= new Geografia());
}
