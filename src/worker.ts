#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { montarServicos } from './composicao';
import { carregarArquivoEnv, lerAmbiente } from './config/ambiente';

// Worker avulso: consome a fila de relatórios sem subir o servidor HTTP. Rode quantos quiser, em quantas
// máquinas quiser (todas apontando para o mesmo Redis e PostgreSQL) — é assim que a geração de relatórios
// escala horizontalmente. No servidor, use WORKER_EMBUTIDO=false para ele só publicar.
async function principal(): Promise<void> {
  carregarArquivoEnv();
  const ambiente = lerAmbiente();
  const log = pino({ level: ambiente.logLevel, name: 'greencode-worker' });
  if (!ambiente.redisUrl) throw new Error('O worker avulso precisa de REDIS_URL (a fila em memória só existe dentro do servidor).');

  const prisma = new PrismaClient({ datasourceUrl: ambiente.databaseUrl });
  const s = montarServicos({ prisma, ambiente, relogio: () => new Date(), log });
  s.fila.iniciarWorker((id, tentativa, ultima) => s.tarefas.processar(id, tentativa, ultima));

  let desligando = false;
  const desligar = async (sinal: string) => {
    if (desligando) return;
    desligando = true;
    log.info({ sinal }, 'worker desligando: terminando os jobs em andamento');
    const forcar = setTimeout(() => process.exit(1), ambiente.tempoDesligamentoMs * 3);
    forcar.unref();
    await s.fila.fechar();
    await prisma.$disconnect();
    process.exit(0);
  };
  for (const sinal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sinal, () => void desligar(sinal));
}

principal().catch((e) => {
  console.error(`[CRITICO] worker falhou ao iniciar: ${(e as Error).message}`);
  process.exit(1);
});
