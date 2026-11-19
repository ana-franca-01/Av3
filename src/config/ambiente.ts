import { existsSync } from 'fs';
import path from 'path';

// Configuração por variável de ambiente. O .env é opcional (em produção as variáveis vêm do sistema);
// process.loadEnvFile é nativo do Node >= 22, então não precisa de dotenv.

export interface Ambiente {
  producao: boolean;
  porta: number;
  host: string;
  databaseUrl: string;
  jwtSegredo: string;
  jwtExpiraEm: string;
  bcryptCusto: number;
  logLevel: string;
  tempoDesligamentoMs: number;
  // AV3
  redisUrl: string | null;          // sem Redis, a fila roda em memória (dev/testes; não sobrevive a reinício)
  workerEmbutido: boolean;          // false quando o worker roda em processo separado (npm run worker)
  workerConcorrencia: number;
  analiticaCron: string | null;     // vazio desliga o agendador
  analiticaFuso: string;
  relatorioValidadeHoras: number;
  relatorioTentativas: number;
  rateLimitIpPorMinuto: number;
  rateLimitLoginPorMinuto: number;
  // atrás de proxy reverso/balanceador: usa X-Forwarded-For para saber o IP real (senão todo mundo vira o IP do proxy)
  trustProxy: boolean;
}

export function carregarArquivoEnv(arquivo = path.resolve(process.cwd(), '.env')): void {
  if (existsSync(arquivo)) process.loadEnvFile(arquivo);
}

function booleano(nome: string, padrao: boolean): boolean {
  const bruto = (process.env[nome] ?? '').trim().toLowerCase();
  if (bruto === '') return padrao;
  if (['1', 'true', 'sim', 'yes'].includes(bruto)) return true;
  if (['0', 'false', 'nao', 'não', 'no'].includes(bruto)) return false;
  throw new Error(`${nome} inválido: "${bruto}" (esperado true ou false).`);
}

function inteiro(nome: string, padrao: number, min: number, max: number): number {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto === '') return padrao;
  const n = Number(bruto);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${nome} inválido: "${bruto}" (esperado inteiro entre ${min} e ${max}).`);
  return n;
}

export function lerAmbiente(): Ambiente {
  const producao = process.env.NODE_ENV === 'production';
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL não definida (veja .env.example).');
  const jwtSegredo = process.env.JWT_SECRET ?? '';
  // HS256 com segredo curto é quebrável por força bruta offline
  if (jwtSegredo.length < 32) throw new Error('JWT_SECRET precisa ter pelo menos 32 caracteres.');
  if (producao && /troque|desenvolvimento/i.test(jwtSegredo)) throw new Error('JWT_SECRET de desenvolvimento não pode ser usado em produção.');
  return {
    producao,
    porta: inteiro('PORT', 3000, 1, 65535),
    host: process.env.HOST || '0.0.0.0',
    databaseUrl,
    jwtSegredo,
    jwtExpiraEm: process.env.JWT_EXPIRA_EM || '30m',
    bcryptCusto: inteiro('BCRYPT_CUSTO', 12, 4, 15),
    logLevel: process.env.LOG_LEVEL || 'info',
    tempoDesligamentoMs: inteiro('TEMPO_DESLIGAMENTO_MS', 10_000, 1_000, 120_000),
    redisUrl: process.env.REDIS_URL || null,
    workerEmbutido: booleano('WORKER_EMBUTIDO', true),
    workerConcorrencia: inteiro('WORKER_CONCORRENCIA', 2, 1, 32),
    analiticaCron: process.env.ANALITICA_CRON === undefined ? '0 2 * * *' : (process.env.ANALITICA_CRON.trim() || null),
    analiticaFuso: process.env.ANALITICA_FUSO || 'America/Sao_Paulo',
    relatorioValidadeHoras: inteiro('RELATORIO_VALIDADE_HORAS', 72, 1, 24 * 90),
    relatorioTentativas: inteiro('RELATORIO_TENTATIVAS', 3, 1, 10),
    rateLimitIpPorMinuto: inteiro('RATE_LIMIT_IP_POR_MINUTO', 600, 1, 1_000_000),
    rateLimitLoginPorMinuto: inteiro('RATE_LIMIT_LOGIN_POR_MINUTO', 10, 1, 10_000),
    trustProxy: booleano('TRUST_PROXY', false),
  };
}
