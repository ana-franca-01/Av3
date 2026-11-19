import {
  CategoriaAnalise, EstadoFisico, Papel, Prisma, PrismaClient, StatusEquipamento, StatusTarefa, TipoEquipamento,
} from '@prisma/client';
import { Db, NomeSequencia, Pagina, garantirVersao, proximaSequencia, skipTake } from './base';


export class UsuarioRepositorio {
  constructor(private readonly db: Db) {}
  buscarPorNome(nome: string) { return this.db.usuario.findUnique({ where: { nome } }); }
  listar() { return this.db.usuario.findMany({ orderBy: { nome: 'asc' } }); }
  contarAdminsAtivos() { return this.db.usuario.count({ where: { papel: 'ADMIN', ativo: true } }); }
  criar(d: { nome: string; papel: Papel; senhaHash: string }) { return this.db.usuario.create({ data: d }); }

  async atualizar(id: string, versao: number, data: Prisma.UsuarioUpdateManyMutationInput) {
    garantirVersao(await this.db.usuario.updateMany({ where: { id, versao }, data: { ...data, versao: { increment: 1 } } }), 'Usuário', versao);
    return this.db.usuario.findUniqueOrThrow({ where: { id } });
  }

  registrarFalha(id: string, bloquearAte: Date | null) {
    return this.db.usuario.update({
      where: { id },
      data: bloquearAte ? { falhasLogin: 0, bloqueadoAte: bloquearAte } : { falhasLogin: { increment: 1 } },
    });
  }
  limparFalhas(id: string) { return this.db.usuario.update({ where: { id }, data: { falhasLogin: 0, bloqueadoAte: null } }); }
}

export class ParametroRepositorio {
  constructor(private readonly db: Db) {}
  listar() { return this.db.parametro.findMany({ orderBy: { chave: 'asc' } }); }
  buscar(chave: string) { return this.db.parametro.findUnique({ where: { chave } }); }
  criar(chave: string, valor: number, ator: string) {
    return this.db.parametro.create({ data: { chave, valor, atualizadoPor: ator } });
  }
  async atualizar(chave: string, versao: number, valor: number, ator: string) {
    garantirVersao(await this.db.parametro.updateMany({
      where: { chave, versao }, data: { valor, atualizadoPor: ator, versao: { increment: 1 } },
    }), 'Parâmetro', versao);
    return this.db.parametro.findUniqueOrThrow({ where: { chave } });
  }
}

const incluirOrg = { contrato: true, _count: { select: { lotes: true } } } satisfies Prisma.OrganizacaoInclude;

export class OrganizacaoRepositorio {
  constructor(private readonly db: Db) {}
  buscarPorCodigo(codigo: string) { return this.db.organizacao.findUnique({ where: { codigo }, include: incluirOrg }); }
  buscarPorId(id: string) { return this.db.organizacao.findUnique({ where: { id }, include: incluirOrg }); }
  existeCnpj(cnpj: string) { return this.db.organizacao.count({ where: { cnpj } }).then((n) => n > 0); }
  criar(d: Prisma.OrganizacaoUncheckedCreateInput) { return this.db.organizacao.create({ data: d, include: incluirOrg }); }

  async listar(p: Pagina, filtro: { ativa?: boolean; busca?: string }) {
    const where: Prisma.OrganizacaoWhereInput = {
      ativa: filtro.ativa,
      ...(filtro.busca ? { OR: [{ nome: { contains: filtro.busca, mode: 'insensitive' } }, { cnpj: { contains: filtro.busca.toUpperCase() } }] } : {}),
    };
    const [itens, total] = await Promise.all([
      this.db.organizacao.findMany({ where, include: incluirOrg, orderBy: { codigo: 'asc' }, ...skipTake(p) }),
      this.db.organizacao.count({ where }),
    ]);
    return { itens, total };
  }

  async atualizar(id: string, versao: number, data: Prisma.OrganizacaoUpdateManyMutationInput) {
    garantirVersao(await this.db.organizacao.updateMany({ where: { id, versao }, data: { ...data, versao: { increment: 1 } } }), 'Organização', versao);
    return this.db.organizacao.findUniqueOrThrow({ where: { id }, include: incluirOrg });
  }

  criarContrato(d: Prisma.ContratoUncheckedCreateInput) { return this.db.contrato.create({ data: d }); }
  async atualizarContrato(id: string, versao: number, data: Prisma.ContratoUpdateManyMutationInput) {
    garantirVersao(await this.db.contrato.updateMany({ where: { id, versao }, data: { ...data, versao: { increment: 1 } } }), 'Contrato', versao);
    return this.db.contrato.findUniqueOrThrow({ where: { id } });
  }
}

export class LoteRepositorio {
  constructor(private readonly db: Db) {}
  buscarPorCodigo(codigo: string) {
    return this.db.lote.findUnique({
      where: { codigo },
      include: { organizacao: { select: { codigo: true } }, equipamentos: { orderBy: { codigo: 'asc' } } },
    });
  }
  existeNf(organizacaoId: string, notaFiscal: string) {
    return this.db.lote.count({ where: { organizacaoId, notaFiscal } }).then((n) => n > 0);
  }
  criar(d: Prisma.LoteUncheckedCreateInput) { return this.db.lote.create({ data: d }); }

  async listar(p: Pagina, filtro: { organizacaoCodigo?: string }) {
    const where: Prisma.LoteWhereInput = filtro.organizacaoCodigo ? { organizacao: { codigo: filtro.organizacaoCodigo } } : {};
    const [itens, total] = await Promise.all([
      this.db.lote.findMany({
        where, orderBy: { codigo: 'asc' }, ...skipTake(p),
        include: { organizacao: { select: { codigo: true } }, _count: { select: { equipamentos: true } } },
      }),
      this.db.lote.count({ where }),
    ]);
    return { itens, total };
  }
}

const incluirEquip = { lote: { select: { codigo: true, organizacaoId: true } } } satisfies Prisma.EquipamentoInclude;

export class EquipamentoRepositorio {
  constructor(private readonly db: Db) {}
  buscarPorCodigo(codigo: string) { return this.db.equipamento.findUnique({ where: { codigo }, include: incluirEquip }); }
  buscarPorBarras(codigoBarrasInterno: string) {
    return this.db.equipamento.findUnique({ where: { codigoBarrasInterno }, include: incluirEquip });
  }
  existeSerie(serie: string) { return this.db.equipamento.count({ where: { serie } }).then((n) => n > 0); }
  criar(d: Prisma.EquipamentoUncheckedCreateInput) { return this.db.equipamento.create({ data: d, include: incluirEquip }); }

  async listar(p: Pagina, filtro: { loteCodigo?: string; organizacaoId?: string; status?: StatusEquipamento; tipo?: TipoEquipamento; estado?: EstadoFisico }) {
    const where: Prisma.EquipamentoWhereInput = {
      status: filtro.status, tipo: filtro.tipo, estado: filtro.estado,
      lote: { codigo: filtro.loteCodigo, organizacaoId: filtro.organizacaoId },
    };
    const [itens, total] = await Promise.all([
      this.db.equipamento.findMany({ where, include: incluirEquip, orderBy: { codigo: 'asc' }, ...skipTake(p) }),
      this.db.equipamento.count({ where }),
    ]);
    return { itens, total };
  }

  async atualizar(id: string, versao: number, data: Prisma.EquipamentoUpdateManyMutationInput) {
    garantirVersao(await this.db.equipamento.updateMany({ where: { id, versao }, data: { ...data, versao: { increment: 1 } } }), 'Equipamento', versao);
    return this.db.equipamento.findUniqueOrThrow({ where: { id }, include: incluirEquip });
  }

  contarPorStatus() { return this.db.equipamento.groupBy({ by: ['status'], _count: { _all: true } }); }
  contarPorTipo() { return this.db.equipamento.groupBy({ by: ['tipo'], _count: { _all: true } }); }
  paraAvaliacao() {
    return this.db.equipamento.findMany({
      where: { valorAquisicao: { not: null }, anoFabricacao: { not: null } },
      select: { tipo: true, valorAquisicao: true, anoFabricacao: true },
    });
  }
}

export class MovimentacaoRepositorio {
  constructor(private readonly db: Db) {}
  criar(d: Prisma.MovimentacaoUncheckedCreateInput) { return this.db.movimentacao.create({ data: d }); }
  listarDoEquipamento(equipamentoId: string) {
    return this.db.movimentacao.findMany({ where: { equipamentoId }, orderBy: { id: 'asc' } });
  }
}

export class AuditoriaRepositorio {
  constructor(private readonly db: Db) {}
  registrar(ator: string, operacao: string, resumo: string) {
    return this.db.auditoria.create({ data: { ator, operacao, resumo: resumo.slice(0, 500) } });
  }
  async listar(p: Pagina, filtro: { desde?: Date; ator?: string; operacao?: string }) {
    const where: Prisma.AuditoriaWhereInput = {
      ts: filtro.desde ? { gte: filtro.desde } : undefined, ator: filtro.ator, operacao: filtro.operacao,
    };
    const [itens, total] = await Promise.all([
      this.db.auditoria.findMany({ where, orderBy: { id: 'desc' }, ...skipTake(p) }),
      this.db.auditoria.count({ where }),
    ]);
    return { itens, total };
  }
}

// ---------------------------------------------------------------- AV3

export class AnaliticaRepositorio {
  constructor(private readonly db: Db) {}

  // Tudo que as análises precisam numa consulta só (equipamento + data do lote + histórico de estados).
  equipamentos(organizacaoId?: string | null) {
    return this.db.equipamento.findMany({
      where: organizacaoId ? { lote: { organizacaoId } } : {},
      orderBy: { codigo: 'asc' },
      select: {
        id: true, codigo: true, tipo: true, marca: true, modelo: true, estado: true, status: true,
        valorAquisicao: true, anoFabricacao: true, valorRecuperado: true, triagemResponsavel: true, triagemEm: true,
        lote: { select: { dataEntrada: true } },
        movimentacoes: { orderBy: { id: 'asc' }, select: { ts: true, statusPara: true, estadoPara: true } },
      },
    });
  }

  previsoesAnteriores(antesDe: Date) {
    return this.db.previsaoVidaUtil.findMany({
      where: { geradoEm: { lt: antesDe }, vidaUtilAnos: { not: null } },
      select: { tipo: true, vidaUtilAnos: true, geradoEm: true },
    });
  }

  // previsões por equipamento feitas antes de "antesDe", só dos equipamentos que já chegaram a SUCATA
  // (os únicos que dá pra comparar com a realização)
  previsoesEquipamentoAnteriores(antesDe: Date, organizacaoId?: string | null) {
    return this.db.previsaoEquipamento.findMany({
      where: {
        geradoEm: { lt: antesDe },
        equipamento: { movimentacoes: { some: { estadoPara: 'SUCATA' } }, ...(organizacaoId ? { lote: { organizacaoId } } : {}) },
      },
      select: { dataPrevistaInservivel: true, geradoEm: true, equipamento: { select: { codigo: true } } },
    });
  }

  salvarRelatorio(
    d: Prisma.RelatorioAnaliticoUncheckedCreateInput,
    previsoes: Omit<Prisma.PrevisaoVidaUtilCreateManyRelatorioInput, 'geradoEm'>[] = [],
    previsoesEquipamento: Omit<Prisma.PrevisaoEquipamentoCreateManyRelatorioInput, 'geradoEm'>[] = [],
  ) {
    const comData = <T>(l: T[]) => l.map((p) => ({ ...p, geradoEm: d.geradoEm }));
    return this.db.relatorioAnalitico.create({
      data: {
        ...d,
        previsoes: previsoes.length ? { createMany: { data: comData(previsoes) } } : undefined,
        previsoesEquipamento: previsoesEquipamento.length ? { createMany: { data: comData(previsoesEquipamento) } } : undefined,
      },
    });
  }

  async listarRelatorios(p: Pagina, filtro: { categoria?: CategoriaAnalise; organizacaoId?: string | null }) {
    const where: Prisma.RelatorioAnaliticoWhereInput = { categoria: filtro.categoria, organizacaoId: filtro.organizacaoId };
    const [itens, total] = await Promise.all([
      this.db.relatorioAnalitico.findMany({
        where, orderBy: { id: 'desc' }, ...skipTake(p),
        omit: { resultado: true }, include: { organizacao: { select: { codigo: true } } },
      }),
      this.db.relatorioAnalitico.count({ where }),
    ]);
    return { itens, total };
  }

  buscarRelatorio(id: bigint) {
    return this.db.relatorioAnalitico.findUnique({ where: { id }, include: { organizacao: { select: { codigo: true } }, previsoes: true } });
  }

  ultimoRelatorio(categoria: CategoriaAnalise, organizacaoId: string | null) {
    return this.db.relatorioAnalitico.findFirst({
      where: { categoria, organizacaoId }, orderBy: { id: 'desc' }, include: { organizacao: { select: { codigo: true } }, previsoes: true },
    });
  }
}

const incluirChave = { organizacao: { select: { codigo: true, ativa: true } } } satisfies Prisma.ChaveApiInclude;

export class ChaveApiRepositorio {
  constructor(private readonly db: Db) {}
  buscarPorPrefixo(prefixo: string) { return this.db.chaveApi.findUnique({ where: { prefixo }, include: incluirChave }); }
  criar(d: Prisma.ChaveApiUncheckedCreateInput) { return this.db.chaveApi.create({ data: d, include: incluirChave }); }
  listar(filtro: { organizacaoId?: string }) {
    return this.db.chaveApi.findMany({ where: filtro, include: incluirChave, orderBy: { criadoEm: 'desc' } });
  }
  async atualizar(id: string, versao: number, data: Prisma.ChaveApiUpdateManyMutationInput) {
    garantirVersao(await this.db.chaveApi.updateMany({ where: { id, versao }, data: { ...data, versao: { increment: 1 } } }), 'Chave de API', versao);
    return this.db.chaveApi.findUniqueOrThrow({ where: { id }, include: incluirChave });
  }
  // fora do controle de versão de propósito: é telemetria, não pode gerar conflito com a edição feita pelo admin
  registrarUso(id: string, quando: Date) { return this.db.chaveApi.updateMany({ where: { id }, data: { ultimoUsoEm: quando } }); }
}

export class TarefaRepositorio {
  constructor(private readonly db: Db) {}
  criar(d: Prisma.TarefaRelatorioUncheckedCreateInput) { return this.db.tarefaRelatorio.create({ data: d, omit: { conteudo: true } }); }
  buscar(id: string) { return this.db.tarefaRelatorio.findUnique({ where: { id }, omit: { conteudo: true } }); }
  buscarComConteudo(id: string) { return this.db.tarefaRelatorio.findUnique({ where: { id } }); }

  // Transição condicionada ao status atual (compare-and-set): dois workers pegando o mesmo job por engano
  // não conseguem processar duas vezes.
  async transicionar(id: string, de: StatusTarefa[], data: Prisma.TarefaRelatorioUpdateManyMutationInput): Promise<boolean> {
    const r = await this.db.tarefaRelatorio.updateMany({ where: { id, status: { in: de } }, data });
    return r.count === 1;
  }

  async listar(p: Pagina, filtro: { chaveApiId?: string; organizacaoId?: string; status?: StatusTarefa }) {
    const [itens, total] = await Promise.all([
      this.db.tarefaRelatorio.findMany({ where: filtro, omit: { conteudo: true }, orderBy: { criadoEm: 'desc' }, ...skipTake(p) }),
      this.db.tarefaRelatorio.count({ where: filtro }),
    ]);
    return { itens, total };
  }

  // libera o espaço do arquivo; a linha fica para histórico/auditoria
  expurgarConteudo(agora: Date) {
    return this.db.tarefaRelatorio.updateMany({ where: { expiraEm: { lt: agora }, conteudo: { not: null } }, data: { conteudo: null } });
  }

  // tarefas esquecidas: PENDENTE há muito tempo (job perdido, ex.: fila em memória num reinício) ou PROCESSANDO
  // além do razoável (worker morreu no meio)
  orfas(pendenteAntesDe: Date, processandoAntesDe: Date) {
    return this.db.tarefaRelatorio.findMany({
      where: { OR: [{ status: 'PENDENTE', criadoEm: { lt: pendenteAntesDe } }, { status: 'PROCESSANDO', iniciadoEm: { lt: processandoAntesDe } }] },
      select: { id: true },
    });
  }
}

export class ExecucaoAgendadaRepositorio {
  constructor(private readonly db: Db) {}
  // true = esta instância ganhou a janela
  async reservar(chave: string, instancia: string): Promise<boolean> {
    const n = await this.db.$executeRaw`INSERT INTO execucoes_agendadas (chave, instancia) VALUES (${chave}, ${instancia}) ON CONFLICT (chave) DO NOTHING`;
    return n === 1;
  }
  concluir(chave: string, erro: string | null) {
    return this.db.execucaoAgendada.update({ where: { chave }, data: { concluidoEm: new Date(), erro: erro?.slice(0, 500) ?? null } });
  }
}

// Conjunto de repositórios amarrados ao mesmo cliente (normal ou transacional).
export class Repositorios {
  readonly usuarios: UsuarioRepositorio;
  readonly parametros: ParametroRepositorio;
  readonly organizacoes: OrganizacaoRepositorio;
  readonly lotes: LoteRepositorio;
  readonly equipamentos: EquipamentoRepositorio;
  readonly movimentacoes: MovimentacaoRepositorio;
  readonly auditoria: AuditoriaRepositorio;
  readonly analitica: AnaliticaRepositorio;
  readonly chaves: ChaveApiRepositorio;
  readonly tarefas: TarefaRepositorio;
  readonly execucoes: ExecucaoAgendadaRepositorio;

  constructor(private readonly db: Db) {
    this.usuarios = new UsuarioRepositorio(db);
    this.parametros = new ParametroRepositorio(db);
    this.organizacoes = new OrganizacaoRepositorio(db);
    this.lotes = new LoteRepositorio(db);
    this.equipamentos = new EquipamentoRepositorio(db);
    this.movimentacoes = new MovimentacaoRepositorio(db);
    this.auditoria = new AuditoriaRepositorio(db);
    this.analitica = new AnaliticaRepositorio(db);
    this.chaves = new ChaveApiRepositorio(db);
    this.tarefas = new TarefaRepositorio(db);
    this.execucoes = new ExecucaoAgendadaRepositorio(db);
  }

  proximaSequencia(seq: NomeSequencia) { return proximaSequencia(this.db, seq); }
}

export class UnidadeDeTrabalho {
  readonly leitura: Repositorios;
  constructor(private readonly prisma: PrismaClient) { this.leitura = new Repositorios(prisma); }

  executar<T>(fn: (r: Repositorios) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new Repositorios(tx)), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 15_000,
    });
  }
}
