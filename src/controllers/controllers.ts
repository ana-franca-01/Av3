import { FastifyReply, FastifyRequest } from 'fastify';
import { Ator } from '../servicos/comum';
import { AutenticacaoServico } from '../servicos/autenticacao.servico';
import { DadosEquipamento, EquipamentoServico } from '../servicos/equipamento.servico';
import { LoteServico } from '../servicos/lote.servico';
import { DadosContrato, OrganizacaoServico } from '../servicos/organizacao.servico';
import { ParametroServico } from '../servicos/parametro.servico';
import { RelatorioServico } from '../servicos/relatorio.servico';
import { UsuarioServico } from '../servicos/usuario.servico';
import { Pagina } from '../repositorios/base';
import { AnaliticaServico, CATEGORIAS } from '../analitica/analitica.servico';
import { OrganizacaoServico as OrgServ } from '../servicos/organizacao.servico';
import { UnidadeDeTrabalho } from '../repositorios/repositorios';
import { ChaveApiServico, Parceiro } from '../servicos/chave-api.servico';
import { ParceiroServico } from '../servicos/parceiro.servico';
import { TarefaServico } from '../servicos/tarefa.servico';



type Req<P = unknown, B = unknown, Q = unknown> = FastifyRequest<{ Params: P; Body: B; Querystring: Q }>;
type ComCodigo = { codigo: string };
type QPagina = { pagina?: number; tamanho?: number };

const ator = (req: FastifyRequest): Ator => ({ nome: req.user.sub, papel: req.user.papel });
const pagina = (q: QPagina): Pagina => ({ pagina: q.pagina ?? 1, tamanho: q.tamanho ?? 20 });

export class AutenticacaoController {
  constructor(private readonly auth: AutenticacaoServico) {}

  login = async (req: Req<unknown, { usuario: string; senha: string }>, reply: FastifyReply) => {
    const a = await this.auth.login(req.body.usuario, req.body.senha);
    const token = await reply.jwtSign({ sub: a.nome, papel: a.papel });
    return { token, tipo: 'Bearer', usuario: a.nome, papel: a.papel };
  };
  perfil = (req: FastifyRequest) => this.auth.perfil(ator(req));
  alterarSenha = (req: Req<unknown, { senhaAtual: string; novaSenha: string }>) =>
    this.auth.alterarPropriaSenha(ator(req), req.body.senhaAtual, req.body.novaSenha);
}

export class UsuarioController {
  constructor(private readonly usuarios: UsuarioServico) {}
  listar = () => this.usuarios.listar();
  criar = async (req: Req<unknown, { nome: string; papel: string; senha: string }>, reply: FastifyReply) =>
    reply.status(201).send(await this.usuarios.criar(ator(req), req.body));
  alterarAtivo = (req: Req<{ nome: string }, { ativo: boolean; versao?: number }>) =>
    this.usuarios.alterarAtivo(ator(req), req.params.nome, req.body.ativo, req.body.versao);
  redefinirSenha = (req: Req<{ nome: string }, { senha: string }>) =>
    this.usuarios.redefinirSenha(ator(req), req.params.nome, req.body.senha);
}

export class ParametroController {
  constructor(private readonly params: ParametroServico) {}
  listar = () => this.params.listar();
  definir = (req: Req<{ chave: string }, { valor: number; versao?: number }>) =>
    this.params.definir(ator(req), req.params.chave, req.body.valor, req.body.versao);
}

export class OrganizacaoController {
  constructor(private readonly orgs: OrganizacaoServico) {}
  listar = (req: Req<unknown, unknown, QPagina & { ativa?: boolean; busca?: string }>) =>
    this.orgs.listar(pagina(req.query), { ativa: req.query.ativa, busca: req.query.busca });
  obter = (req: Req<ComCodigo>) => this.orgs.obter(req.params.codigo);
  criar = async (req: Req<unknown, { cnpj: string; nome: string; tipo: string }>, reply: FastifyReply) =>
    reply.status(201).send(await this.orgs.criar(ator(req), req.body));
  alterar = (req: Req<ComCodigo, { nome?: string; ativa?: boolean; versao?: number }>) =>
    this.orgs.alterar(ator(req), req.params.codigo, req.body);
  definirContrato = (req: Req<ComCodigo, DadosContrato>) => this.orgs.definirContrato(ator(req), req.params.codigo, req.body);
}

type CorpoLote = { organizacao: string; notaFiscal: string; transportadora: string; dataEntrada?: string; equipamentos?: DadosEquipamento[] };

export class LoteController {
  constructor(private readonly lotes: LoteServico, private readonly equipamentos: EquipamentoServico) {}
  listar = (req: Req<unknown, unknown, QPagina & { organizacao?: string }>) =>
    this.lotes.listar(pagina(req.query), { organizacao: req.query.organizacao });
  obter = (req: Req<ComCodigo>) => this.lotes.obter(req.params.codigo);
  criar = async (req: Req<unknown, CorpoLote>, reply: FastifyReply) => reply.status(201).send(await this.lotes.criar(ator(req), req.body));
  adicionarEquipamento = async (req: Req<ComCodigo, DadosEquipamento>, reply: FastifyReply) =>
    reply.status(201).send(await this.equipamentos.registrar(ator(req), req.params.codigo, req.body));
}

export class EquipamentoController {
  constructor(private readonly equipamentos: EquipamentoServico) {}
  listar = (req: Req<unknown, unknown, QPagina & { lote?: string; status?: string; tipo?: string; estado?: string }>) =>
    this.equipamentos.listar(pagina(req.query), req.query);
  obter = (req: Req<ComCodigo>) => this.equipamentos.obter(req.params.codigo);
  obterPorBarras = (req: Req<{ barras: string }>) => this.equipamentos.obterPorBarras(req.params.barras);
  registrar = async (req: Req<unknown, DadosEquipamento & { lote: string }>, reply: FastifyReply) => {
    const { lote, ...dados } = req.body;
    return reply.status(201).send(await this.equipamentos.registrar(ator(req), lote, dados));
  };
  moverStatus = (req: Req<ComCodigo, { status: string; observacao?: string; versao?: number; valorRecuperado?: number }>) =>
    this.equipamentos.moverStatus(ator(req), req.params.codigo, req.body);
  triar = (req: Req<ComCodigo, { estado: string; classe: string; justificativa?: string; observacao?: string; versao?: number }>) =>
    this.equipamentos.triar(ator(req), req.params.codigo, req.body);
  alterarEstado = (req: Req<ComCodigo, { estado: string; justificativa?: string; versao?: number }>) =>
    this.equipamentos.alterarEstado(ator(req), req.params.codigo, req.body);
  rastrear = (req: Req<ComCodigo>) => this.equipamentos.rastrear(req.params.codigo);
}

export class RelatorioController {
  constructor(private readonly relatorios: RelatorioServico) {}
  resumo = () => this.relatorios.resumo();
  auditoria = (req: Req<unknown, unknown, QPagina & { dias?: number; ator?: string; operacao?: string }>) =>
    this.relatorios.auditoria(pagina(req.query), req.query);
}

// ---------------------------------------------------------------- AV3

type QAnalitica = { organizacao?: string };

export class AnaliticaController {
  constructor(private readonly analitica: AnaliticaServico, private readonly uow: UnidadeDeTrabalho) {}

  private async escopo(codigo?: string) {
    if (!codigo) return { organizacaoId: null, organizacaoCodigo: null };
    const o = await OrgServ.buscar(this.uow.leitura, codigo);
    return { organizacaoId: o.id, organizacaoCodigo: o.codigo };
  }

  catalogo = () => this.analitica.catalogo();

  calcular = async (req: Req<{ categoria: string }, unknown, QAnalitica>) => {
    const x = await this.analitica.executarUma(AnaliticaServico.categoria(req.params.categoria), await this.escopo(req.query.organizacao),
      { persistir: false, origem: 'SOB_DEMANDA', ator: ator(req) });
    return x;
  };

  // grava no histórico; sem categorias, roda as três
  executar = async (req: Req<unknown, { categorias?: string[]; organizacao?: string }>, reply: FastifyReply) => {
    const cats = req.body.categorias?.length ? [...new Set(req.body.categorias.map(AnaliticaServico.categoria))] : CATEGORIAS;
    const execs = await this.analitica.executar(cats, await this.escopo(req.body.organizacao), { persistir: true, origem: 'SOB_DEMANDA', ator: ator(req) });
    return reply.status(201).send(execs.map(({ resultado: _r, ...resumo }) => resumo));
  };

  historico = async (req: Req<unknown, unknown, QPagina & QAnalitica & { categoria?: string }>) => {
    const esc = req.query.organizacao ? await this.escopo(req.query.organizacao) : undefined;
    return this.analitica.historico(pagina(req.query), { categoria: req.query.categoria, organizacaoId: esc?.organizacaoId });
  };

  obter = (req: Req<{ id: string }>) => this.analitica.obterRelatorio(req.params.id);
}

export class ChaveApiController {
  constructor(private readonly chaves: ChaveApiServico) {}
  criar = async (req: Req<unknown, { parceiro: string; organizacao: string; escopos: string[]; limitePorMinuto?: number; validadeDias?: number }>, reply: FastifyReply) =>
    reply.status(201).send(await this.chaves.criar(ator(req), req.body));
  listar = (req: Req<unknown, unknown, { organizacao?: string }>) => this.chaves.listar(req.query);
  alterar = (req: Req<{ prefixo: string }, { ativa?: boolean; escopos?: string[]; limitePorMinuto?: number; versao?: number }>) =>
    this.chaves.alterar(ator(req), req.params.prefixo, req.body);
  revogar = (req: Req<{ prefixo: string }>) => this.chaves.revogar(ator(req), req.params.prefixo);
}

export class TarefaController {
  constructor(private readonly tarefas: TarefaServico) {}
  listar = (req: Req<unknown, unknown, QPagina & { status?: string }>) => this.tarefas.listar(pagina(req.query), { status: req.query.status });
  obter = (req: Req<{ id: string }>) => this.tarefas.obter(req.params.id, {});
}

// o plugin da API pública garante que req.parceiro existe antes de chegar aqui
const parceiro = (req: FastifyRequest): Parceiro => req.parceiro!;

export class ParceiroController {
  constructor(private readonly svc: ParceiroServico) {}

  quemSou = (req: FastifyRequest) => {
    const p = parceiro(req);
    return { parceiro: p.parceiro, prefixo: p.prefixo, organizacao: p.organizacaoCodigo, escopos: p.escopos, limitePorMinuto: p.limitePorMinuto };
  };
  listarEquipamentos = (req: Req<unknown, unknown, QPagina & { lote?: string; status?: string; tipo?: string }>) =>
    this.svc.listarEquipamentos(parceiro(req), pagina(req.query), req.query);
  rastrear = (req: Req<ComCodigo>) => this.svc.rastrear(parceiro(req), req.params.codigo);
  listarLotes = (req: Req<unknown, unknown, QPagina>) => this.svc.listarLotes(parceiro(req), pagina(req.query));
  obterLote = (req: Req<ComCodigo>) => this.svc.obterLote(parceiro(req), req.params.codigo);
  criarLote = async (req: Req<unknown, Omit<CorpoLote, 'organizacao'>>, reply: FastifyReply) =>
    reply.status(201).send(await this.svc.criarLote(parceiro(req), req.body));
  analise = (req: Req<{ categoria: string }>) => this.svc.analise(parceiro(req), req.params.categoria);

  solicitarRelatorio = async (req: Req<unknown, { tipo: string; formato?: string }>, reply: FastifyReply) => {
    const t = await this.svc.solicitarRelatorio(parceiro(req), req.body);
    // 202: aceito, ainda não pronto. Location aponta pra onde consultar o status (polling).
    return reply.status(202).header('location', t.links.status).send(t);
  };
  listarRelatorios = (req: Req<unknown, unknown, QPagina & { status?: string }>) =>
    this.svc.listarRelatorios(parceiro(req), pagina(req.query), req.query.status);
  statusRelatorio = async (req: Req<{ id: string }>, reply: FastifyReply) => {
    const t = await this.svc.statusRelatorio(parceiro(req), req.params.id);
    // sugere ao cliente quando perguntar de novo, em vez de martelar o endpoint
    if (t.status === 'PENDENTE' || t.status === 'PROCESSANDO') reply.header('retry-after', '5');
    return t;
  };
  baixarRelatorio = async (req: Req<{ id: string }>, reply: FastifyReply) => {
    const a = await this.svc.baixarRelatorio(parceiro(req), req.params.id);
    return reply.type(a.contentType).header('content-disposition', `attachment; filename="${a.nomeArquivo}"`).send(a.conteudo);
  };
}
