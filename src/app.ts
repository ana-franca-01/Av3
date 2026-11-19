import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { PrismaClient } from '@prisma/client';
import Fastify, { FastifyInstance } from 'fastify';
import IORedis from 'ioredis';
import { Agendador } from './analitica/agendador';
import { Servicos, montarServicos } from './composicao';
import { Ambiente } from './config/ambiente';
import {
  AnaliticaController, AutenticacaoController, ChaveApiController, EquipamentoController, LoteController, OrganizacaoController,
  ParametroController, ParceiroController, RelatorioController, TarefaController, UsuarioController,
} from './controllers/controllers';
import { FilaRelatorios } from './fila/fila';
import { PREFIXO_PUBLICO, VERSAO_API_PUBLICA, registrarApiPublica } from './plugins/api-publica';
import { registrarAutenticacao } from './plugins/autenticacao';
import { registrarLimites } from './plugins/limites';
import { registrarTratamentoErros } from './plugins/erros';
import { PREFIXO_ADMIN, PREFIXO_INTERNO, registrarRotasAdmin, registrarRotasInternas, registrarRotasPublicas } from './rotas/rotas';
import { Relogio } from './servicos/comum';

export const VERSAO = '3.0.0';

declare module 'fastify' {
  interface FastifyInstance { greencode: Servicos & { agendador: Agendador } }
}

export interface OpcoesApp {
  ambiente: Ambiente;
  prisma?: PrismaClient;
  relogio?: Relogio;
  logger?: boolean;
  fila?: FilaRelatorios;
}

const DESCRICAO = `Logística reversa de eletrônicos — AV3: camada analítica + API pública.

**Três superfícies, três políticas de segurança:**
- \`${PREFIXO_PUBLICO}\` — parceiros externos. Autenticação por **X-API-Key**, autorização por **escopo** da chave e **limite de requisições por minuto** por chave (cabeçalhos \`x-ratelimit-*\`). Todo dado é recortado pela organização da chave.
- \`${PREFIXO_INTERNO}\` — front-end e equipes. JWT (Bearer) obtido em \`POST ${PREFIXO_INTERNO}/auth/login\`, autorização pelo papel do usuário.
- \`${PREFIXO_ADMIN}\` — gestão (papel ADMIN): usuários, parâmetros, chaves de parceiros, execução de análises.

Erros sempre no formato \`{ "erro": "<código>", "mensagem": "...", "detalhes"?: ... }\`. Versão do contrato público: **${VERSAO_API_PUBLICA}** (cabeçalho \`x-api-version\`).`;

export async function construirApp(opts: OpcoesApp): Promise<FastifyInstance> {
  const { ambiente } = opts;
  const relogio = opts.relogio ?? (() => new Date());
  const prisma = opts.prisma ?? new PrismaClient({ datasourceUrl: ambiente.databaseUrl });

  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: ambiente.logLevel,
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.body.senha', 'req.body.senhaAtual', 'req.body.novaSenha'],
    },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: ambiente.trustProxy,
    forceCloseConnections: 'idle',
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true, allErrors: false } },
  });

  const s = montarServicos({ prisma, ambiente, relogio, log: app.log, fila: opts.fila });
  // a fila em memória só existe neste processo, então o worker tem que rodar aqui mesmo
  if (ambiente.workerEmbutido || s.fila.tipo === 'memoria') s.fila.iniciarWorker((id, t, u) => s.tarefas.processar(id, t, u));
  const agendador = new Agendador(s.uow, s.analitica, s.tarefas, app.log, relogio);
  app.decorate('greencode', { ...s, agendador });

  registrarTratamentoErros(app);

  // contadores do rate limit no Redis: com várias réplicas, o limite vale para o conjunto e não por instância
  // a fila offline do ioredis segura os comandos até a conexão abrir (sem ela, os primeiros segundos após a subida
  // passariam sem limite); com o Redis fora do ar, o comando falha após 1 nova tentativa e o limite é suspenso
  const redisRateLimit = ambiente.redisUrl ? new IORedis(ambiente.redisUrl, { connectTimeout: 1_000, maxRetriesPerRequest: 1 }) : undefined;
  redisRateLimit?.on('error', (e) => app.log.warn({ err: e }, 'redis (rate limit): erro de conexão'));
  await registrarLimites(app, { ipPorMinuto: ambiente.rateLimitIpPorMinuto, loginPorMinuto: ambiente.rateLimitLoginPorMinuto, redis: redisRateLimit });

  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'greencode API', version: VERSAO, description: DESCRICAO },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Formato gc_<prefixo>_<segredo>, emitida pelo admin em POST /api/v1/admin/chaves' },
        },
      },
      tags: [
        { name: 'Pública v1 — Conta', description: 'Identificação da chave' },
        { name: 'Pública v1 — Rastreabilidade', description: 'Status e cadeia de custódia dos equipamentos (escopo RASTREIO_LER)' },
        { name: 'Pública v1 — Lotes', description: 'Consulta (LOTE_LER) e submissão (LOTE_ESCREVER) de lotes' },
        { name: 'Pública v1 — Analítica', description: 'Indicadores calculados na hora (ANALITICA_LER)' },
        { name: 'Pública v1 — Relatórios assíncronos', description: 'Geração em fila com polling (RELATORIO_GERAR)' },
      ],
    },
  });
  app.addHook('onRoute', (r) => {
    if (r.url.startsWith('/docs')) r.config = { ...(r.config ?? {}), publica: true };
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list', persistAuthorization: true } });

  registrarAutenticacao(app, { segredo: ambiente.jwtSegredo, expiraEm: ambiente.jwtExpiraEm, repos: s.uow.leitura });

  app.get('/health', { config: { publica: true }, schema: { tags: ['Sistema'], summary: 'Saúde do servidor, do banco e da fila' } }, async (_req, reply) => {
    const [banco, fila] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true, () => false),
      s.fila.saude(),
    ]);
    const corpo = { status: banco && fila ? 'ok' : 'degradado', versao: VERSAO, banco: banco ? 'ok' : 'indisponível', fila: `${s.fila.tipo}: ${fila ? 'ok' : 'indisponível'}` };
    return banco ? corpo : reply.status(503).send(corpo);
  });

  const c = {
    auth: new AutenticacaoController(s.auth),
    usuarios: new UsuarioController(s.usuarios),
    parametros: new ParametroController(s.params),
    organizacoes: new OrganizacaoController(s.organizacoes),
    lotes: new LoteController(s.lotes, s.equipamentos),
    equipamentos: new EquipamentoController(s.equipamentos),
    relatorios: new RelatorioController(s.relatorios),
    analitica: new AnaliticaController(s.analitica, s.uow),
    chaves: new ChaveApiController(s.chaves),
    tarefas: new TarefaController(s.tarefas),
  };
  const limiteLogin = app.limite('login', { max: ambiente.rateLimitLoginPorMinuto, chave: (req) => req.ip });
  await app.register(async (i) => registrarRotasInternas(i, c, limiteLogin), { prefix: PREFIXO_INTERNO });
  await app.register(async (i) => registrarRotasAdmin(i, c), { prefix: PREFIXO_ADMIN });

  await registrarApiPublica(app, {
    chaves: s.chaves, repos: s.uow.leitura,
    rotas: (i) => registrarRotasPublicas(i, new ParceiroController(s.parceiros)),
  });

  if (ambiente.analiticaCron) app.addHook('onReady', async () => agendador.iniciar(ambiente.analiticaCron!, ambiente.analiticaFuso));

  // ordem do desligamento: para de agendar, espera os jobs em andamento, fecha Redis e banco
  app.addHook('onClose', async () => {
    await agendador.parar();
    await s.fila.fechar();
    await redisRateLimit?.quit().catch(() => undefined);
    if (!opts.prisma) await prisma.$disconnect();
  });

  return app;
}
