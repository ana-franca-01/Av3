import { CategoriaAnalise, OrigemAnalise, Prisma } from '@prisma/client';
import { ErroNaoEncontrado, ErroValidacao } from '../dominio/erros';
import { normalizarEnum } from '../dominio/tipos';
import { Pagina } from '../repositorios/base';
import { UnidadeDeTrabalho } from '../repositorios/repositorios';
import { relatorioAnaliticoDTO } from '../servicos/apresentacao';
import { Ator, Relogio } from '../servicos/comum';
import { ParametroServico } from '../servicos/parametro.servico';
import {
  Analise, AnaliseEficiencia, AnaliseRentabilidade, AnaliseVidaUtil, ContextoAnalise, EquipamentoAnalitico,
  ResultadoAnalise, ResultadoVidaUtil,
} from './analises';

export const CATEGORIAS = Object.values(CategoriaAnalise);

export interface Escopo { organizacaoId: string | null; organizacaoCodigo?: string | null }

export interface OpcoesExecucao {
  persistir: boolean;
  origem: OrigemAnalise;
  ator: Ator;
}

export interface Execucao<R = ResultadoAnalise> {
  id: string | null;
  categoria: CategoriaAnalise;
  organizacao: string | null;
  geradoEm: Date;
  amostras: number;
  duracaoMs: number;
  resultado: R;
}

const num = (d: { toNumber(): number } | null): number | null => (d === null ? null : d.toNumber());

// Orquestra as análises: carrega os dados uma vez, roda a(s) estratégia(s) e, se pedido, grava o resultado
// no histórico (relatorios_analiticos + previsoes_vida_util + previsoes_equipamento) na mesma transação.
export class AnaliticaServico {
  private readonly analises: Record<CategoriaAnalise, Analise<ResultadoAnalise>>;

  constructor(
    private readonly uow: UnidadeDeTrabalho,
    private readonly params: ParametroServico,
    private readonly relogio: Relogio = () => new Date(),
  ) {
    this.analises = {
      EFICIENCIA: new AnaliseEficiencia(),
      RENTABILIDADE: new AnaliseRentabilidade(),
      VIDA_UTIL: new AnaliseVidaUtil(),
    } as Record<CategoriaAnalise, Analise<ResultadoAnalise>>;
  }

  static categoria(bruto: string): CategoriaAnalise {
    return normalizarEnum<CategoriaAnalise>(bruto.replace(/^vida-util$/i, 'VIDA_UTIL'), CATEGORIAS, 'Categoria');
  }

  catalogo() {
    return CATEGORIAS.map((c) => ({ categoria: c, descricao: this.analises[c].descricao }));
  }

  private async carregar(escopo: Escopo): Promise<{ dados: EquipamentoAnalitico[]; ctx: ContextoAnalise }> {
    const r = this.uow.leitura;
    const agora = this.relogio();
    const [brutos, fonte, previsoes, previsoesEquip] = await Promise.all([
      r.analitica.equipamentos(escopo.organizacaoId),
      this.params.fonteDepreciacao(),
      r.analitica.previsoesAnteriores(agora),
      r.analitica.previsoesEquipamentoAnteriores(agora, escopo.organizacaoId),
    ]);
    const dados: EquipamentoAnalitico[] = brutos.map((e) => ({
      id: e.id, codigo: e.codigo, tipo: e.tipo, marca: e.marca, modelo: e.modelo, estado: e.estado, status: e.status,
      valorAquisicao: num(e.valorAquisicao), anoFabricacao: e.anoFabricacao, valorRecuperado: num(e.valorRecuperado),
      triagemResponsavel: e.triagemResponsavel, triagemEm: e.triagemEm, dataEntradaLote: e.lote.dataEntrada,
      movimentos: e.movimentacoes,
    }));
    return {
      dados,
      ctx: {
        agora, fonteDepreciacao: fonte,
        previsoesAnteriores: previsoes.map((p) => ({ tipo: p.tipo, vidaUtilAnos: p.vidaUtilAnos!.toNumber(), geradoEm: p.geradoEm })),
        previsoesEquipamento: previsoesEquip.map((p) => ({ codigo: p.equipamento.codigo, dataPrevista: p.dataPrevistaInservivel, geradoEm: p.geradoEm })),
      },
    };
  }

  async executar(categorias: CategoriaAnalise[], escopo: Escopo, opc: OpcoesExecucao): Promise<Execucao[]> {
    const inicio = Date.now();
    const { dados, ctx } = await this.carregar(escopo);
    const tempoCarga = Date.now() - inicio;
    const saidas: Execucao[] = [];
    for (const categoria of categorias) {
      const t0 = Date.now();
      const analise = this.analises[categoria];
      const resultado = analise.calcular(dados, ctx);
      // a carga é compartilhada; cada relatório registra a própria parte do cálculo mais a carga
      const duracaoMs = Date.now() - t0 + tempoCarga;
      const amostras = analise.amostras(resultado);
      let id: string | null = null;
      if (opc.persistir) id = await this.persistir(categoria, resultado, escopo, opc, ctx.agora, amostras, duracaoMs, dados);
      saidas.push({ id, categoria, organizacao: escopo.organizacaoCodigo ?? null, geradoEm: ctx.agora, amostras, duracaoMs, resultado });
    }
    return saidas;
  }

  async executarUma(categoria: CategoriaAnalise, escopo: Escopo, opc: OpcoesExecucao): Promise<Execucao> {
    return (await this.executar([categoria], escopo, opc))[0];
  }

  private async persistir(
    categoria: CategoriaAnalise, resultado: ResultadoAnalise, escopo: Escopo, opc: OpcoesExecucao,
    geradoEm: Date, amostras: number, duracaoMs: number, dados: EquipamentoAnalitico[],
  ): Promise<string> {
    const vida = categoria === 'VIDA_UTIL' ? (resultado as ResultadoVidaUtil) : null;
    const previsoes = vida
      ? vida.modelos.map((m) => ({
        tipo: m.tipo, metodo: m.metodo, intercepto: m.intercepto, inclinacao: m.inclinacao, r2: m.r2,
        amostras: m.amostras, vidaUtilAnos: m.vidaUtilAnos,
      }))
      : [];
    const idPorCodigo = new Map(dados.map((e) => [e.codigo, e.id]));
    const previsoesEquipamento = (vida?.equipamentosAtivos ?? [])
      .filter((e) => e.vidaRemanescenteAnos !== null && e.dataPrevistaInservivel !== null)
      .map((e) => ({
        equipamentoId: idPorCodigo.get(e.codigo)!, tipo: e.tipo, estado: e.estado, metodo: e.metodo, idadeAnos: e.idadeAnos,
        vidaRemanescenteAnos: e.vidaRemanescenteAnos!, dataPrevistaInservivel: new Date(`${e.dataPrevistaInservivel}T00:00:00Z`),
      }));
    return this.uow.executar(async (r) => {
      const rel = await r.analitica.salvarRelatorio({
        categoria, origem: opc.origem, organizacaoId: escopo.organizacaoId, geradoEm, geradoPor: opc.ator.nome,
        amostras, duracaoMs, resultado: resultado as unknown as Prisma.InputJsonValue,
        parametros: { escopo: escopo.organizacaoCodigo ?? 'GLOBAL' },
      }, previsoes, previsoesEquipamento);
      await r.auditoria.registrar(opc.ator.nome, 'ANALITICA_EXECUTAR',
        `${categoria} (${escopo.organizacaoCodigo ?? 'global'}, ${opc.origem}): ${amostras} amostras, relatório #${rel.id}`);
      return rel.id.toString();
    });
  }

  async historico(p: Pagina, f: { categoria?: string; organizacaoId?: string | null }) {
    const categoria = f.categoria ? AnaliticaServico.categoria(f.categoria) : undefined;
    const { itens, total } = await this.uow.leitura.analitica.listarRelatorios(p, { categoria, organizacaoId: f.organizacaoId });
    return { itens: itens.map(relatorioAnaliticoDTO), total, ...p };
  }

  async obterRelatorio(idTexto: string, organizacaoId?: string) {
    if (!/^\d{1,18}$/.test(idTexto)) throw new ErroValidacao('Identificador de relatório inválido.');
    const rel = await this.uow.leitura.analitica.buscarRelatorio(BigInt(idTexto));
    // parceiro só enxerga o que é da própria organização; 404 em vez de 403 pra não confirmar que o id existe
    if (!rel || (organizacaoId !== undefined && rel.organizacaoId !== organizacaoId)) throw new ErroNaoEncontrado(`Relatório analítico ${idTexto} não encontrado.`);
    return relatorioAnaliticoDTO(rel);
  }
}
