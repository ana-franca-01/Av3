import { AnaliticaServico } from '../analitica/analitica.servico';
import { ErroNaoEncontrado } from '../dominio/erros';
import { Pagina } from '../repositorios/base';
import { UnidadeDeTrabalho } from '../repositorios/repositorios';
import { equipamentoDTO, movimentacaoDTO } from './apresentacao';
import { Parceiro } from './chave-api.servico';
import { Ator } from './comum';
import { DadosEquipamento, EquipamentoServico } from './equipamento.servico';
import { LoteServico } from './lote.servico';
import { TarefaServico } from './tarefa.servico';

export const atorParceiro = (p: Parceiro): Ator => ({ nome: `api:${p.prefixo}`, papel: 'PARCEIRO' });

// Fachada da API pública. Reaproveita os serviços internos (mesmas regras, mesmas transações), mas toda operação
// é recortada pela organização dona da chave: o parceiro nunca vê nem altera dado de outra organização.
// Recurso de outra organização responde 404 (e não 403) pra não confirmar que o código existe.
export class ParceiroServico {
  constructor(
    private readonly uow: UnidadeDeTrabalho,
    private readonly lotes: LoteServico,
    private readonly equipamentos: EquipamentoServico,
    private readonly analitica: AnaliticaServico,
    private readonly tarefas: TarefaServico,
  ) {}

  listarEquipamentos(p: Parceiro, pag: Pagina, f: { lote?: string; status?: string; tipo?: string }) {
    return this.equipamentos.listar(pag, { ...f, organizacaoId: p.organizacaoId });
  }

  async rastrear(p: Parceiro, codigo: string) {
    const r = this.uow.leitura;
    const e = await r.equipamentos.buscarPorCodigo(codigo.trim().toUpperCase());
    if (!e || e.lote.organizacaoId !== p.organizacaoId) throw new ErroNaoEncontrado(`Equipamento "${codigo}" não encontrado.`);
    const movs = await r.movimentacoes.listarDoEquipamento(e.id);
    return { equipamento: equipamentoDTO(e), movimentacoes: movs.map(movimentacaoDTO) };
  }

  listarLotes(p: Parceiro, pag: Pagina) { return this.lotes.listar(pag, { organizacao: p.organizacaoCodigo }); }

  async obterLote(p: Parceiro, codigo: string) {
    const l = await this.lotes.obter(codigo).catch((e) => { if (e instanceof ErroNaoEncontrado) return null; throw e; });
    if (!l || l.organizacao !== p.organizacaoCodigo) throw new ErroNaoEncontrado(`Lote "${codigo}" não encontrado.`);
    return l;
  }

  criarLote(p: Parceiro, d: { notaFiscal: string; transportadora: string; dataEntrada?: string; equipamentos?: DadosEquipamento[] }) {
    return this.lotes.criar(atorParceiro(p), { ...d, organizacao: p.organizacaoCodigo });
  }

  // cálculo na hora, sem gravar no histórico (pra relatório persistido o parceiro usa a fila)
  async analise(p: Parceiro, categoria: string) {
    const x = await this.analitica.executarUma(AnaliticaServico.categoria(categoria),
      { organizacaoId: p.organizacaoId, organizacaoCodigo: p.organizacaoCodigo },
      { persistir: false, origem: 'PARCEIRO', ator: atorParceiro(p) });
    return { categoria: x.categoria, organizacao: x.organizacao, geradoEm: x.geradoEm, amostras: x.amostras, resultado: x.resultado };
  }

  solicitarRelatorio(p: Parceiro, d: { tipo: string; formato?: string }) {
    return this.tarefas.solicitar({ ator: atorParceiro(p), chaveApiId: p.chaveId, organizacaoId: p.organizacaoId }, d);
  }
  statusRelatorio(p: Parceiro, id: string) { return this.tarefas.obter(id, { chaveApiId: p.chaveId }); }
  listarRelatorios(p: Parceiro, pag: Pagina, status?: string) { return this.tarefas.listar(pag, { chaveApiId: p.chaveId, status }); }
  baixarRelatorio(p: Parceiro, id: string) { return this.tarefas.download(id, { chaveApiId: p.chaveId }); }
}
