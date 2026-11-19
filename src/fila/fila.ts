import { Queue, UnrecoverableError, Worker } from 'bullmq';
import IORedis from 'ioredis';

// Fila de geração de relatórios. A requisição HTTP só publica o id da tarefa; quem gera o arquivo é o worker.
// Duas implementações com o mesmo contrato:
//  - FilaBullMQ: Redis + BullMQ. Persistente, distribuída (N workers em N máquinas), com retry e detecção de job travado.
//  - FilaMemoria: setTimeout no próprio processo. Só pra desenvolvimento e testes sem Redis; perde tudo num reinício
//    (o agendador reenfileira as tarefas órfãs, então nada fica perdido para sempre).

export type ProcessadorTarefa = (tarefaId: string, tentativa: number, ultima: boolean) => Promise<void>;

export interface PoliticaRetry {
  tentativas: number;     // total, contando a primeira
  atrasoBaseMs: number;   // espera antes da 2ª tentativa; dobra a cada falha (exponencial)
}

export const POLITICA_PADRAO: PoliticaRetry = { tentativas: 3, atrasoBaseMs: 5_000 };

// Falha que não melhora tentando de novo (regra de negócio, tarefa inexistente…): vai direto para FALHOU.
export class ErroDefinitivo extends Error {}

interface Log { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void }

export interface FilaRelatorios {
  readonly tipo: 'bullmq' | 'memoria';
  publicar(tarefaId: string): Promise<void>;
  iniciarWorker(processar: ProcessadorTarefa): void;
  saude(): Promise<boolean>;
  fechar(): Promise<void>;
}

export const NOME_FILA = 'greencode-relatorios';

export class FilaBullMQ implements FilaRelatorios {
  readonly tipo = 'bullmq' as const;
  private readonly conexao: IORedis;
  private readonly fila: Queue;
  private worker?: Worker;

  constructor(url: string, private readonly politica: PoliticaRetry, private readonly concorrencia: number, private readonly log: Log) {
    // maxRetriesPerRequest: null é exigência do BullMQ para conexões usadas por workers (comandos bloqueantes)
    this.conexao = new IORedis(url, { maxRetriesPerRequest: null });
    this.conexao.on('error', (e) => this.log.warn({ err: e }, 'redis: erro de conexão'));
    this.fila = new Queue(NOME_FILA, {
      connection: this.conexao,
      defaultJobOptions: {
        attempts: politica.tentativas,
        // 5 s, 10 s, 20 s… com até 30% de variação aleatória para que falhas em massa não voltem todas juntas
        backoff: { type: 'exponential', delay: politica.atrasoBaseMs, jitter: 0.3 },
        removeOnComplete: { age: 24 * 3600, count: 5_000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  async publicar(tarefaId: string): Promise<void> {
    // jobId = id da tarefa: publicar duas vezes a mesma tarefa não cria dois jobs (idempotência)
    await this.fila.add('gerar', { tarefaId }, { jobId: tarefaId });
  }

  iniciarWorker(processar: ProcessadorTarefa): void {
    this.worker = new Worker<{ tarefaId: string }>(NOME_FILA, async (job) => {
      const tentativa = job.attemptsMade + 1;
      const ultima = tentativa >= (job.opts.attempts ?? 1);
      try {
        await processar(job.data.tarefaId, tentativa, ultima);
      } catch (e) {
        if (e instanceof ErroDefinitivo) throw new UnrecoverableError(e.message);
        throw e;
      }
    }, {
      connection: this.conexao,
      concurrency: this.concorrencia,
      // job sem renovação do lock por 60 s é considerado travado (worker morreu) e volta pra fila
      lockDuration: 60_000,
      maxStalledCount: 1,
    });
    this.worker.on('failed', (job, e) => this.log.warn({ tarefa: job?.data.tarefaId, tentativa: job?.attemptsMade, err: e }, 'job de relatório falhou'));
    this.worker.on('error', (e) => this.log.error({ err: e }, 'worker BullMQ com erro'));
    this.log.info({ fila: NOME_FILA, concorrencia: this.concorrencia }, 'worker BullMQ iniciado');
  }

  async saude(): Promise<boolean> {
    try { return (await this.conexao.ping()) === 'PONG'; } catch { return false; }
  }

  async fechar(): Promise<void> {
    // close() do worker espera os jobs em andamento terminarem (graceful shutdown)
    await this.worker?.close();
    await this.fila.close();
    await this.conexao.quit().catch(() => undefined);
  }
}

export class FilaMemoria implements FilaRelatorios {
  readonly tipo = 'memoria' as const;
  private processar?: ProcessadorTarefa;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly emAndamento = new Set<Promise<void>>();
  private readonly enfileiradas = new Set<string>();
  private fechada = false;

  constructor(private readonly politica: PoliticaRetry, private readonly concorrencia: number, private readonly log: Log) {}

  async publicar(tarefaId: string): Promise<void> {
    if (this.fechada) throw new Error('fila encerrada');
    if (this.enfileiradas.has(tarefaId)) return; // mesma idempotência do jobId do BullMQ
    this.enfileiradas.add(tarefaId);
    this.agendar(tarefaId, 1, 0);
  }

  iniciarWorker(processar: ProcessadorTarefa): void { this.processar = processar; }

  private agendar(id: string, tentativa: number, atrasoMs: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.fechada) return;
      if (!this.processar || this.emAndamento.size >= this.concorrencia) return this.agendar(id, tentativa, 50);
      const ultima = tentativa >= this.politica.tentativas;
      const p = this.processar(id, tentativa, ultima)
        .then(() => { this.enfileiradas.delete(id); })
        .catch((e) => {
          if (e instanceof ErroDefinitivo || ultima) {
            this.enfileiradas.delete(id);
            this.log.warn({ tarefa: id, tentativa, err: e }, 'tarefa de relatório falhou definitivamente');
          } else {
            this.agendar(id, tentativa + 1, this.politica.atrasoBaseMs * 2 ** (tentativa - 1));
          }
        })
        .finally(() => { this.emAndamento.delete(p); });
      this.emAndamento.add(p);
    }, atrasoMs);
    this.timers.add(t);
  }

  async saude(): Promise<boolean> { return !this.fechada; }

  async fechar(): Promise<void> {
    this.fechada = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await Promise.allSettled([...this.emAndamento]);
  }
}

export function criarFila(o: { redisUrl: string | null; politica: PoliticaRetry; concorrencia: number; log: Log }): FilaRelatorios {
  return o.redisUrl
    ? new FilaBullMQ(o.redisUrl, o.politica, o.concorrencia, o.log)
    : new FilaMemoria(o.politica, o.concorrencia, o.log);
}
