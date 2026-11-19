import { Papel } from '@prisma/client';
import { ErroConcorrencia } from '../dominio/erros';

// Quem executa a operação. Na API pública o ator é a chave do parceiro ("api:<prefixo>"), com papel PARCEIRO;
// o resto da regra de negócio (auditoria, criadoPor) não precisa saber a diferença.
export interface Ator { nome: string; papel: Papel | 'PARCEIRO' }
export interface AtorUsuario extends Ator { papel: Papel }

export type Relogio = () => Date;

export function conferirVersao(informada: number | undefined, atual: number, entidade: string): void {
  if (informada !== undefined && informada !== atual) {
    throw new ErroConcorrencia(`${entidade} está na versão ${atual}, mas a requisição foi feita sobre a versão ${informada}.`, {
      versaoAtual: atual, versaoInformada: informada,
    });
  }
}
