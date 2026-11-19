import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AnaliticaController, AutenticacaoController, ChaveApiController, EquipamentoController, LoteController, OrganizacaoController,
  ParametroController, ParceiroController, RelatorioController, TarefaController, UsuarioController,
} from '../controllers/controllers';
import * as S from './esquemas';
import * as R from './respostas';

export interface Controllers {
  auth: AutenticacaoController;
  usuarios: UsuarioController;
  parametros: ParametroController;
  organizacoes: OrganizacaoController;
  lotes: LoteController;
  equipamentos: EquipamentoController;
  relatorios: RelatorioController;
  analitica: AnaliticaController;
  chaves: ChaveApiController;
  tarefas: TarefaController;
}

export const PREFIXO_INTERNO = '/api/v1/internal';
export const PREFIXO_ADMIN = '/api/v1/admin';

const seguro = [{ bearerAuth: [] }];

// Operações do dia a dia do front-end e das equipes (JWT de usuário + permissão do papel).
type Gancho = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registrarRotasInternas(app: FastifyInstance, c: Controllers, limiteLogin: Gancho): void {
  app.post<{ Params: unknown; Body: { usuario: string; senha: string }; Querystring: unknown }>('/auth/login', {
    config: { publica: true },
    onRequest: limiteLogin,
    schema: { tags: ['Interna — Autenticação'], summary: 'Troca usuário e senha por um JWT', body: S.login },
  }, c.auth.login);
  app.get('/auth/me', { schema: { tags: ['Interna — Autenticação'], summary: 'Usuário do token', security: seguro } }, c.auth.perfil);
  app.put('/auth/senha', {
    schema: { tags: ['Interna — Autenticação'], summary: 'Altera a própria senha', security: seguro, body: S.alterarSenha },
  }, c.auth.alterarSenha);

  app.get('/parametros', {
    config: { permissao: 'param:ler' }, schema: { tags: ['Interna — Parâmetros'], security: seguro, summary: 'Alíquotas e coeficientes de depreciação' },
  }, c.parametros.listar);

  const o = { tags: ['Interna — Organizações'], security: seguro };
  app.get('/organizacoes', {
    config: { permissao: 'org:ler' },
    schema: { ...o, summary: 'Lista organizações', querystring: { type: 'object', properties: { ...S.paginacao, ativa: { type: 'boolean' }, busca: { type: 'string', maxLength: 120 } } } },
  }, c.organizacoes.listar);
  app.post('/organizacoes', { config: { permissao: 'org:escrever' }, schema: { ...o, summary: 'Cadastra organização', body: S.criarOrganizacao } }, c.organizacoes.criar);
  app.get('/organizacoes/:codigo', { config: { permissao: 'org:ler' }, schema: { ...o, summary: 'Detalha organização', params: S.paramCodigo } }, c.organizacoes.obter);
  app.patch('/organizacoes/:codigo', {
    config: { permissao: 'org:escrever' }, schema: { ...o, summary: 'Altera nome/ativa', params: S.paramCodigo, body: S.alterarOrganizacao },
  }, c.organizacoes.alterar);
  app.put('/organizacoes/:codigo/contrato', {
    config: { permissao: 'org:escrever' }, schema: { ...o, summary: 'Cria ou substitui o contrato de coleta', params: S.paramCodigo, body: S.definirContrato },
  }, c.organizacoes.definirContrato);

  const l = { tags: ['Interna — Lotes'], security: seguro };
  app.get('/lotes', {
    config: { permissao: 'lote:ler' },
    schema: { ...l, summary: 'Lista lotes', querystring: { type: 'object', properties: { ...S.paginacao, organizacao: { type: 'string', maxLength: 10 } } } },
  }, c.lotes.listar);
  app.post('/lotes', {
    config: { permissao: 'lote:escrever' }, schema: { ...l, summary: 'Registra chegada de lote (com equipamentos, atômico)', body: S.criarLote },
  }, c.lotes.criar);
  app.get('/lotes/:codigo', { config: { permissao: 'lote:ler' }, schema: { ...l, summary: 'Detalha lote e equipamentos', params: S.paramCodigo } }, c.lotes.obter);
  app.post('/lotes/:codigo/equipamentos', {
    config: { permissao: 'equip:escrever' }, schema: { ...l, summary: 'Adiciona equipamento ao lote', params: S.paramCodigo, body: S.dadosEquipamento },
  }, c.lotes.adicionarEquipamento);

  const e = { tags: ['Interna — Equipamentos'], security: seguro };
  app.get('/equipamentos', { config: { permissao: 'equip:ler' }, schema: { ...e, summary: 'Lista/filtra equipamentos', querystring: S.filtroEquipamentos } }, c.equipamentos.listar);
  app.post('/equipamentos', { config: { permissao: 'equip:escrever' }, schema: { ...e, summary: 'Registra equipamento', body: S.registrarEquipamento } }, c.equipamentos.registrar);
  app.get('/equipamentos/barras/:barras', {
    config: { permissao: 'equip:ler' }, schema: { ...e, summary: 'Busca pelo código de barras interno' },
  }, c.equipamentos.obterPorBarras);
  app.get('/equipamentos/:codigo', {
    config: { permissao: 'equip:ler' }, schema: { ...e, summary: 'Detalha equipamento (depreciação, valor residual, materiais)', params: S.paramCodigo },
  }, c.equipamentos.obter);
  app.post('/equipamentos/:codigo/status', {
    config: { permissao: 'equip:escrever' },
    schema: { ...e, summary: 'Muda status (RECEBIDO→EM_TRIAGEM→...); na destinação aceita o valor recuperado', params: S.paramCodigo, body: S.moverStatus },
  }, c.equipamentos.moverStatus);
  app.post('/equipamentos/:codigo/triagem', {
    config: { permissao: 'equip:escrever' }, schema: { ...e, summary: 'Conclui a triagem (exige EM_TRIAGEM)', params: S.paramCodigo, body: S.triagem },
  }, c.equipamentos.triar);
  app.post('/equipamentos/:codigo/estado', {
    config: { permissao: 'equip:escrever' }, schema: { ...e, summary: 'Altera estado físico', params: S.paramCodigo, body: S.alterarEstado },
  }, c.equipamentos.alterarEstado);
  app.get('/equipamentos/:codigo/movimentacoes', {
    config: { permissao: 'equip:ler' }, schema: { ...e, summary: 'Rastreabilidade completa', params: S.paramCodigo },
  }, c.equipamentos.rastrear);

  const r = { tags: ['Interna — Relatórios'], security: seguro };
  app.get('/relatorios/resumo', { config: { permissao: 'relatorio:ler' }, schema: { ...r, summary: 'Resumo operacional e financeiro' } }, c.relatorios.resumo);
  app.get('/relatorios/auditoria', {
    config: { permissao: 'auditoria:ler' },
    schema: {
      ...r, summary: 'Trilha de auditoria',
      querystring: { type: 'object', properties: { ...S.paginacao, dias: { type: 'integer', minimum: 1, maximum: 3650 }, ator: { type: 'string', maxLength: 32 }, operacao: { type: 'string', maxLength: 40 } } },
    },
  }, c.relatorios.auditoria);

  const a = { tags: ['Interna — Analítica'], security: seguro };
  app.get('/analitica', { config: { permissao: 'analitica:ler' }, schema: { ...a, summary: 'Categorias de análise disponíveis' } }, c.analitica.catalogo);
  app.get('/analitica/historico', {
    config: { permissao: 'analitica:ler' }, schema: { ...a, summary: 'Relatórios analíticos gravados (sem o corpo)', querystring: S.queryHistorico },
  }, c.analitica.historico);
  app.get('/analitica/historico/:id', {
    config: { permissao: 'analitica:ler' }, schema: { ...a, summary: 'Relatório analítico gravado, com resultado e previsões', params: S.paramId },
  }, c.analitica.obter);
  app.get('/analitica/:categoria', {
    config: { permissao: 'analitica:ler' },
    schema: { ...a, summary: 'Calcula a análise agora (EFICIENCIA, RENTABILIDADE, VIDA_UTIL), sem gravar', params: S.paramCategoria, querystring: S.queryAnalitica },
  }, c.analitica.calcular);
}

// Operações restritas à gestão (papel ADMIN): contas, parâmetros, chaves de parceiros, execução de análises.
export function registrarRotasAdmin(app: FastifyInstance, c: Controllers): void {
  const u = { tags: ['Admin — Usuários'], security: seguro };
  app.get('/usuarios', { config: { permissao: 'usuario:gerir' }, schema: { ...u, summary: 'Lista contas' } }, c.usuarios.listar);
  app.post('/usuarios', { config: { permissao: 'usuario:gerir' }, schema: { ...u, summary: 'Cria conta', body: S.criarUsuario } }, c.usuarios.criar);
  app.patch('/usuarios/:nome/ativo', {
    config: { permissao: 'usuario:gerir' }, schema: { ...u, summary: 'Desativa/reativa conta', body: S.ativoUsuario },
  }, c.usuarios.alterarAtivo);
  app.put('/usuarios/:nome/senha', {
    config: { permissao: 'usuario:gerir' }, schema: { ...u, summary: 'Redefine senha (e destrava a conta)', body: S.redefinirSenha },
  }, c.usuarios.redefinirSenha);

  app.put('/parametros/:chave', {
    config: { permissao: 'param:gerir' }, schema: { tags: ['Admin — Parâmetros'], security: seguro, summary: 'Define um parâmetro', body: S.definirParametro },
  }, c.parametros.definir);

  const k = { tags: ['Admin — Chaves de API'], security: seguro };
  app.post('/chaves', {
    config: { permissao: 'chave:gerir' },
    schema: { ...k, summary: 'Emite chave para um parceiro (o segredo aparece só nesta resposta)', body: S.criarChave },
  }, c.chaves.criar);
  app.get('/chaves', {
    config: { permissao: 'chave:gerir' },
    schema: { ...k, summary: 'Lista chaves', querystring: { type: 'object', properties: { organizacao: { type: 'string', maxLength: 10 } } } },
  }, c.chaves.listar);
  app.patch('/chaves/:prefixo', {
    config: { permissao: 'chave:gerir' }, schema: { ...k, summary: 'Altera escopos, limite ou ativa', params: S.paramPrefixo, body: S.alterarChave },
  }, c.chaves.alterar);
  app.delete('/chaves/:prefixo', {
    config: { permissao: 'chave:gerir' }, schema: { ...k, summary: 'Revoga a chave (desativa; o histórico fica)', params: S.paramPrefixo },
  }, c.chaves.revogar);

  const a = { tags: ['Admin — Analítica'], security: seguro };
  app.post('/analitica/executar', {
    config: { permissao: 'analitica:executar' },
    schema: { ...a, summary: 'Executa e grava análises agora (as mesmas do agendamento noturno)', body: S.executarAnalitica },
  }, c.analitica.executar);
  app.get('/tarefas', {
    config: { permissao: 'analitica:executar' }, schema: { ...a, summary: 'Todas as tarefas de relatório assíncrono', querystring: S.queryTarefas },
  }, c.tarefas.listar);
  app.get('/tarefas/:id', {
    config: { permissao: 'analitica:executar' }, schema: { ...a, summary: 'Detalhe de uma tarefa', params: S.paramId },
  }, c.tarefas.obter);
}

const chave = [{ apiKey: [] }];

// Contrato com parceiros externos (chave de API + escopo + rate limit, aplicados pelo plugin api-publica).
export function registrarRotasPublicas(app: FastifyInstance, c: ParceiroController): void {
  app.get('/me', {
    schema: { tags: ['Pública v1 — Conta'], summary: 'Dados da chave usada (parceiro, organização, escopos, limite)', security: chave, response: R.respQuemSou },
  }, c.quemSou);

  const rt = { tags: ['Pública v1 — Rastreabilidade'], security: chave };
  app.get('/equipamentos', {
    config: { escopo: 'RASTREIO_LER' },
    schema: { ...rt, summary: 'Equipamentos da sua organização', querystring: S.queryEquipamentosPublico, response: R.respEquipamentos },
  }, c.listarEquipamentos);
  app.get('/equipamentos/:codigo/rastreabilidade', {
    config: { escopo: 'RASTREIO_LER' },
    schema: {
      ...rt, summary: 'Histórico completo de um equipamento (cadeia de custódia)',
      description: 'Cada movimentação é imutável (garantido por trigger no banco). A ordem dos ids é a ordem dos fatos.',
      params: S.paramCodigo, response: R.respRastreio,
    },
  }, c.rastrear);

  const lt = { tags: ['Pública v1 — Lotes'], security: chave };
  app.get('/lotes', { config: { escopo: 'LOTE_LER' }, schema: { ...lt, summary: 'Lotes da sua organização', querystring: { type: 'object', properties: S.paginacao }, response: R.respLotes } }, c.listarLotes);
  app.get('/lotes/:codigo', { config: { escopo: 'LOTE_LER' }, schema: { ...lt, summary: 'Lote com seus equipamentos', params: S.paramCodigo, response: R.respLote } }, c.obterLote);
  app.post('/lotes', {
    config: { escopo: 'LOTE_ESCREVER' },
    schema: {
      ...lt, summary: 'Submete um novo lote (com equipamentos) para coleta',
      description: 'A organização vem da chave. Lote e equipamentos são gravados numa transação só: se um item for inválido, nada é gravado e a mensagem indica qual item falhou.',
      body: S.criarLotePublico, response: R.respCriarLote,
    },
  }, c.criarLote);

  app.get('/analitica/:categoria', {
    config: { escopo: 'ANALITICA_LER' },
    schema: {
      tags: ['Pública v1 — Analítica'], security: chave, summary: 'Indicadores da sua organização calculados na hora',
      description: 'EFICIENCIA: tempos de processamento. RENTABILIDADE: valor estimado de recuperação por tipo/marca/modelo. VIDA_UTIL: previsão de quando cada equipamento ativo fica inservível.',
      params: S.paramCategoria, response: R.respAnalise,
    },
  }, c.analise);

  const rl = { tags: ['Pública v1 — Relatórios assíncronos'], security: chave };
  app.post('/relatorios', {
    config: { escopo: 'RELATORIO_GERAR' },
    schema: {
      ...rl, summary: 'Pede a geração de um relatório (responde 202 na hora com o id da tarefa)',
      description: 'Fluxo: POST → 202 + Location → GET /relatorios/{id} até status CONCLUIDA (respeite Retry-After) → GET /relatorios/{id}/download.',
      body: S.solicitarRelatorio, response: R.respSolicitar,
    },
  }, c.solicitarRelatorio);
  app.get('/relatorios', { config: { escopo: 'RELATORIO_GERAR' }, schema: { ...rl, summary: 'Suas tarefas de relatório', querystring: S.queryTarefas, response: R.respTarefas } }, c.listarRelatorios);
  app.get('/relatorios/:id', { config: { escopo: 'RELATORIO_GERAR' }, schema: { ...rl, summary: 'Status da tarefa', params: S.paramId, response: R.respTarefa } }, c.statusRelatorio);
  app.get('/relatorios/:id/download', {
    config: { escopo: 'RELATORIO_GERAR' },
    schema: { ...rl, summary: 'Baixa o arquivo (JSON ou CSV) de uma tarefa concluída', params: S.paramId, response: R.respDownload, produces: ['application/json', 'text/csv'] },
  }, c.baixarRelatorio);
}
