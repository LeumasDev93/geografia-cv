# geografia-cv

Regionalização de Cabo Verde (**ilha → concelho → freguesia → zona → lugar**) como pacote independente:
dados incluídos, pesquisa sem acentos e um middleware HTTP. **Sem dependências**, por isso pode ser usado
noutros projetos (APIs Node/Express/Fastify, Next.js, scripts, browser).

> Dados atuais: ilha de Santiago — 9 concelhos, 11 freguesias, 215 zonas, 2127 lugares (dump `dados/geografia.sql`).

## Níveis

| nível | chave | exemplo |
|---|---|---|
| 2 | `ilha` | Santiago (`2387`) |
| 3 | `concelho` | Praia (`238704`) |
| 4 | `freguesia` | N. S. da Graça (`238704001`) |
| 5 | `zona` | Palmarejo Grande |
| 6 | `lugar` | Achada Santo António |

## Em código

```ts
import { geografia } from "geografia-cv";

const g = geografia();
g.listar("concelho");                       // todos os concelhos
g.listar("zona", "238704");                 // zonas do concelho da Praia
g.filhos("238704");                         // filhos diretos (freguesias)
g.caminho("238704001001005");               // Santiago › Praia › … › Achada Santo António
g.acima("238704001001005", "concelho");     // { id: "238704", nome: "Praia", … }
g.pesquisar("sao lourenco", { nivel: "concelho" });
g.encontrar("ACHADA SANTO ANTONIO", { dentro: "238704" }); // liga um nome ao código oficial
```

## Como serviço HTTP

Rotas (todas `GET`, JSON, `Cache-Control` de 1 dia, CORS aberto):

```
/niveis
/ilhas  /concelhos  /freguesias  /zonas  /lugares      ?dentro=<código>
/pesquisa?q=<texto>&nivel=zona,lugar&dentro=<código>&limite=20
/<código>            → o local com o caminho e o nº de filhos
/<código>/filhos     → filhos diretos
```

**Express / Connect / Node puro**

```ts
import express from "express";
import { middlewareGeografia } from "geografia-cv";
app.use(middlewareGeografia({ prefixo: "/geografia" }));
```

**Fastify** (é assim que a API do Cidade Limpa o usa, em `/api/v1/geografia`)

```ts
import { pluginFastifyGeografia } from "geografia-cv";
await app.register(pluginFastifyGeografia, { prefix: "/geografia" });
```

**Serviço autónomo**

```bash
npm install
npm run build
npm start            # PORT=4100 por omissão → http://localhost:4100/geografia/concelhos
```

## Base de dados (opcional)

Com `DATABASE_URL` (ex.: Neon), os dados vêm da tabela `geografia` — o mesmo formato do dump oficial —
e o serviço volta a lê-la a cada `RECARREGAR_MINUTOS` (por omissão 60), para as alterações aparecerem sem reiniciar.

```bash
cp .env.example .env        # e ponha o DATABASE_URL
npm run migrate             # cria a tabela e carrega dados/geografia.sql (se estiver vazia)
npm start                   # "… (dados da base de dados)"
```

- `npm run migrate` pode correr várias vezes: não duplica nem apaga.
- `npm run migrate:substituir` apaga os dados da tabela e volta a carregar o dump (para atualizar a regionalização).
- Sem `DATABASE_URL`, usa os dados incluídos no pacote.

## Gestão (Portal 360)

Com base de dados e `CHAVE_ADMIN` definida, o Portal 360 gere a regionalização por estas rotas
(cabeçalho `Authorization: Bearer <CHAVE_ADMIN>`; chamar sempre a partir do servidor, nunca do browser):

```
GET    /geografia/admin/estado
POST   /geografia/admin/locais           { "nome": "Bairro Novo", "pai": "238704001001" }   (código gerado sozinho)
PATCH  /geografia/admin/locais/<código>  { "nome": "Novo nome" }
DELETE /geografia/admin/locais/<código>  (só sem locais por baixo)
POST   /geografia/admin/recarregar
```

As alterações aparecem logo nas leituras públicas (o serviço volta a ler a base depois de cada alteração).

## Publicar

- **Vercel:** importar este repositório (o `vercel.json` já encaminha tudo para `api/index.js`).
  Fica em `https://<projeto>.vercel.app/geografia/...`.
- **Docker:** `docker build -t geografia-cv . && docker run -p 4100:4100 geografia-cv`.
- Variáveis: `DATABASE_URL` (opcional), `PORT` (servidor autónomo), `PREFIXO` (por omissão `/geografia`) `RECARREGAR_MINUTOS` e `CHAVE_ADMIN` (gestão).

## Usar noutro projeto

```bash
npm install github:LeumasDev93/geografia-cv
```

Ou consumir só por HTTP, apontando para o serviço publicado (é o que faz o Cidade Limpa, com `GEOGRAFIA_URL`).

## Postman

Coleção com todas as rotas em `docs/geografia-cv.postman_collection.json` (Postman → Import). Mude a variável `base_url` para o endereço publicado.

## Atualizar os dados

Substitua `dados/geografia.sql` pelo dump novo (UTF-8 ou Latin-1, com `INSERT INTO geografia (...) VALUES (...)`) e corra:

```bash
npm run importar && npm run build
```

O script gera `src/dados.ts` (nomes em maiúsculas passam a "Achada Santo António").
Para outra fonte de dados, também pode criar `new Geografia(linhas)` com as suas linhas `[código, nome, nível, pai]`.
