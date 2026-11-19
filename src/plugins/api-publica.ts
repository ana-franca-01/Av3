import { EscopoApi } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { ErroPermissao } from '../dominio/erros';
import { Repositorios } from '../repositorios/repositorios';
import { ChaveApiServico, Parceiro } from '../servicos/chave-api.servico';

declare module 'fastify' {
  interface FastifyRequest { parceiro?: Parceiro }
  interface FastifyContextConfig { escopo?: EscopoApi }
}

export const PREFIXO_PUBLICO = '/api/v1/public';
// versão do contrato com parceiros (semver). Mudança incompatível = novo prefixo /api/v2/public, com o v1
// mantido em paralelo e marcado com os cabeçalhos Deprecation/Sunset até a data de desligamento.
export const VERSAO_API_PUBLICA = '1.0.0';

export interface OpcoesApiPublica {
  chaves: ChaveApiServico;
  repos: Repositorios;
  depreciadaEm?: string;        // preenchido quando a v1 entrar em depreciação
  rotas: (app: FastifyInstance) => void;
}

// Contexto encapsulado do Fastify: os hooks daqui (chave de API, escopo, rate limit) valem só para /api/v1/public,
// e o JWT dos usuários internos não vale aqui. Segregação de preocupações no nível do roteamento.
export async function registrarApiPublica(app: FastifyInstance, o: OpcoesApiPublica): Promise<void> {
  await app.register(async (pub) => {
    // o hook global de JWT pula rotas marcadas como "publica"; aqui a autenticação é a chave do parceiro
    pub.addHook('onRoute', (r) => { r.config = { ...(r.config ?? {}), publica: true }; });

    pub.addHook('onRequest', async (req, reply) => {
      reply.header('x-api-version', VERSAO_API_PUBLICA);
      if (o.depreciadaEm) reply.header('deprecation', 'true').header('sunset', o.depreciadaEm);
      const bruta = req.headers['x-api-key'];
      req.parceiro = await o.chaves.autenticar(typeof bruta === 'string' ? bruta : undefined);
      const exigido = req.routeOptions.config.escopo;
      if (exigido && !req.parceiro.escopos.includes(exigido)) {
        o.repos.auditoria.registrar(`api:${req.parceiro.prefixo}`, 'ACESSO_NEGADO', `${req.method} ${req.routeOptions.url} exige escopo ${exigido}`)
          .catch((e) => req.log.warn({ err: e }, 'falha ao auditar acesso negado'));
        throw new ErroPermissao(`A chave ${req.parceiro.prefixo} não tem o escopo "${exigido}".`);
      }
    });

    // Cota por chave (não por IP): cada parceiro tem a cota do seu contrato, mesmo atrás de NAT/proxy.
    // Roda em preHandler porque precisa da chave já validada pelo onRequest acima. O limite por IP (plugin
    // limites.ts) continua valendo antes disso, inclusive para requisições sem chave.
    pub.addHook('preHandler', app.limite('chave', {
      max: (req) => req.parceiro!.limitePorMinuto,
      chave: (req) => req.parceiro!.prefixo,
    }));

    o.rotas(pub);
  }, { prefix: PREFIXO_PUBLICO });
}
