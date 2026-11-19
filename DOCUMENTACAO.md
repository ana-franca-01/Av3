# greencode — Relatório técnico da Atividade 3

Evolução do servidor monolítico da AV2 (Fastify + Prisma + PostgreSQL, JWT, bcrypt) para uma **plataforma analítica e
integrada**. A AV3 traz três pilares novos:

1. **Camada analítica**: eficiência operacional, rentabilidade por tipo de equipamento e previsão de vida útil
   remanescente, com histórico persistido, execução agendada e comparação previsão × realização.
2. **API pública documentada**: chaves de API por parceiro, escopos por contrato, rate limit em três camadas,
   prefixos e versão separando o que é público, interno e administrativo.
3. **Processamento assíncrono**: relatórios pesados gerados por fila (BullMQ + Redis), com retry, polling e download.

Tudo que existia na AV2 continua valendo: regras de negócio, transações, versionamento otimista, triggers e auditoria.

---

## 0. Requisitos da atividade × onde estão atendidos

| Requisito do enunciado | Onde está | Como foi verificado |
|---|---|---|
| Node.js + TypeScript + Prisma | `package.json`, `tsconfig.json`, `prisma/schema.prisma` | build `tsc` sem erros |
| Análise de eficiência operacional (tempo médio de processamento, gargalos, operadores, períodos) | `src/analitica/analises.ts` → `AnaliseEficiencia` | testes unitários + e2e |
| Rentabilidade por tipo (estado físico, marca, modelo) | `AnaliseRentabilidade` | testes unitários + e2e |
| Vida útil remanescente com regressão / suavização exponencial, a partir do histórico de depreciação e de falhas | `AnaliseVidaUtil` (MQO, Holt, idade média até a falha, depreciação contábil) — seção 3.2 | testes unitários (incl. conferência com a simple-statistics) + e2e |
| Resultados em novas tabelas, comparando previsões com realizações | `relatorios_analiticos`, `previsoes_vida_util`, `previsoes_equipamento` — seção 3.4 | e2e confere a gravação; validação por tipo e por equipamento |
| Serviços independentes, por endpoint e por tarefa agendada | rotas `/analitica/*` + `src/analitica/agendador.ts` (node-cron) | e2e + teste manual com duas réplicas |
| API pública com chave por parceiro e permissões | `src/servicos/chave-api.servico.ts`, `src/plugins/api-publica.ts` | e2e (401/403/404 por organização) |
| Rate limit (`@fastify/rate-limit`) | `src/plugins/limites.ts`: por IP, no login e por chave — seção 4.3 | e2e das três camadas |
| Documentação interativa (`@fastify/swagger`) com exemplos e códigos de erro | `/docs`, `src/rotas/respostas.ts` | e2e lê `/docs/json` |
| Separação público × interno/admin e versão explícita | `/api/v1/public`, `/api/v1/internal`, `/api/v1/admin`, cabeçalho `x-api-version` | e2e |
| Processamento assíncrono com fila (BullMQ + Redis), id da tarefa, status e download | `src/fila/fila.ts`, `src/servicos/tarefa.servico.ts` | e2e nos dois modos de fila + teste manual com worker separado |
| Política de retry | seção 5.2 | testes unitários da fila |
| Relatório técnico (bibliotecas, tabelas, retry, evolução para centenas/milhares de parceiros) | este documento (seções 3.3, 3.4, 5.2, 6) | — |
| Windows 10+, Ubuntu 24.04.03+ e derivados | seção 7: script `scripts/testar-ubuntu.sh` + GitHub Actions (`.github/workflows/compatibilidade.yml`) | Ubuntu 24.04.5 executado; Windows na esteira de CI |

---

## 1. Execução

Pré-requisitos: Node.js ≥ 22 e Docker (Docker Desktop no Windows 10+; Docker Engine no Ubuntu 24.04+ e derivados).

```bash
cp .env.example .env        # no Windows (cmd): copy .env.example .env
npm install
npm run db:up               # PostgreSQL 16 (porta 5434) + Redis 7 (porta 6380)
npm run db:migrate
npm run db:seed             # massa de dados + análises + imprime uma chave de API de demonstração
npm run build
npm start                   # http://localhost:3000 — documentação em /docs
```

| Script | O que faz |
|---|---|
| `npm run dev` / `npm run dev:worker` | servidor / worker com recarga automática |
| `npm run worker` | worker avulso (consome a fila; use com `WORKER_EMBUTIDO=false` no servidor) |
| `npm test` | 34 testes unitários: domínio da AV2 + estatística, análises, CSV, política de retry (sem banco) |
| `npm run test:e2e` | 47 cenários contra PostgreSQL real, fila em memória |
| `TESTE_COM_REDIS=1 npm run test:e2e` | os mesmos 47 cenários usando BullMQ + Redis |
| `bash scripts/testar-ubuntu.sh` | instala e testa tudo dentro de um Ubuntu 24.04 limpo (seção 7) |

**Variáveis novas** (`.env.example`):

| Variável | Padrão | Função |
|---|---|---|
| `REDIS_URL` | — | fila BullMQ e contadores do rate limit. **Vazia = fila em memória** (só dev/teste) |
| `WORKER_EMBUTIDO` | `true` | `false` quando o worker roda em processo separado |
| `WORKER_CONCORRENCIA` | `2` | jobs simultâneos por worker |
| `ANALITICA_CRON` / `ANALITICA_FUSO` | `0 2 * * *` / `America/Sao_Paulo` | agendamento das análises (vazio desliga) |
| `RELATORIO_VALIDADE_HORAS` | `72` | por quanto tempo o arquivo de um relatório fica disponível |
| `RELATORIO_TENTATIVAS` | `3` | tentativas por job antes de marcar FALHOU |
| `RATE_LIMIT_IP_POR_MINUTO` | `600` | limite por IP em todas as rotas |
| `RATE_LIMIT_LOGIN_POR_MINUTO` | `10` | limite por IP no login |
| `TRUST_PROXY` | `false` | `true` atrás de proxy/balanceador (IP real via `X-Forwarded-For`) |

## 2. Arquitetura

```
src/
├── server.ts / worker.ts    entradas: HTTP (com ou sem worker embutido) e worker avulso
├── app.ts                   Fastify: Swagger, limites, auth, três prefixos de rota, agendador, desligamento
├── composicao.ts            monta Prisma → repositórios → serviços (usado pelo servidor e pelo worker)
├── analitica/
│   ├── estatistica.ts       funções puras: descritivas, MQO, Holt
│   ├── analises.ts          Strategy: AnaliseEficiencia, AnaliseRentabilidade, AnaliseVidaUtil
│   ├── analitica.servico.ts carga dos dados, execução, persistência do histórico
│   └── agendador.ts         node-cron + trava distribuída no banco
├── fila/fila.ts             FilaBullMQ e FilaMemoria (mesmo contrato), política de retry
├── plugins/
│   ├── limites.ts           rate limit em camadas (IP, login, chave)
│   └── api-publica.ts       chave de API, escopo, cota por chave, cabeçalhos de versão
├── servicos/                AV2 + chave-api, parceiro (fachada pública), tarefa (relatórios assíncronos)
├── rotas/                   rotas por prefixo, JSON Schemas de entrada e de resposta (com exemplos)
└── … (dominio, repositorios, controllers, config da AV2)
```

**Padrões aplicados:**

- **Strategy** (`Analise<R>`): cada categoria de insight tem o mesmo contrato `calcular(dados, contexto)`. Uma quarta
  categoria entra sem mexer no orquestrador.
- **Análises puras**: não tocam no banco. O mesmo código atende a rota síncrona, o cron e o worker, e é testado sem
  PostgreSQL.
- **Facade** (`ParceiroServico`): a API pública reusa os serviços internos (mesmas regras, mesmas transações), mas
  recorta tudo pela organização dona da chave.
- **Adapter** (`FilaRelatorios`): BullMQ em produção, memória em dev/teste, mesma interface.
- **Factory Method** (da AV2): `FabricaEquipamento` ganhou `estimarRecuperacao()` e `valorMateriaisPadrao()`
  polimórficos.

## 3. Camada analítica

### 3.1 As três análises

| Categoria | Pergunta | Como calcula |
|---|---|---|
| **EFICIENCIA** | Quanto tempo um lote leva da entrada até a triagem? Onde trava? | Dias entre `lote.data_entrada` e `equipamento.triagem_em`: média, mediana, desvio, p90, por **operador** e por **mês**. Permanência em cada status a partir das movimentações; **gargalo** = etapa de maior média. Equipamentos parados há ≥ 7 dias. Coeficiente de variação entre operadores |
| **RENTABILIDADE** | Quais equipamentos dão mais retorno? | Para cada equipamento: o maior entre **revender** (valor residual polimórfico × fator do estado: EXCELENTE 0,9 … SUCATA 0) e **vender os materiais** (piso por tipo). Agregado por tipo, tipo × estado e **marca × modelo**. Prioridade dos ativos de maior valor. **Acurácia**: erro contra o `valor_recuperado` informado na destinação |
| **VIDA_UTIL** | Quando cada equipamento vai ficar inservível? | Seção 3.2 |

`marca`, `modelo` e `valor_recuperado` são campos novos do equipamento. O valor recuperado é informado ao destinar
para REUTILIZADO/RECICLADO, e um CHECK impede que exista em outro status.

### 3.2 Vida útil remanescente

**Dados usados.** Estado físico em escala numérica (EXCELENTE 4, BOM 3, REGULAR 2, RUIM 1, SUCATA 0) × idade do
equipamento na data de cada movimentação. Isso usa três fontes históricas:

- **desgaste**: uma observação cada vez que o equipamento muda de estado físico;
- **falhas**: equipamentos observados em RUIM/SUCATA e a idade em que chegaram a SUCATA;
- **depreciação**: coeficiente anual dos parâmetros.

**Escolha do método, por tipo de equipamento** (o método usado vai em cada previsão, com a justificativa em
`observacao`):

| Ordem | Método | Quando | Vida útil = |
|---|---|---|---|
| 1 | **MQO** (mínimos quadrados ordinários) | ≥ 5 observações e R² ≥ 0,3 | idade em que a reta estado × idade cruza 0 |
| 2 | **Holt** (suavização exponencial dupla, α 0,5, β 0,3) | MQO fraco, mas a série do estado médio por faixa de idade tem tendência de queda | última idade + nível ÷ tendência |
| 3 | **FALHAS** | sem tendência utilizável, mas ≥ 3 equipamentos do tipo já chegaram a SUCATA | idade média em que chegaram a SUCATA (tempo médio até a falha observado) |
| 4 | **DEPRECIACAO** | sem histórico | 100 ÷ % de depreciação anual (vida contábil) |

**O que cada modelo devolve, além da vida útil:**

- `vidaUtilContabilAnos`: a vida pela depreciação, sempre presente, para comparar a vida **técnica** com a
  **financeira**. Exemplo: um computador deprecia em 5 anos, mas fisicamente dura ~11; a diferença é a janela de
  reuso.
- `falhas.curva`: **curva empírica de falhas**, ou seja, o percentual dos equipamentos de cada faixa de idade
  (0-2, 3-5, 6-8, 9-11, 12+ anos) que estavam em RUIM/SUCATA na última observação.
- `falhas.idadeMediaAteInservivelAnos`: idade média real em que o tipo virou sucata.

**Resultado com os dados do seed:**

| Tipo | Método | R² | Vida técnica | Vida contábil | Idade média real até SUCATA | Curva de falhas |
|---|---|---|---|---|---|---|
| COMPUTADOR | MQO | 0,745 | 11,2 anos | 5 anos | 10,1 anos (8 casos) | 0-5: 0% · 6-8: 80% · 9+: 100% |
| MONITOR | MQO | 0,887 | 11,2 anos | 5 anos | 11,4 anos (3 casos) | 3-5: 0% · 6-8: 67% · 9-11: 100% |
| TELECOM | MQO | 0,521 | 16,2 anos | 10 anos | 10,4 anos (1 caso) | 0-8: 0% · 9-11: 75% |
| SERVIDOR | DEPRECIACAO | — | 4 anos | 4 anos | — | sem dados |

As três fontes concordam: para computador e monitor, a regressão (11,2) bate com a idade média real de quebra
(10,1 e 11,4) e com o ponto em que a curva de falhas sobe.

**Por equipamento.** Anos restantes = estado atual ÷ taxa de desgaste do tipo (MQO/Holt). Com FALHAS/DEPRECIACAO, é
vida útil − idade. A data prevista é hoje + anos restantes. O cálculo parte do estado **do próprio equipamento**: um
EXCELENTE de 8 anos dura mais que um REGULAR de 3.

**Previsão × realização**, em dois níveis, a cada execução:

1. **Por tipo** (`validacao`): previsões antigas de vida útil × idade real dos equipamentos que viraram SUCATA depois
   delas.
2. **Por equipamento** (`validacaoPorEquipamento`): cada execução grava a data prevista de **cada equipamento ativo**
   em `previsoes_equipamento`. Quando um deles vira SUCATA, a próxima execução compara a data real com a última data
   prevista antes disso e devolve:
   - erro médio absoluto (anos);
   - **viés** (erro com sinal: negativo = o modelo foi otimista);
   - % de previsões que acertaram com margem de ±1 ano.

   Exemplo real no banco de desenvolvimento: o EQ-000035 (switch em estado RUIM) tinha previsão de sucata em
   2031-01-12 e quebrou em 2026-11-19, um erro de −4,15 anos. Esse viés acumulado é o sinal para ajustar o modelo,
   por exemplo dando mais peso ao estado RUIM ou trocando a escala linear.

### 3.3 Biblioteca estatística: simple-statistics

Escolhi a **simple-statistics** e não a mathjs:

- Cobre o que precisamos (média, mediana, desvio amostral, quantis, regressão linear, R²).
- É pequena, sem dependências e sem código nativo, então instala igual no Windows e no Ubuntu.
- A mathjs é um ambiente de álgebra completo (matrizes, unidades, parser), muito maior do que o problema.

**MQO e Holt foram implementados à mão** (`estatistica.ts`), para controlar os casos degenerados (x constante, y
constante, menos de 2 pontos, reta crescente) e devolver o R² junto. O teste unitário confere coeficientes e R² contra
a simple-statistics com tolerância de 1e-12.

### 3.4 Modelagem das tabelas de resultados

| Tabela | Conteúdo | Por quê |
|---|---|---|
| `relatorios_analiticos` | uma linha por execução: categoria, origem (AGENDADA / SOB_DEMANDA / PARCEIRO), organização (null = global), quando, quem, amostras, duração e o **resultado completo em JSONB** | O formato do resultado muda conforme os modelos evoluem; JSONB guarda versões diferentes lado a lado sem migração. Os campos de filtro são colunas com índice `(organizacao_id, categoria, gerado_em)` |
| `previsoes_vida_util` | coeficientes de cada tipo (método, intercepto, inclinação, R², amostras, vida útil) | Em colunas, para comparar previsão × realização por tipo em SQL, índice `(tipo, gerado_em)` |
| `previsoes_equipamento` | por equipamento ativo: estado, idade, método, anos restantes e **data prevista de inservibilidade** | Permite medir o erro no nível do equipamento quando ele virar SUCATA; índice `(equipamento_id, gerado_em)` |
| `execucoes_agendadas` | uma linha por janela do cron, com instância, fim e erro | Trava distribuída (3.5) e histórico das execuções |

As três tabelas de resultado são **histórico imutável**: um trigger bloqueia UPDATE (o mesmo `fn_bloquear_alteracao`
da auditoria). DELETE é permitido, para uma política de retenção. Há CHECKs de método válido, amostras ≥ 0, vida
útil > 0, anos restantes ≥ 0 e resultado sempre objeto JSON.

### 3.5 Execução agendada

- **node-cron** dispara as três análises globais em `ANALITICA_CRON` (padrão 02:00) e, de hora em hora, a manutenção
  (apaga arquivos de relatórios vencidos e reenfileira tarefas órfãs).
- **Várias réplicas não duplicam a execução.** Antes de rodar, a instância faz
  `INSERT INTO execucoes_agendadas (chave) … ON CONFLICT DO NOTHING`, e só quem inseriu executa. Testado com dois
  servidores e cron a cada minuto: em cada janela, um executou e o outro registrou "janela já reservada".
- A trava fica no PostgreSQL, e não em *advisory lock*, porque o pool do Prisma pode devolver outra conexão no
  unlock. Também não usei job repetível do BullMQ: assim o agendamento funciona sem Redis.
- As mesmas análises podem ser disparadas na hora por `POST /api/v1/admin/analitica/executar`.

## 4. API pública

### 4.1 Segregação por prefixo

| Prefixo | Quem usa | Autenticação | Autorização |
|---|---|---|---|
| `/api/v1/public` | parceiros externos | `X-API-Key` | escopos da chave + recorte pela organização + cota por chave |
| `/api/v1/internal` | front-end, equipes | JWT (`POST /api/v1/internal/auth/login`) | permissão do papel |
| `/api/v1/admin` | gestão | JWT | papel ADMIN (usuários, parâmetros, chaves, análises) |

A API pública é um **contexto encapsulado do Fastify**: hook de chave, escopo e cota valem só ali, e o JWT dos
usuários internos não abre nada lá dentro (testado).

### 4.2 Chaves de API

- Emitidas pelo admin (`POST /api/v1/admin/chaves`) no formato `gc_<prefixo>_<segredo>`. O segredo tem 32 bytes
  aleatórios e aparece **só na criação**; o banco guarda o **SHA-256**. O prefixo identifica a chave em logs,
  auditoria e rate limit sem expor o segredo.
- **SHA-256 e não bcrypt:** bcrypt é para senhas humanas, de baixa entropia. Um segredo aleatório de 256 bits não é
  quebrável por força bruta, então um hash rápido basta e não acrescenta ~100 ms a cada requisição. A comparação é em
  tempo constante (`timingSafeEqual`).
- **Escopos** espelham o contrato comercial: `RASTREIO_LER`, `LOTE_LER`, `LOTE_ESCREVER`, `ANALITICA_LER`,
  `RELATORIO_GERAR`. Cada chave também tem limite por minuto, validade opcional, revogação e registro do último uso.
- **Mesma mensagem 401** para chave ausente, malformada, inexistente, errada, revogada ou expirada.
- Recurso de outra organização responde **404, não 403**, para não confirmar que o código existe.
- Cache de 30 s das chaves válidas. Revogar limpa o cache da instância na hora; em outras réplicas, vale em até 30 s.

### 4.3 Rate limit em três camadas

Todas as camadas usam `@fastify/rate-limit` (via `createRateLimit`, que permite empilhar camadas) sobre o mesmo
armazenamento: memória, ou Redis com `REDIS_URL`, e então o limite vale para o conjunto de réplicas.

| Camada | Contador | Onde | Limite | Protege contra |
|---|---|---|---|---|
| **IP** | `ip:<endereço>` | toda requisição, antes de qualquer autenticação | `RATE_LIMIT_IP_POR_MINUTO` (600) | inundação, inclusive com chaves inválidas ou sem chave |
| **Login** | `login:<endereço>` | `POST /api/v1/internal/auth/login` | `RATE_LIMIT_LOGIN_POR_MINUTO` (10) | força bruta de senha espalhada entre várias contas (o bloqueio da AV2 é por conta) |
| **Chave** | `chave:<prefixo>` | API pública, depois de validar a chave | `limitePorMinuto` da chave | parceiro passando da cota do contrato; é por chave, não por IP, para que parceiros atrás do mesmo NAT não se prejudiquem |

**Detalhes de comportamento:**

- Respostas trazem `x-ratelimit-limit/remaining/reset`. Ao estourar: **429 `GC-TAXA`** com `retry-after` e
  `detalhes.camada`, que diz qual limite foi atingido.
- `/health` fica fora do limite por IP, para que sondas de monitoramento não consumam cota.
- Atrás de proxy, `TRUST_PROXY=true` usa o IP real do cliente.
- Se o Redis cair, o limite é suspenso em vez de derrubar a API. Na subida, os comandos esperam a conexão abrir, então
  não há janela sem limite.

### 4.4 Endpoints públicos

| Método e rota | Escopo | Descrição |
|---|---|---|
| `GET /me` | — | parceiro, organização, escopos e limite da chave |
| `GET /equipamentos` | `RASTREIO_LER` | equipamentos da organização (filtros: lote, status, tipo) |
| `GET /equipamentos/:codigo/rastreabilidade` | `RASTREIO_LER` | cadeia de custódia completa |
| `GET /lotes` · `GET /lotes/:codigo` | `LOTE_LER` | lotes da organização |
| `POST /lotes` | `LOTE_ESCREVER` | submete lote com equipamentos (organização vem da chave; atômico) |
| `GET /analitica/:categoria` | `ANALITICA_LER` | indicador calculado na hora para a organização |
| `POST /relatorios` | `RELATORIO_GERAR` | pede relatório assíncrono → **202** + `Location` |
| `GET /relatorios` · `GET /relatorios/:id` | `RELATORIO_GERAR` | tarefas da chave / status (com `Retry-After` enquanto processa) |
| `GET /relatorios/:id/download` | `RELATORIO_GERAR` | arquivo JSON ou CSV (`Content-Disposition: attachment`) |

### 4.5 Documentação interativa e versionamento

- `@fastify/swagger` + Swagger UI em **`/docs`** (JSON em `/docs/json`). Os JSON Schemas que validam as entradas
  geram a documentação, então ela não fica desatualizada.
- Cada rota pública declara o esquema `apiKey`, a descrição, **exemplos de requisição e resposta** e os **códigos de
  erro**, cada um com exemplo (401, 403, 404, 409, 410, 422, 429, 503, 500).
- **Versão na URL** (`/api/v1/…`) e no cabeçalho `x-api-version: 1.0.0` (semver). Mudança incompatível cria
  `/api/v2/public`, com a v1 em paralelo e os cabeçalhos `Deprecation`/`Sunset` até o desligamento.

## 5. Relatórios assíncronos

### 5.1 Fluxo

```
Parceiro                 API                           Redis (BullMQ)           Worker
   │ POST /relatorios ──▶ cria tarefa PENDENTE ─────▶ job (jobId = tarefa.id)
   │ ◀── 202 + Location                                     │
   │ GET /relatorios/:id ──▶ PENDENTE (Retry-After: 5)      ├──▶ PROCESSANDO
   │                                                        │    roda análises, grava histórico
   │ GET /relatorios/:id ──▶ CONCLUIDA + links.download     │    CONCLUIDA (conteúdo na tarefa)
   │ GET …/download ──▶ arquivo CSV/JSON
```

Tipos:

- **PREVISAO_ATIVOS**: vida remanescente e data prevista de cada equipamento ativo, em JSON ou CSV RFC 4180.
- **ANALITICO_COMPLETO**: as três análises, só JSON (um CHECK impede CSV).

Depois de `RELATORIO_VALIDADE_HORAS`, o download responde **410** e a manutenção apaga o conteúdo; a linha da tarefa
fica para auditoria.

### 5.2 Política de retry

| Situação | Comportamento |
|---|---|
| Falha transitória (banco ocupado, timeout, worker reiniciado) | volta para PENDENTE com o erro registrado; nova tentativa com **backoff exponencial** 5 s, 10 s, 20 s… e **30% de jitter**, para que falhas em massa não voltem todas juntas |
| Esgotou as tentativas (`RELATORIO_TENTATIVAS`, padrão 3) | **FALHOU** com a mensagem; o download responde 422 explicando |
| Erro de regra de negócio | **FALHOU direto** (`UnrecoverableError`): repetir não muda o resultado |
| Worker morre no meio | sem renovação do lock por 60 s, o BullMQ devolve o job à fila (`maxStalledCount: 1`) |
| Redis fora do ar no POST | tarefa FALHOU e resposta **503 `GC-INDISP`**, sem 202 que nunca seria cumprido |
| Job perdido (fila em memória reiniciada) | a manutenção horária reenfileira PENDENTE com mais de 15 min e PROCESSANDO com mais de 30 min |

**Idempotência:** o `jobId` é o id da tarefa, e o worker muda o status com *compare-and-set*
(`UPDATE … WHERE status IN (…)`). Um job repetido após o sucesso não faz nada.

**Por que BullMQ:** persistência, retry com backoff, detecção de job travado, concorrência e workers distribuídos já
vêm prontos. Uma fila em tabela do PostgreSQL (`SKIP LOCKED`) exigiria reimplementar isso, e RabbitMQ/SQS
acrescentariam infraestrutura sem ganho neste volume.

## 6. Evolução para centenas ou milhares de parceiros

| Pressão | Primeiro passo (já suportado) | Passo seguinte |
|---|---|---|
| Volume de requisições | servidor **stateless** (JWT, chave com cache, rate limit no Redis): N réplicas atrás de um balanceador (`TRUST_PROXY=true`) | API gateway (Kong/Envoy) com autenticação de chave e rate limit na borda |
| Geração de relatórios | `WORKER_EMBUTIDO=false` + `npm run worker` em quantas máquinas forem precisas | filas por prioridade/plano e limite de jobs simultâneos por parceiro |
| Tamanho dos arquivos | conteúdo na tarefa, com validade e expurgo | object storage (S3/MinIO) com URL assinada |
| Custo das análises | carga única por execução, cálculo em memória | agregações no SQL (`regr_slope`/`regr_r2` do PostgreSQL), visões materializadas, réplica de leitura para analítica |
| Histórico crescendo (`previsoes_equipamento` cresce com nº de ativos × execuções) | índices por equipamento/organização/data | particionamento mensal e retenção (manter, por equipamento, só as previsões necessárias à validação) |
| Saber quando o relatório terminou | polling com `Retry-After` | **webhook** assinado (HMAC) por chave, com a mesma política de retry |
| Gestão de chaves | escopos, limite e validade por chave | portal self-service, rotação com duas chaves simultâneas, cotas mensais por plano para cobrança |
| Revogação | até 30 s em outras réplicas | invalidação do cache via pub/sub no Redis |

A separação já existe no código (análises puras, serviços sem HTTP, fila atrás de interface, worker com entrada
própria). Escalar é questão de implantação e não exige reescrever.

## 7. Compatibilidade (Windows 10+, Ubuntu 24.04.03+ e derivados) — como foi comprovada

**Ubuntu 24.04, executado.** `scripts/testar-ubuntu.sh` sobe um container `ubuntu:24.04` limpo, instala o Node 22
oficial e roda `npm ci`, build, testes unitários e os e2e nos dois modos de fila, contra o PostgreSQL e o Redis do
`docker compose`. Resultado:

```
== Ubuntu 24.04.5 LTS | node v22.23.5 | npm 10.9.9 | aarch64
ℹ tests 34   ℹ pass 34   ℹ fail 0
== e2e (fila em memória)
ℹ tests 47   ℹ pass 47   ℹ fail 0
== e2e (BullMQ + Redis)
ℹ tests 47   ℹ pass 47   ℹ fail 0
```

**Windows e Ubuntu, a cada push.** `.github/workflows/compatibilidade.yml` (GitHub Actions) roda:

- **windows-latest (Node 22):** liga o PostgreSQL que já vem instalado no runner, roda `npm ci`, build, testes
  unitários e e2e com fila em memória, depois migração e seed, sobe o servidor e consulta `/health` e `/docs/json`.
- **ubuntu-24.04 (Node 22 e 24):** PostgreSQL 16 e Redis 7 como serviços, unitários, e2e nos dois modos de fila,
  migração, seed e servidor de pé.

**Por que funciona igual nas duas plataformas:**

- Dependências 100% JavaScript (`simple-statistics`, `node-cron`, `bullmq`, `ioredis`, `@fastify/rate-limit`,
  `bcryptjs`, `pino`); nada precisa de compilação nativa.
- Prisma com `binaryTargets = ["native", "windows", "debian-openssl-3.0.x"]`: o engine certo para Windows e para
  Ubuntu 24.04 (OpenSSL 3).
- Scripts npm sem comandos de shell específicos; o preparo do banco de teste chama o Prisma via `process.execPath`.
- `.env` lido com `process.loadEnvFile` (nativo do Node 22).
- Agendamento com fuso explícito, independente do sistema.
- Desligamento gracioso com `SIGINT`, `SIGTERM` e `SIGBREAK` (Ctrl+Break no Windows), no servidor e no worker.
- CSV com `\r\n` (RFC 4180), que abre no Excel do Windows e em ferramentas Linux.
- Redis/PostgreSQL via Docker nas duas plataformas, ou instalados direto (Redis é opcional: sem ele a fila roda em
  memória).

## 8. Cenários testados

**Unitários** (`npm test`, 34, sem banco), além dos da AV2:

- MQO exato e conferido contra a simple-statistics.
- Casos degenerados (poucos pontos, x constante, reta crescente).
- Holt.
- Escolha do método (MQO, Holt, FALHAS, depreciação).
- Curva de falhas e idade média até SUCATA.
- Remanescente a partir do estado atual.
- Validação previsão × realização por tipo e **por equipamento** (pega a previsão mais recente anterior à quebra;
  viés e acerto ±1 ano).
- Eficiência por operador, gargalo e parados.
- Rentabilidade: reuso × materiais, por marca, acurácia.
- Escape de CSV.
- Retry da fila (backoff até o sucesso, erro definitivo sem repetição, publicação duplicada).

**E2E** (`npm run test:e2e`, 47, PostgreSQL real; também com `TESTE_COM_REDIS=1` e dentro do Ubuntu 24.04):

| Cenário | Resposta |
|---|---|
| Papel CADASTRO consulta analítica | 403 |
| Eficiência / rentabilidade por organização / vida útil | 200; GET calcula sem gravar |
| Admin executa análises | 201; relatórios + previsões por tipo + **uma previsão por equipamento ativo** gravadas; modelos trazem vida contábil e curva de falhas; auditor 403 |
| UPDATE direto em `relatorios_analiticos` | recusado pelo trigger |
| Agendador | grava as 3 análises; a mesma janela não é reservada duas vezes |
| `valorRecuperado` em DESCARTADO | 400 |
| Emissão de chave | segredo só na criação; listagem sem hash nem segredo |
| Sem chave / malformada / segredo errado / JWT no lugar | 401 |
| Chave de outra organização | lista vazia; rastreabilidade 404 |
| Escopo ausente | 403 |
| Parceiro cria lote | 201, organização da chave, `criadoPor = api:<prefixo>`; enviar `organizacao` → 400 |
| Cota da chave (3/min) estourada | 429 `GC-TAXA`; outra chave segue atendida |
| **4ª tentativa de login do mesmo IP em 1 min (limite 3)** | 429 mesmo com a senha certa (`camada: login`); outro IP entra normalmente |
| **9ª requisição de um IP com chave inventada (limite 8)** | 429 (`camada: ip`): a inundação é barrada antes da autenticação |
| `/health` em sequência | nunca limitado |
| Relatório PREVISAO_ATIVOS em CSV | 202 + Location → CONCLUIDA → download `text/csv`; outra chave → 404 |
| ANALITICO_COMPLETO | CSV → 400; JSON → três análises |
| Download pendente / expirado | 409 / 410 |
| Chave revogada | 401 na requisição seguinte |
| `/docs/json` | rotas pública/interna e esquema `apiKey` documentados |

**Verificações manuais:**

- servidor com `WORKER_EMBUTIDO=false` + `npm run worker` em outro processo, gerando e baixando um CSV via Redis;
- duas réplicas com cron a cada minuto (cada janela executada por uma só);
- encerramento limpo com SIGTERM;
- previsão × realização por equipamento num caso real do banco de desenvolvimento (seção 3.2).
