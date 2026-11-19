import { FormatoRelatorio, TarefaRelatorio, TipoRelatorio } from '@prisma/client';
import { AnaliticaServico, CATEGORIAS, Escopo } from '../analitica/analitica.servico';
import { ResultadoVidaUtil } from '../analitica/analises';
import { ErroConflito, ErroExpirado, ErroGreencode, ErroIndisponivel, ErroNaoEncontrado, ErroNegocio, ErroValidacao } from '../dominio/erros';
import { normalizarEnum } from '../dominio/tipos';
import { ErroDefinitivo, FilaRelatorios } from '../fila/fila';
import { Pagina } from '../repositorios/base';
import { UnidadeDeTrabalho } from '../repositorios/repositorios';
import { tarefaDTO } from './apresentacao';
import { Ator, Relogio } from './comum';

export const TIPOS_RELATORIO = Object.values(TipoRelatorio);
export const FORMATOS_RELATORIO = Object.values(FormatoRelatorio);

export interface Solicitante { ator: Ator; chaveApiId: string | null; organizacaoId: string | null }
// filtro de posse: parceiro só enxerga as tarefas da própria chave; usuário interno enxerga todas
export interface Posse { chaveApiId?: string }

// RFC 4180: aspas em volta quando tem separador, aspas ou quebra de linha; aspas internas duplicadas
const celula = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const paraCsv = (cabecalho: string[], linhas: unknown[][]): string =>
  [cabecalho, ...linhas].map((l) => l.map(celula).join(',')).join('\r\n') + '\r\n';

// Ciclo de vida de um relatório assíncrono:
//   POST → PENDENTE (linha criada + job publicado) → PROCESSANDO (worker pegou) → CONCLUIDA | FALHOU
// Falha transitória volta para PENDENTE e o BullMQ tenta de novo com backoff exponencial; na última tentativa,
// ou se o erro for de negócio, a tarefa fica FALHOU com a mensagem do erro.
export class TarefaServico {
  constructor(
    private readonly uow: UnidadeDeTrabalho,
    private readonly analitica: AnaliticaServico,
    private readonly fila: FilaRelatorios,
    private readonly validadeHoras: number,
    private readonly relogio: Relogio = () => new Date(),
    private readonly baseLinks = '/api/v1/public/relatorios',
  ) {}

  private dto = (t: Omit<TarefaRelatorio, 'conteudo'>) => tarefaDTO(t, this.baseLinks);

  async solicitar(s: Solicitante, d: { tipo: string; formato?: string }) {
    const tipo = normalizarEnum<TipoRelatorio>(d.tipo, TIPOS_RELATORIO, 'Tipo de relatório');
    const formato = normalizarEnum<FormatoRelatorio>(d.formato ?? 'JSON', FORMATOS_RELATORIO, 'Formato');
    if (tipo === 'ANALITICO_COMPLETO' && formato === 'CSV') {
      throw new ErroValidacao('ANALITICO_COMPLETO só é gerado em JSON (o conteúdo é aninhado demais para uma tabela CSV).');
    }
    const agora = this.relogio();
    const tarefa = await this.uow.executar(async (r) => {
      const t = await r.tarefas.criar({
        chaveApiId: s.chaveApiId, organizacaoId: s.organizacaoId, solicitante: s.ator.nome, tipo, formato,
        expiraEm: new Date(agora.getTime() + this.validadeHoras * 3_600_000),
      });
      await r.auditoria.registrar(s.ator.nome, 'RELATORIO_SOLICITAR', `Tarefa ${t.id}: ${tipo} em ${formato}`);
      return t;
    });
    try {
      await this.fila.publicar(tarefa.id);
    } catch (e) {
      await this.uow.leitura.tarefas.transicionar(tarefa.id, ['PENDENTE'], { status: 'FALHOU', erro: 'Fila de processamento indisponível.' });
      throw new ErroIndisponivel('Fila de processamento indisponível no momento. Tente novamente em instantes.');
    }
    return this.dto(tarefa);
  }

  private async buscar(id: string, posse: Posse) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ErroNaoEncontrado(`Tarefa ${id} não encontrada.`);
    const t = await this.uow.leitura.tarefas.buscar(id);
    if (!t || (posse.chaveApiId !== undefined && t.chaveApiId !== posse.chaveApiId)) throw new ErroNaoEncontrado(`Tarefa ${id} não encontrada.`);
    return t;
  }

  async obter(id: string, posse: Posse) { return this.dto(await this.buscar(id, posse)); }

  async listar(p: Pagina, posse: Posse & { status?: string }) {
    const { itens, total } = await this.uow.leitura.tarefas.listar(p, {
      chaveApiId: posse.chaveApiId,
      status: posse.status ? normalizarEnum(posse.status, ['PENDENTE', 'PROCESSANDO', 'CONCLUIDA', 'FALHOU'] as const, 'Status') : undefined,
    });
    return { itens: itens.map(this.dto), total, ...p };
  }

  async download(id: string, posse: Posse) {
    const resumo = await this.buscar(id, posse);
    if (resumo.status === 'PENDENTE' || resumo.status === 'PROCESSANDO') {
      throw new ErroConflito(`Relatório ainda em processamento (status ${resumo.status}). Consulte ${this.baseLinks}/${id}.`, { status: resumo.status });
    }
    if (resumo.status === 'FALHOU') throw new ErroNegocio(`A geração do relatório falhou: ${resumo.erro ?? 'erro desconhecido'}.`);
    const t = await this.uow.leitura.tarefas.buscarComConteudo(id);
    if (!t?.conteudo || t.expiraEm < this.relogio()) throw new ErroExpirado(`O arquivo do relatório expirou em ${t?.expiraEm.toISOString()}. Solicite um novo.`);
    const ext = t.formato === 'CSV' ? 'csv' : 'json';
    return {
      conteudo: t.conteudo,
      contentType: t.formato === 'CSV' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      nomeArquivo: `greencode-${t.tipo.toLowerCase()}-${t.id.slice(0, 8)}.${ext}`,
    };
  }

  // Chamado pelo worker. Idempotente: se a tarefa já terminou (job duplicado, retry após sucesso), não faz nada.
  async processar(id: string, tentativa: number, ultima: boolean): Promise<void> {
    const r = this.uow.leitura;
    const pegou = await r.tarefas.transicionar(id, ['PENDENTE', 'PROCESSANDO'], {
      status: 'PROCESSANDO', tentativas: tentativa, iniciadoEm: this.relogio(), erro: null,
    });
    if (!pegou) return;
    const t = await r.tarefas.buscar(id);
    if (!t) throw new ErroDefinitivo(`Tarefa ${id} sumiu.`);
    try {
      const conteudo = await this.gerar(t);
      await r.tarefas.transicionar(id, ['PROCESSANDO'], {
        status: 'CONCLUIDA', conteudo, tamanhoBytes: Buffer.byteLength(conteudo, 'utf8'), concluidoEm: this.relogio(),
      });
    } catch (e) {
      // erro de regra de negócio não se resolve tentando de novo
      const definitivo = e instanceof ErroGreencode || e instanceof ErroDefinitivo;
      const msg = (e as Error).message.slice(0, 500);
      if (definitivo || ultima) {
        await r.tarefas.transicionar(id, ['PROCESSANDO'], { status: 'FALHOU', erro: msg });
        throw definitivo ? new ErroDefinitivo(msg) : e;
      }
      await r.tarefas.transicionar(id, ['PROCESSANDO'], { status: 'PENDENTE', erro: `tentativa ${tentativa}: ${msg}` });
      throw e;
    }
  }

  private async gerar(t: Omit<TarefaRelatorio, 'conteudo'>): Promise<string> {
    const org = t.organizacaoId ? await this.uow.leitura.organizacoes.buscarPorId(t.organizacaoId) : null;
    const escopo: Escopo = { organizacaoId: t.organizacaoId, organizacaoCodigo: org?.codigo ?? null };
    const opc = { persistir: true, origem: t.chaveApiId ? 'PARCEIRO' as const : 'SOB_DEMANDA' as const, ator: { nome: t.solicitante, papel: 'PARCEIRO' as const } };
    const cabecalho = { tarefa: t.id, tipo: t.tipo, organizacao: escopo.organizacaoCodigo ?? 'GLOBAL', geradoEm: this.relogio().toISOString() };

    if (t.tipo === 'ANALITICO_COMPLETO') {
      const execs = await this.analitica.executar(CATEGORIAS, escopo, opc);
      return JSON.stringify({
        ...cabecalho,
        relatorios: Object.fromEntries(execs.map((x) => [x.categoria, { relatorioAnaliticoId: x.id, amostras: x.amostras, resultado: x.resultado }])),
      });
    }

    const vida = await this.analitica.executarUma('VIDA_UTIL', escopo, opc);
    const res = vida.resultado as ResultadoVidaUtil;
    if (t.formato === 'JSON') {
      return JSON.stringify({ ...cabecalho, relatorioAnaliticoId: vida.id, modelos: res.modelos, equipamentos: res.equipamentosAtivos });
    }
    return paraCsv(
      ['codigo', 'tipo', 'marca', 'modelo', 'estado', 'status', 'idade_anos', 'vida_remanescente_anos', 'data_prevista_inservivel', 'metodo'],
      res.equipamentosAtivos.map((e) => [
        e.codigo, e.tipo, e.marca, e.modelo, e.estado, e.status, e.idadeAnos, e.vidaRemanescenteAnos, e.dataPrevistaInservivel, e.metodo,
      ]),
    );
  }

  async reenfileirarOrfas(): Promise<number> {
    const agora = this.relogio().getTime();
    const orfas = await this.uow.leitura.tarefas.orfas(new Date(agora - 15 * 60_000), new Date(agora - 30 * 60_000));
    for (const o of orfas) await this.fila.publicar(o.id);
    return orfas.length;
  }
}
