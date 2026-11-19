import { CategoriaAnalise } from '@prisma/client';
import { dateISO } from '../dominio/datas';
import { FATOR_RECUPERACAO, FabricaEquipamento, FonteDepreciacao } from '../dominio/equipamentos';
import { EstadoFisico, PESO_ESTADO, StatusEquipamento, TipoEquipamento, statusFinal } from '../dominio/tipos';
import { ANO_MS, DIA_MS, Descritiva, agrupar, arred, cruzamento, descrever, regressaoLinear, suavizacaoHolt } from './estatistica';

// Strategy: cada categoria de insight é uma Analise com o mesmo contrato (dados carregados → resultado serializável).
// As análises são puras — não tocam no banco — então o mesmo código roda na rota síncrona, no cron e no worker,
// e é testado sem PostgreSQL.

export interface MovimentoAnalitico { ts: Date; statusPara: StatusEquipamento; estadoPara: EstadoFisico }

export interface EquipamentoAnalitico {
  id: string;
  codigo: string;
  tipo: TipoEquipamento;
  marca: string | null;
  modelo: string | null;
  estado: EstadoFisico;
  status: StatusEquipamento;
  valorAquisicao: number | null;
  anoFabricacao: number | null;
  valorRecuperado: number | null;
  triagemResponsavel: string | null;
  triagemEm: Date | null;
  dataEntradaLote: Date;
  movimentos: MovimentoAnalitico[]; // em ordem de inserção
}

export interface PrevisaoAnterior { tipo: TipoEquipamento; vidaUtilAnos: number; geradoEm: Date }
// previsão gravada para um equipamento específico (tabela previsoes_equipamento)
export interface PrevisaoEquipamentoAnterior { codigo: string; dataPrevista: Date; geradoEm: Date }

export interface ContextoAnalise {
  agora: Date;
  fonteDepreciacao: FonteDepreciacao;
  previsoesAnteriores: PrevisaoAnterior[];
  previsoesEquipamento?: PrevisaoEquipamentoAnterior[];
}

export abstract class Analise<R extends object> {
  abstract readonly categoria: CategoriaAnalise;
  abstract readonly descricao: string;
  abstract calcular(equipamentos: EquipamentoAnalitico[], ctx: ContextoAnalise): R;
  // quantas observações sustentam o resultado (vai pra coluna "amostras" do histórico)
  abstract amostras(resultado: R): number;
}

const dias = (ms: number): number => ms / DIA_MS;
const mesISO = (d: Date): string => dateISO(d).slice(0, 7);
// sem a data exata de fabricação, assume o meio do ano (erro máximo de 6 meses, simétrico)
const idadeEm = (anoFabricacao: number, quando: Date): number =>
  Math.max(0, (quando.getTime() - Date.UTC(anoFabricacao, 6, 1)) / ANO_MS);

// ---------------------------------------------------------------- 1. eficiência operacional

export interface ResultadoEficiencia {
  unidade: 'dias';
  entradaAteTriagem: Descritiva;
  porOperador: Array<{ operador: string } & Descritiva>;
  porMes: Array<{ mes: string } & Descritiva>;
  etapas: Array<{ status: StatusEquipamento } & Descritiva>;
  gargalo: { status: StatusEquipamento; mediaDias: number } | null;
  variacaoEntreOperadores: number | null;
  parados: { limiteDias: number; total: number; itens: Array<{ codigo: string; status: StatusEquipamento; dias: number }> };
}

export class AnaliseEficiencia extends Analise<ResultadoEficiencia> {
  readonly categoria = 'EFICIENCIA' as const;
  readonly descricao = 'Tempo de processamento dos lotes (entrada → triagem), por operador, por mês e por etapa';

  constructor(private readonly limiteParadoDias = 7) { super(); }

  calcular(equipamentos: EquipamentoAnalitico[], ctx: ContextoAnalise): ResultadoEficiencia {
    const triados = equipamentos.filter((e) => e.triagemEm !== null);
    const duracao = (e: EquipamentoAnalitico) => Math.max(0, dias(e.triagemEm!.getTime() - e.dataEntradaLote.getTime()));

    const porOperador = [...agrupar(triados, (e) => e.triagemResponsavel)]
      .map(([operador, g]) => ({ operador, ...descrever(g.map(duracao)) }))
      .sort((a, b) => (a.media ?? 0) - (b.media ?? 0));
    const porMes = [...agrupar(triados, (e) => mesISO(e.dataEntradaLote))]
      .map(([mes, g]) => ({ mes, ...descrever(g.map(duracao)) }))
      .sort((a, b) => a.mes.localeCompare(b.mes));

    // permanência em cada status: do movimento que entrou nele até o próximo. Só intervalos fechados entram na média;
    // o intervalo aberto (status atual) alimenta a lista de parados.
    const permanencias = new Map<StatusEquipamento, number[]>();
    const parados: ResultadoEficiencia['parados']['itens'] = [];
    for (const e of equipamentos) {
      const m = e.movimentos;
      for (let i = 0; i < m.length; i++) {
        // movimento que só mudou o estado físico não troca de etapa
        if (i > 0 && m[i].statusPara === m[i - 1].statusPara) continue;
        let j = i + 1;
        while (j < m.length && m[j].statusPara === m[i].statusPara) j++;
        if (j < m.length) {
          const lista = permanencias.get(m[i].statusPara) ?? [];
          lista.push(dias(m[j].ts.getTime() - m[i].ts.getTime()));
          permanencias.set(m[i].statusPara, lista);
        } else if (!statusFinal(m[i].statusPara)) {
          const d = dias(ctx.agora.getTime() - m[i].ts.getTime());
          if (d >= this.limiteParadoDias) parados.push({ codigo: e.codigo, status: m[i].statusPara, dias: arred(d, 1) });
        }
      }
    }
    const etapas = [...permanencias].map(([status, v]) => ({ status, ...descrever(v) }));
    const piorEtapa = etapas.reduce<(typeof etapas)[number] | null>((p, e) => (p === null || (e.media ?? 0) > (p.media ?? 0) ? e : p), null);
    const mediasOperadores = porOperador.map((o) => o.media ?? 0);

    return {
      unidade: 'dias',
      entradaAteTriagem: descrever(triados.map(duracao)),
      porOperador,
      porMes,
      etapas,
      gargalo: piorEtapa && piorEtapa.media !== null ? { status: piorEtapa.status, mediaDias: piorEtapa.media } : null,
      variacaoEntreOperadores: mediasOperadores.length > 1 ? descrever(mediasOperadores, 4).coeficienteVariacao : null,
      parados: { limiteDias: this.limiteParadoDias, total: parados.length, itens: parados.sort((a, b) => b.dias - a.dias).slice(0, 50) },
    };
  }

  amostras(r: ResultadoEficiencia): number { return r.entradaAteTriagem.n; }
}

// ---------------------------------------------------------------- 2. rentabilidade por tipo de equipamento

interface GrupoRentabilidade {
  n: number;
  valorMedioEstimado: number | null;
  valorMedianoEstimado: number | null;
  valorTotalEstimado: number;
  retornoMedioPct: number | null; // estimado / aquisição
  valorMedioRealizado: number | null;
  realizados: number;
}

export interface ResultadoRentabilidade {
  premissas: { anoReferencia: number; fatorRecuperacaoPorEstado: Record<EstadoFisico, number> };
  geral: GrupoRentabilidade;
  porTipo: Array<{ tipo: TipoEquipamento; rotaPredominante: 'REUSO' | 'MATERIAIS' } & GrupoRentabilidade>;
  porTipoEstado: Array<{ tipo: TipoEquipamento; estado: EstadoFisico } & GrupoRentabilidade>;
  porMarcaModelo: Array<{ tipo: TipoEquipamento; marca: string; modelo: string | null } & GrupoRentabilidade>;
  prioridade: Array<{ codigo: string; tipo: TipoEquipamento; marca: string | null; modelo: string | null; estado: EstadoFisico; status: StatusEquipamento; valorEstimado: number; rota: 'REUSO' | 'MATERIAIS' }>;
  acuraciaEstimativa: { comparacoes: number; erroMedioAbsoluto: number | null; erroMedioPct: number | null };
}

interface Avaliado { e: EquipamentoAnalitico; estimado: number; rota: 'REUSO' | 'MATERIAIS' }

export class AnaliseRentabilidade extends Analise<ResultadoRentabilidade> {
  readonly categoria = 'RENTABILIDADE' as const;
  readonly descricao = 'Valor médio de recuperação por tipo, estado físico, marca e modelo';

  private static grupo(itens: Avaliado[]): GrupoRentabilidade {
    const est = descrever(itens.map((i) => i.estimado));
    const comAquisicao = itens.filter((i) => i.e.valorAquisicao);
    const realizados = itens.filter((i) => i.e.valorRecuperado !== null).map((i) => i.e.valorRecuperado!);
    return {
      n: itens.length,
      valorMedioEstimado: est.media,
      valorMedianoEstimado: est.mediana,
      valorTotalEstimado: arred(itens.reduce((s, i) => s + i.estimado, 0)),
      retornoMedioPct: comAquisicao.length
        ? arred((comAquisicao.reduce((s, i) => s + i.estimado / i.e.valorAquisicao!, 0) / comAquisicao.length) * 100)
        : null,
      valorMedioRealizado: descrever(realizados).media,
      realizados: realizados.length,
    };
  }

  calcular(equipamentos: EquipamentoAnalitico[], ctx: ContextoAnalise): ResultadoRentabilidade {
    const ano = ctx.agora.getFullYear();
    const avaliados: Avaliado[] = equipamentos.map((e) => {
      const r = FabricaEquipamento.criar(e.tipo, { valorAquisicao: e.valorAquisicao, anoFabricacao: e.anoFabricacao })
        .estimarRecuperacao(ctx.fonteDepreciacao, ano, e.estado);
      return { e, estimado: r.valorEstimado, rota: r.rota };
    });
    const porValor = <T extends { valorMedioEstimado: number | null }>(a: T, b: T) => (b.valorMedioEstimado ?? 0) - (a.valorMedioEstimado ?? 0);

    const porTipo = [...agrupar(avaliados, (a) => a.e.tipo)].map(([tipo, g]) => ({
      tipo,
      rotaPredominante: g.filter((a) => a.rota === 'REUSO').length * 2 > g.length ? 'REUSO' as const : 'MATERIAIS' as const,
      ...AnaliseRentabilidade.grupo(g),
    })).sort(porValor);
    const porTipoEstado = [...agrupar(avaliados, (a) => `${a.e.tipo}|${a.e.estado}`)].map(([k, g]) => {
      const [tipo, estado] = k.split('|') as [TipoEquipamento, EstadoFisico];
      return { tipo, estado, ...AnaliseRentabilidade.grupo(g) };
    }).sort((a, b) => a.tipo.localeCompare(b.tipo) || PESO_ESTADO[b.estado] - PESO_ESTADO[a.estado]);
    const porMarcaModelo = [...agrupar(avaliados, (a) => (a.e.marca ? `${a.e.tipo}|${a.e.marca}|${a.e.modelo ?? ''}` : null))].map(([k, g]) => {
      const [tipo, marca, modelo] = k.split('|');
      return { tipo: tipo as TipoEquipamento, marca, modelo: modelo || null, ...AnaliseRentabilidade.grupo(g) };
    }).sort(porValor).slice(0, 50);

    const prioridade = avaliados
      .filter((a) => !statusFinal(a.e.status))
      .sort((a, b) => b.estimado - a.estimado)
      .slice(0, 20)
      .map((a) => ({
        codigo: a.e.codigo, tipo: a.e.tipo, marca: a.e.marca, modelo: a.e.modelo, estado: a.e.estado, status: a.e.status,
        valorEstimado: a.estimado, rota: a.rota,
      }));

    // previsão × realização: quanto a estimativa errou nos equipamentos que já tiveram valor de venda informado
    const comparados = avaliados.filter((a) => a.e.valorRecuperado !== null);
    const erros = comparados.map((a) => Math.abs(a.estimado - a.e.valorRecuperado!));
    const errosPct = comparados.filter((a) => a.e.valorRecuperado! > 0).map((a) => Math.abs(a.estimado - a.e.valorRecuperado!) / a.e.valorRecuperado!);

    return {
      premissas: { anoReferencia: ano, fatorRecuperacaoPorEstado: FATOR_RECUPERACAO },
      geral: AnaliseRentabilidade.grupo(avaliados),
      porTipo, porTipoEstado, porMarcaModelo, prioridade,
      acuraciaEstimativa: {
        comparacoes: comparados.length,
        erroMedioAbsoluto: descrever(erros).media,
        erroMedioPct: errosPct.length ? arred((errosPct.reduce((s, v) => s + v, 0) / errosPct.length) * 100) : null,
      },
    };
  }

  amostras(r: ResultadoRentabilidade): number { return r.geral.n; }
}

// ---------------------------------------------------------------- 3. vida útil remanescente

export type MetodoVidaUtil = 'MQO' | 'HOLT' | 'FALHAS' | 'DEPRECIACAO';

// Histórico de falhas do tipo. "Falha" = equipamento observado em RUIM ou SUCATA (sem condição de reuso).
export interface HistoricoFalhas {
  // fração dos equipamentos de cada faixa de idade que estavam em falha na última observação (curva empírica)
  curva: Array<{ faixa: string; observados: number; emFalha: number; emFalhaPct: number }>;
  equipamentosInserviveis: number;
  // idade média em que os equipamentos do tipo chegaram a SUCATA (tempo médio até a falha observado)
  idadeMediaAteInservivelAnos: number | null;
}

export interface ModeloVidaUtil {
  tipo: TipoEquipamento;
  metodo: MetodoVidaUtil;
  intercepto: number | null;
  inclinacao: number | null; // pontos de estado perdidos por ano (negativo = degrada)
  r2: number | null;
  amostras: number;
  vidaUtilAnos: number | null; // idade em que o tipo chega a SUCATA
  // vida útil pela depreciação contábil (100 / % ao ano): referência financeira para comparar com a técnica
  vidaUtilContabilAnos: number | null;
  falhas: HistoricoFalhas;
  observacao: string;
}

export interface ResultadoVidaUtil {
  alvo: string;
  criterios: { minAmostrasMQO: number; minR2MQO: number; alfaHolt: number; betaHolt: number };
  modelos: ModeloVidaUtil[];
  equipamentosAtivos: Array<{
    codigo: string; tipo: TipoEquipamento; marca: string | null; modelo: string | null; estado: EstadoFisico; status: StatusEquipamento;
    idadeAnos: number | null; vidaRemanescenteAnos: number | null; dataPrevistaInservivel: string | null; metodo: MetodoVidaUtil;
  }>;
  validacao: { comparacoes: number; erroMedioAbsolutoAnos: number | null; porTipo: Array<{ tipo: TipoEquipamento; comparacoes: number; erroMedioAnos: number | null }> };
  // previsão × realização no nível do equipamento: data prevista gravada antes × data em que ele virou SUCATA
  validacaoPorEquipamento: {
    comparacoes: number; erroMedioAbsolutoAnos: number | null; viesAnos: number | null; dentroDeUmAnoPct: number | null;
    itens: Array<{ codigo: string; previstoEm: string; dataPrevista: string; dataReal: string; erroAnos: number }>;
  };
}

const FAIXAS_IDADE: Array<[string, number, number]> = [['0-2', 0, 3], ['3-5', 3, 6], ['6-8', 6, 9], ['9-11', 9, 12], ['12+', 12, Infinity]];

const VIDA_MIN = 0.5, VIDA_MAX = 40;
const limitarVida = (v: number): number => arred(Math.min(VIDA_MAX, Math.max(VIDA_MIN, v)));

export class AnaliseVidaUtil extends Analise<ResultadoVidaUtil> {
  readonly categoria = 'VIDA_UTIL' as const;
  readonly descricao = 'Projeção de quando cada tipo de equipamento atinge o estado inservível (SUCATA)';

  constructor(
    private readonly minAmostrasMQO = 5,
    private readonly minR2MQO = 0.3,
    private readonly alfa = 0.5,
    private readonly beta = 0.3,
  ) { super(); }

  // Uma observação (idade, peso do estado) cada vez que o equipamento ENTRA num estado físico. Movimentos que só
  // trocam status repetem o estado e não acrescentam informação sobre desgaste.
  static observacoes(e: EquipamentoAnalitico): Array<[number, number]> {
    if (e.anoFabricacao === null) return [];
    const obs: Array<[number, number]> = [];
    let anterior: EstadoFisico | null = null;
    for (const m of e.movimentos) {
      if (m.estadoPara === anterior) continue;
      anterior = m.estadoPara;
      obs.push([idadeEm(e.anoFabricacao, m.ts), PESO_ESTADO[m.estadoPara]]);
    }
    return obs;
  }

  static historicoFalhas(equipamentos: EquipamentoAnalitico[]): HistoricoFalhas {
    const ultimas: Array<{ idade: number; peso: number }> = [];
    const idadesInservivel: number[] = [];
    for (const e of equipamentos) {
      if (e.anoFabricacao === null || e.movimentos.length === 0) continue;
      const ultimo = e.movimentos[e.movimentos.length - 1];
      ultimas.push({ idade: idadeEm(e.anoFabricacao, ultimo.ts), peso: PESO_ESTADO[ultimo.estadoPara] });
      const sucata = e.movimentos.find((m) => m.estadoPara === 'SUCATA');
      if (sucata) idadesInservivel.push(idadeEm(e.anoFabricacao, sucata.ts));
    }
    const curva = FAIXAS_IDADE.map(([faixa, de, ate]) => {
      const g = ultimas.filter((u) => u.idade >= de && u.idade < ate);
      const emFalha = g.filter((u) => u.peso <= PESO_ESTADO.RUIM).length;
      return { faixa, observados: g.length, emFalha, emFalhaPct: g.length ? arred((emFalha / g.length) * 100, 1) : 0 };
    }).filter((f) => f.observados > 0);
    return { curva, equipamentosInserviveis: idadesInservivel.length, idadeMediaAteInservivelAnos: descrever(idadesInservivel).media };
  }

  modelar(tipo: TipoEquipamento, pontos: Array<[number, number]>, fonte: FonteDepreciacao, falhas?: HistoricoFalhas): ModeloVidaUtil {
    const pct = FabricaEquipamento.criar(tipo, { valorAquisicao: null, anoFabricacao: null }).coeficienteDepreciacao(fonte);
    const extra = {
      vidaUtilContabilAnos: pct > 0 ? limitarVida(100 / pct) : null,
      falhas: falhas ?? { curva: [], equipamentosInserviveis: 0, idadeMediaAteInservivelAnos: null },
    };
    const reg = regressaoLinear(pontos);
    if (reg && reg.n >= this.minAmostrasMQO && reg.r2 >= this.minR2MQO) {
      const vida = cruzamento(reg, 0);
      if (vida !== null) {
        return {
          tipo, metodo: 'MQO', intercepto: arred(reg.intercepto, 6), inclinacao: arred(reg.inclinacao, 6), r2: arred(reg.r2, 6),
          amostras: reg.n, vidaUtilAnos: limitarVida(vida), ...extra,
          observacao: `Regressão linear estado × idade (R² ${arred(reg.r2, 3)}).`,
        };
      }
    }
    // série do estado médio por ano de idade, em ordem
    const porIdade = [...agrupar(pontos, ([x]) => String(Math.floor(x)))]
      .map(([k, g]) => [Number(k), g.reduce((s, [, y]) => s + y, 0) / g.length] as const)
      .sort((a, b) => a[0] - b[0]);
    const holt = suavizacaoHolt(porIdade.map(([, y]) => y), this.alfa, this.beta);
    if (holt && holt.tendencia < 0) {
      const idadeFinal = porIdade[porIdade.length - 1][0] + 0.5;
      const anosAteZero = holt.nivel / -holt.tendencia;
      return {
        tipo, metodo: 'HOLT', intercepto: arred(holt.nivel, 6), inclinacao: arred(holt.tendencia, 6), r2: null,
        amostras: pontos.length, vidaUtilAnos: limitarVida(idadeFinal + anosAteZero), ...extra,
        observacao: reg
          ? `MQO descartado (n=${reg.n}, R² ${arred(reg.r2, 3)}); suavização de Holt sobre ${porIdade.length} faixas de idade.`
          : `Suavização de Holt sobre ${porIdade.length} faixas de idade.`,
      };
    }
    // sem tendência no estado físico: se já houve equipamentos inservíveis, a idade média deles é a melhor
    // estimativa empírica; senão, a vida útil contábil
    const mttf = extra.falhas.idadeMediaAteInservivelAnos;
    if (mttf !== null && extra.falhas.equipamentosInserviveis >= 3) {
      return {
        tipo, metodo: 'FALHAS', intercepto: null, inclinacao: null, r2: null, amostras: extra.falhas.equipamentosInserviveis,
        vidaUtilAnos: limitarVida(mttf), ...extra,
        observacao: `Sem tendência de desgaste utilizável; idade média em que ${extra.falhas.equipamentosInserviveis} equipamentos chegaram a SUCATA.`,
      };
    }
    return {
      tipo, metodo: 'DEPRECIACAO', intercepto: null, inclinacao: null, r2: null, amostras: pontos.length,
      vidaUtilAnos: extra.vidaUtilContabilAnos, ...extra,
      observacao: `Histórico insuficiente (${pontos.length} observações); vida útil contábil = 100 / ${pct}% ao ano.`,
    };
  }

  calcular(equipamentos: EquipamentoAnalitico[], ctx: ContextoAnalise): ResultadoVidaUtil {
    const porTipo = agrupar(equipamentos, (e) => e.tipo);
    const modelos = new Map<TipoEquipamento, ModeloVidaUtil>();
    for (const [tipo, g] of porTipo) {
      modelos.set(tipo, this.modelar(tipo, g.flatMap(AnaliseVidaUtil.observacoes), ctx.fonteDepreciacao, AnaliseVidaUtil.historicoFalhas(g)));
    }

    const ativos = equipamentos.filter((e) => !statusFinal(e.status)).map((e) => {
      const m = modelos.get(e.tipo)!;
      const idade = e.anoFabricacao === null ? null : idadeEm(e.anoFabricacao, ctx.agora);
      let restante: number | null = null;
      const peso = PESO_ESTADO[e.estado];
      if (peso === 0) restante = 0;
      else if ((m.metodo === 'MQO' || m.metodo === 'HOLT') && m.inclinacao !== null && m.inclinacao < 0) {
        // projeta a partir do estado ATUAL do equipamento com a taxa de desgaste do tipo:
        // um EXCELENTE de 8 anos dura mais que um REGULAR de 3
        restante = peso / -m.inclinacao;
      } else if (m.vidaUtilAnos !== null && idade !== null) {
        restante = Math.max(0, m.vidaUtilAnos - idade);
      }
      return {
        codigo: e.codigo, tipo: e.tipo, marca: e.marca, modelo: e.modelo, estado: e.estado, status: e.status,
        idadeAnos: idade === null ? null : arred(idade),
        vidaRemanescenteAnos: restante === null ? null : arred(restante),
        dataPrevistaInservivel: restante === null ? null : dateISO(new Date(ctx.agora.getTime() + restante * ANO_MS)),
        metodo: m.metodo,
      };
    }).sort((a, b) => (a.vidaRemanescenteAnos ?? Infinity) - (b.vidaRemanescenteAnos ?? Infinity));

    return {
      alvo: 'SUCATA (peso 0 na escala EXCELENTE=4 … SUCATA=0)',
      criterios: { minAmostrasMQO: this.minAmostrasMQO, minR2MQO: this.minR2MQO, alfaHolt: this.alfa, betaHolt: this.beta },
      modelos: [...modelos.values()].sort((a, b) => a.tipo.localeCompare(b.tipo)),
      equipamentosAtivos: ativos,
      validacao: AnaliseVidaUtil.validar(equipamentos, ctx.previsoesAnteriores),
      validacaoPorEquipamento: AnaliseVidaUtil.validarEquipamentos(equipamentos, ctx.previsoesEquipamento ?? []),
    };
  }

  // Para cada equipamento que virou SUCATA: pega a previsão mais recente feita para ELE antes disso e mede o erro
  // em anos (positivo = durou mais que o previsto). "viés" é o erro médio com sinal: mostra se o modelo é otimista
  // ou pessimista; o absoluto mostra o tamanho do erro.
  static validarEquipamentos(equipamentos: EquipamentoAnalitico[], previsoes: PrevisaoEquipamentoAnterior[]): ResultadoVidaUtil['validacaoPorEquipamento'] {
    const porCodigo = agrupar(previsoes, (p) => p.codigo);
    const itens: ResultadoVidaUtil['validacaoPorEquipamento']['itens'] = [];
    for (const e of equipamentos) {
      const fim = e.movimentos.find((m) => m.estadoPara === 'SUCATA');
      const ps = fim && porCodigo.get(e.codigo);
      if (!fim || !ps) continue;
      const p = ps.filter((x) => x.geradoEm < fim.ts).reduce<PrevisaoEquipamentoAnterior | null>((a, x) => (a === null || x.geradoEm > a.geradoEm ? x : a), null);
      if (!p) continue;
      itens.push({
        codigo: e.codigo, previstoEm: dateISO(p.geradoEm), dataPrevista: dateISO(p.dataPrevista), dataReal: dateISO(fim.ts),
        erroAnos: arred((fim.ts.getTime() - p.dataPrevista.getTime()) / ANO_MS),
      });
    }
    const erros = itens.map((i) => i.erroAnos);
    return {
      comparacoes: itens.length,
      erroMedioAbsolutoAnos: erros.length ? arred(erros.reduce((s, x) => s + Math.abs(x), 0) / erros.length) : null,
      viesAnos: erros.length ? arred(erros.reduce((s, x) => s + x, 0) / erros.length) : null,
      dentroDeUmAnoPct: erros.length ? arred((erros.filter((x) => Math.abs(x) <= 1).length / erros.length) * 100, 1) : null,
      itens: itens.slice(0, 100),
    };
  }

  // Compara cada previsão antiga com os equipamentos que viraram SUCATA DEPOIS dela: idade real × vida prevista.
  static validar(equipamentos: EquipamentoAnalitico[], previsoes: PrevisaoAnterior[]): ResultadoVidaUtil['validacao'] {
    const erros: Array<{ tipo: TipoEquipamento; erro: number }> = [];
    for (const e of equipamentos) {
      if (e.anoFabricacao === null) continue;
      const fim = e.movimentos.find((m) => m.estadoPara === 'SUCATA');
      if (!fim) continue;
      // a previsão mais recente desse tipo feita antes do equipamento chegar a SUCATA
      const p = previsoes
        .filter((x) => x.tipo === e.tipo && x.geradoEm < fim.ts)
        .reduce<PrevisaoAnterior | null>((a, x) => (a === null || x.geradoEm > a.geradoEm ? x : a), null);
      if (p) erros.push({ tipo: e.tipo, erro: idadeEm(e.anoFabricacao, fim.ts) - p.vidaUtilAnos });
    }
    const mae = (v: number[]) => (v.length ? arred(v.reduce((s, x) => s + Math.abs(x), 0) / v.length) : null);
    return {
      comparacoes: erros.length,
      erroMedioAbsolutoAnos: mae(erros.map((x) => x.erro)),
      porTipo: [...agrupar(erros, (x) => x.tipo)].map(([tipo, g]) => ({ tipo, comparacoes: g.length, erroMedioAnos: mae(g.map((x) => x.erro)) })),
    };
  }

  amostras(r: ResultadoVidaUtil): number { return r.modelos.reduce((s, m) => s + m.amostras, 0); }
}

export type ResultadoAnalise = ResultadoEficiencia | ResultadoRentabilidade | ResultadoVidaUtil;
