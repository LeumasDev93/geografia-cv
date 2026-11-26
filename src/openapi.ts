/** Especificação OpenAPI 3 (Swagger) da middleware e a página Swagger UI. */
const nivel = { type: "string", enum: ["pais", "ilha", "concelho", "freguesia", "zona", "lugar"] };
const Local = {
  type: "object",
  required: ["id", "nome", "nivel", "pai"],
  properties: {
    id: { type: "string", example: "238704", description: "Código oficial" },
    nome: { type: "string", example: "Praia" },
    nivel: { ...nivel, example: "concelho" },
    pai: { type: "string", nullable: true, example: "2387", description: "Código do nível de cima (ilha: 238 = Cabo Verde)" },
  },
};
const lista = { description: "Lista de locais", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Local" } } } } };
const erro = (d: string) => ({ description: d, content: { "application/json": { schema: { $ref: "#/components/schemas/Erro" } } } });
const dentro = { name: "dentro", in: "query", required: false, schema: { type: "string", pattern: "^[0-9]{1,20}$" }, description: "Código de um local de cima (ex.: 238704 = Praia)", example: "238704" };
const codigo = { name: "codigo", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]{1,20}$" }, example: "238704" };
const porNivel = (plural: string, n: string, exemplo?: string) => ({
  get: {
    tags: ["Listas"],
    summary: `${plural[0]!.toUpperCase()}${plural.slice(1)}`,
    description: `Todos os locais de nível **${n}**, opcionalmente só dentro de um local de cima.`,
    parameters: [{ ...dentro, ...(exemplo ? { example: exemplo } : {}) }],
    responses: { 200: lista, 400: erro("Código inválido em `dentro`") },
  },
});
const admin = { security: [{ chaveAdmin: [] }], tags: ["Gestão (Portal 360)"] };

export function especificacao(prefixo: string) {
  return {
    openapi: "3.0.3",
    info: {
      title: "geografia-cv — Regionalização de Cabo Verde",
      version: "1.0.0",
      description:
        "Middleware com a regionalização oficial (ilha → concelho → freguesia → zona → lugar).\n\n" +
        "- As leituras são **públicas** (GET, JSON, CORS aberto, cache de 5 min).\n" +
        "- A **gestão** (`/admin/...`) é feita pelo Portal 360 com `Authorization: Bearer <CHAVE_ADMIN>` e precisa de base de dados.\n" +
        "- Pesquisa sem acentos e sem maiúsculas.",
    },
    servers: [{ url: prefixo || "/", description: "Este servidor" }],
    tags: [
      { name: "Listas", description: "Locais por nível" },
      { name: "Locais", description: "Um local pelo código" },
      { name: "Pesquisa" },
      { name: "Serviço", description: "Saúde e níveis" },
      { name: "Gestão (Portal 360)", description: "Criar, renomear e remover (com chave)" },
    ],
    paths: {
      "/saude": {
        get: {
          tags: ["Serviço"],
          summary: "Saúde (monitorização)",
          responses: {
            200: { description: "A funcionar", content: { "application/json": { schema: { type: "object", properties: { estado: { type: "string", example: "ok" }, total: { type: "integer", example: 2363 } } } } } },
            503: erro("Sem dados"),
          },
        },
      },
      "/niveis": {
        get: {
          tags: ["Serviço"],
          summary: "Níveis da regionalização",
          responses: {
            200: {
              description: "Os 6 níveis",
              content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { chave: nivel, nivel: { type: "integer" }, rotulo: { type: "string" } } } } } },
            },
          },
        },
      },
      "/ilhas": porNivel("ilhas", "ilha", "238"),
      "/concelhos": porNivel("concelhos", "concelho", "2387"),
      "/freguesias": porNivel("freguesias", "freguesia"),
      "/zonas": porNivel("zonas", "zona"),
      "/lugares": porNivel("lugares", "lugar", "238704001001"),
      "/pesquisa": {
        get: {
          tags: ["Pesquisa"],
          summary: "Pesquisar por nome",
          description: "Primeiro os que começam pelo texto, depois os que o contêm.",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string", minLength: 2, maxLength: 80 }, example: "palmarejo" },
            { name: "nivel", in: "query", required: false, schema: { type: "string" }, description: "Um ou vários níveis separados por vírgula", example: "zona,lugar" },
            dentro,
            { name: "limite", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          ],
          responses: { 200: lista, 400: erro("Texto curto ou parâmetros inválidos") },
        },
      },
      "/{codigo}": {
        get: {
          tags: ["Locais"],
          summary: "Um local, com o caminho completo",
          parameters: [codigo],
          responses: {
            200: { description: "O local", content: { "application/json": { schema: { $ref: "#/components/schemas/LocalDetalhado" } } } },
            404: erro("Não encontrado"),
          },
        },
      },
      "/{codigo}/filhos": {
        get: { tags: ["Locais"], summary: "Filhos diretos", parameters: [codigo], responses: { 200: lista, 404: erro("Não encontrado") } },
      },
      "/admin/estado": {
        get: {
          ...admin,
          summary: "Estado da base de dados",
          responses: {
            200: {
              description: "Totais",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { fonte: { type: "string", example: "base_de_dados" }, total: { type: "integer" }, porNivel: { type: "object", additionalProperties: { type: "integer" } }, carregadaEm: { type: "string", format: "date-time" } } },
                },
              },
            },
            401: erro("Chave inválida"),
            503: erro("Gestão desligada (sem CHAVE_ADMIN)"),
          },
        },
      },
      "/admin/locais": {
        post: {
          ...admin,
          summary: "Criar um local",
          description: "Cria um filho de `pai`. Para uma ilha nova, `pai` = `238` (Cabo Verde). Sem `id`, o código é gerado.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["nome", "pai"], properties: { nome: { type: "string", minLength: 2, maxLength: 120, example: "Bairro Novo" }, pai: { type: "string", example: "238704001001" }, id: { type: "string", example: "" } } },
              },
            },
          },
          responses: { 201: { description: "Criado", content: { "application/json": { schema: { $ref: "#/components/schemas/LocalDetalhado" } } } }, 400: erro("Dados inválidos"), 401: erro("Chave inválida"), 409: erro("Já existe") },
        },
      },
      "/admin/locais/{codigo}": {
        patch: {
          ...admin,
          summary: "Renomear",
          parameters: [codigo],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["nome"], properties: { nome: { type: "string", example: "Achada Santo António" } } } } } },
          responses: { 200: { description: "Renomeado", content: { "application/json": { schema: { $ref: "#/components/schemas/LocalDetalhado" } } } }, 401: erro("Chave inválida"), 404: erro("Não encontrado"), 409: erro("Nome repetido") },
        },
        delete: {
          ...admin,
          summary: "Remover (só sem locais por baixo)",
          parameters: [codigo],
          responses: { 200: { description: "Removido" }, 401: erro("Chave inválida"), 404: erro("Não encontrado"), 409: erro("Tem locais por baixo") },
        },
      },
      "/admin/recarregar": {
        post: { ...admin, summary: "Voltar a ler a base de dados", responses: { 200: { description: "Recarregado" }, 401: erro("Chave inválida") } },
      },
    },
    components: {
      securitySchemes: { chaveAdmin: { type: "http", scheme: "bearer", description: "A CHAVE_ADMIN do serviço" } },
      schemas: {
        Local,
        LocalDetalhado: {
          allOf: [
            { $ref: "#/components/schemas/Local" },
            { type: "object", properties: { caminho: { type: "array", items: { $ref: "#/components/schemas/Local" } }, filhos: { type: "integer", example: 1 } } },
          ],
        },
        Erro: { type: "object", properties: { erro: { type: "string" } } },
      },
    },
  };
}

/** Página Swagger UI (scripts do jsDelivr). */
export function paginaSwagger(urlEspecificacao: string) {
  return `<!doctype html>
<html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>geografia-cv · API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css">
<style>body{margin:0}.topbar{display:none}</style></head>
<body><div id="swagger"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ url: ${JSON.stringify(urlEspecificacao)}, dom_id: "#swagger", deepLinking: true, docExpansion: "list", persistAuthorization: true });</script>
</body></html>`;
}
