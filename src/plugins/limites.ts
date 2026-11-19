import fastifyRateLimit from '@fastify/rate-limit';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ErroLimiteTaxa } from '../dominio/erros';

// Rate limit em três camadas, todas sobre o mesmo armazenamento (memória do processo, ou Redis com REDIS_URL,
// quando o limite passa a valer para o conjunto de réplicas):
//
//   camada  | chave do contador | onde                           | protege contra
//   --------|-------------------|--------------------------------|---------------------------------------------
//   ip      | ip:<endereço>     | toda requisição (onRequest)     | inundação, inclusive com chaves inválidas
//   login   | login:<endereço>  | POST /api/v1/internal/auth/login| força bruta de senha distribuída entre contas
//   chave   | chave:<prefixo>   | API pública (preHandler)        | parceiro passando da cota do contrato
//
// A camada "ip" roda antes de qualquer autenticação, então requisição sem chave ou com chave inventada também
// conta. A de chave roda depois que a chave foi validada e usa o limite cadastrado nela.

export interface ConfigLimites {
  ipPorMinuto: number;
  loginPorMinuto: number;
  redis?: unknown;
}

type Max = number | ((req: FastifyRequest) => number);

export type FabricaLimite = (camada: string, opts: { max: Max; chave: (req: FastifyRequest) => string; ignorar?: (req: FastifyRequest) => boolean }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module 'fastify' {
  interface FastifyInstance { limite: FabricaLimite }
}

export async function registrarLimites(app: FastifyInstance, cfg: ConfigLimites): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: false,
    redis: cfg.redis,
    nameSpace: 'greencode-rl:',
    // Redis fora do ar não derruba a API: melhor atender sem limite do que recusar todo mundo
    skipOnError: true,
  });

  // createRateLimit só conta (não responde nem marca a requisição), o que permite empilhar camadas
  const fabrica: FabricaLimite = (camada, o) => {
    const contar = app.createRateLimit({
      timeWindow: 60_000,
      max: o.max as never,
      keyGenerator: (req: FastifyRequest) => `${camada}:${o.chave(req)}`,
      allowList: o.ignorar ? (req: FastifyRequest) => o.ignorar!(req) : undefined,
    });
    return async function limite(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      const r = await contar(req);
      if (r.isAllowed) return;
      reply.header('x-ratelimit-limit', r.max).header('x-ratelimit-remaining', r.remaining).header('x-ratelimit-reset', r.ttlInSeconds);
      if (r.isExceeded) {
        reply.header('retry-after', r.ttlInSeconds);
        throw new ErroLimiteTaxa(
          `Limite de ${r.max} requisições por minuto excedido (${camada}). Tente novamente em ${r.ttlInSeconds} s.`,
          { camada, limite: r.max, tenteEmSegundos: r.ttlInSeconds },
        );
      }
    };
  };
  app.decorate('limite', fabrica);

  app.addHook('onRequest', fabrica('ip', {
    max: cfg.ipPorMinuto,
    chave: (req) => req.ip,
    // sondas de monitoramento não devem disputar cota com usuários
    ignorar: (req) => req.url === '/health',
  }));
}
