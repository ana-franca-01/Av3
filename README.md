# greencode — Atividade 3

Plataforma de logística reversa de eletrônicos: camada analítica (eficiência, rentabilidade e vida útil), API pública
com chaves, escopos e rate limit, e relatórios assíncronos com BullMQ + Redis.
Node.js + TypeScript + Fastify + Prisma + PostgreSQL.

![compatibilidade](https://github.com/ana-franca-01/Av3/actions/workflows/compatibilidade.yml/badge.svg)

**Relatório técnico completo: [DOCUMENTACAO.md](DOCUMENTACAO.md)** (decisões, modelagem, política de retry,
escalabilidade, compatibilidade e cenários testados).

## Como rodar

Pré-requisitos: Node.js ≥ 22 e Docker.

```bash
cp .env.example .env        # Windows (cmd): copy .env.example .env
npm install
npm run db:up               # PostgreSQL + Redis
npm run db:migrate
npm run db:seed             # dados de exemplo + chave de API de demonstração
npm run build
npm start                   # http://localhost:3000 — documentação interativa em /docs
```

## Testes

```bash
npm test                              # unitários (sem banco)
npm run test:e2e                      # ponta a ponta, fila em memória
TESTE_COM_REDIS=1 npm run test:e2e    # ponta a ponta com BullMQ + Redis
bash scripts/testar-ubuntu.sh         # tudo dentro de um Ubuntu 24.04 limpo
```

## Superfícies da API

| Prefixo | Uso | Autenticação |
|---|---|---|
| `/api/v1/public` | parceiros externos | `X-API-Key` (escopos + cota por chave) |
| `/api/v1/internal` | front-end e equipes | JWT |
| `/api/v1/admin` | gestão (usuários, chaves, análises) | JWT, papel ADMIN |
