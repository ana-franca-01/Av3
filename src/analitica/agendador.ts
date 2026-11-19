import cron, { ScheduledTask } from 'node-cron';
import { hostname } from 'os';
import { UnidadeDeTrabalho } from '../repositorios/repositorios';
import { Relogio } from '../servicos/comum';
import { TarefaServico } from '../servicos/tarefa.servico';
import { AnaliticaServico, CATEGORIAS } from './analitica.servico';

interface Log { info(o: object, m?: string): void; error(o: object, m?: string): void; warn(o: object, m?: string): void }

const ATOR_SISTEMA = { nome: 'sistema', papel: 'ADMIN' as const };

// Tarefas recorrentes em segundo plano:
//  - análises globais (as três categorias) na expressão ANALITICA_CRON, gravadas no histórico;
//  - de hora em hora, limpeza dos arquivos de relatórios vencidos e reenfileiramento de tarefas órfãs.
// Com várias réplicas do servidor, cada janela é reservada no banco (tabela execucoes_agendadas):
// só a instância que conseguir inserir a chave da janela executa.
export class Agendador {
  private readonly tarefas: ScheduledTask[] = [];
  private readonly instancia = `${hostname()}:${process.pid}`;

  constructor(
    private readonly uow: UnidadeDeTrabalho,
    private readonly analitica: AnaliticaServico,
    private readonly tarefasRelatorio: TarefaServico,
    private readonly log: Log,
    private readonly relogio: Relogio = () => new Date(),
  ) {}

  iniciar(expressao: string, fuso: string): void {
    if (!cron.validate(expressao)) throw new Error(`ANALITICA_CRON inválida: "${expressao}".`);
    this.tarefas.push(
      cron.schedule(expressao, () => this.emJanela('analitica', () => this.rodarAnalises()), { timezone: fuso, name: 'analitica', noOverlap: true }),
      cron.schedule('17 * * * *', () => this.emJanela('manutencao', () => this.manutencao()), { timezone: fuso, name: 'manutencao', noOverlap: true }),
    );
    this.log.info({ expressao, fuso, instancia: this.instancia }, 'agendador de análises iniciado');
  }

  async parar(): Promise<void> {
    for (const t of this.tarefas) await t.stop();
    this.tarefas.length = 0;
  }

  // chave = nome + minuto (UTC). Duas réplicas disparando no mesmo minuto geram a mesma chave.
  private async emJanela(nome: string, fn: () => Promise<string>): Promise<void> {
    const chave = `${nome}:${this.relogio().toISOString().slice(0, 16)}`;
    try {
      if (!(await this.uow.leitura.execucoes.reservar(chave, this.instancia))) {
        this.log.info({ chave }, 'janela já reservada por outra instância');
        return;
      }
    } catch (e) {
      this.log.error({ err: e, chave }, 'não foi possível reservar a janela do agendador');
      return;
    }
    let erro: string | null = null;
    try {
      this.log.info({ chave, resumo: await fn() }, 'tarefa agendada concluída');
    } catch (e) {
      erro = (e as Error).message;
      this.log.error({ err: e, chave }, 'tarefa agendada falhou');
    }
    await this.uow.leitura.execucoes.concluir(chave, erro).catch((e) => this.log.warn({ err: e }, 'falha ao registrar fim da janela'));
  }

  async rodarAnalises(): Promise<string> {
    const r = await this.analitica.executar(CATEGORIAS, { organizacaoId: null }, { persistir: true, origem: 'AGENDADA', ator: ATOR_SISTEMA });
    return r.map((x) => `${x.categoria}#${x.id}`).join(', ');
  }

  async manutencao(): Promise<string> {
    const expurgados = await this.uow.leitura.tarefas.expurgarConteudo(this.relogio());
    const reenfileiradas = await this.tarefasRelatorio.reenfileirarOrfas();
    return `${expurgados.count} arquivo(s) expirado(s) removido(s), ${reenfileiradas} tarefa(s) reenfileirada(s)`;
  }
}
