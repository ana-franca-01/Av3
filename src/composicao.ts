import { PrismaClient } from '@prisma/client';
import { AnaliticaServico } from './analitica/analitica.servico';
import { Ambiente } from './config/ambiente';
import { FilaRelatorios, criarFila } from './fila/fila';
import { UnidadeDeTrabalho } from './repositorios/repositorios';
import { AutenticacaoServico } from './servicos/autenticacao.servico';
import { ChaveApiServico } from './servicos/chave-api.servico';
import { Relogio } from './servicos/comum';
import { EquipamentoServico } from './servicos/equipamento.servico';
import { LoteServico } from './servicos/lote.servico';
import { OrganizacaoServico } from './servicos/organizacao.servico';
import { ParametroServico } from './servicos/parametro.servico';
import { ParceiroServico } from './servicos/parceiro.servico';
import { RelatorioServico } from './servicos/relatorio.servico';
import { TarefaServico } from './servicos/tarefa.servico';
import { UsuarioServico } from './servicos/usuario.servico';

interface Log { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void }

// Composição manual das dependências (Prisma → repositórios → serviços). Fica separada do app.ts porque o
// worker avulso (src/worker.ts) monta o mesmo grafo sem subir o servidor HTTP.
export function montarServicos(o: { prisma: PrismaClient; ambiente: Ambiente; relogio: Relogio; log: Log; fila?: FilaRelatorios }) {
  const { prisma, ambiente, relogio } = o;
  const uow = new UnidadeDeTrabalho(prisma);
  const fila = o.fila ?? criarFila({
    redisUrl: ambiente.redisUrl,
    politica: { tentativas: ambiente.relatorioTentativas, atrasoBaseMs: 5_000 },
    concorrencia: ambiente.workerConcorrencia,
    log: o.log,
  });
  const auth = new AutenticacaoServico(uow, ambiente.bcryptCusto, relogio);
  const params = new ParametroServico(uow);
  const equipamentos = new EquipamentoServico(uow, params, relogio);
  const lotes = new LoteServico(uow, equipamentos, relogio);
  const analitica = new AnaliticaServico(uow, params, relogio);
  const tarefas = new TarefaServico(uow, analitica, fila, ambiente.relatorioValidadeHoras, relogio);
  return {
    uow, fila, auth, params, equipamentos, lotes, analitica, tarefas,
    usuarios: new UsuarioServico(uow, auth),
    organizacoes: new OrganizacaoServico(uow),
    relatorios: new RelatorioServico(uow, params, relogio),
    chaves: new ChaveApiServico(uow, relogio),
    parceiros: new ParceiroServico(uow, lotes, equipamentos, analitica, tarefas),
  };
}

export type Servicos = ReturnType<typeof montarServicos>;
