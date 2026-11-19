import { EscopoApi } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { ErroAutenticacao, ErroNaoEncontrado, ErroNegocio, ErroValidacao } from '../dominio/erros';
import { normalizarEnum } from '../dominio/tipos';
import { UnidadeDeTrabalho } from '../repositorios/repositorios';
import { chaveApiDTO } from './apresentacao';
import { Ator, Relogio, conferirVersao } from './comum';
import { OrganizacaoServico } from './organizacao.servico';

export const ESCOPOS = Object.values(EscopoApi);
export const LIMITE_PADRAO_POR_MINUTO = 60;

// Parceiro já autenticado, anexado à requisição pública.
export interface Parceiro {
  chaveId: string;
  prefixo: string;
  parceiro: string;
  organizacaoId: string;
  organizacaoCodigo: string;
  escopos: EscopoApi[];
  limitePorMinuto: number;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const prefixoAleatorio = (): string => [...randomBytes(10)].map((b) => BASE32[b & 31]).join('');
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// Formato da chave: gc_<prefixo 10>_<segredo 43, base64url de 32 bytes>
const FORMATO = /^gc_([a-z2-7]{10})_([A-Za-z0-9_-]{43})$/;

// Cache curto das chaves válidas: tira a consulta ao banco do caminho de cada requisição. Revogar/alterar limpa o
// cache desta instância na hora; em outras réplicas a mudança vale em até CACHE_MS.
const CACHE_MS = 30_000;

export class ChaveApiServico {
  private readonly cache = new Map<string, { parceiro: Parceiro; hash: string; expiraEm: Date | null; ate: number }>();
  private readonly ultimoUsoGravado = new Map<string, number>();

  constructor(private readonly uow: UnidadeDeTrabalho, private readonly relogio: Relogio = () => new Date()) {}

  private static escopos(lista: string[]): EscopoApi[] {
    if (!lista.length) throw new ErroValidacao('Informe ao menos um escopo.');
    return [...new Set(lista.map((e) => normalizarEnum<EscopoApi>(e.replace(/:/g, '_'), ESCOPOS, 'Escopo')))];
  }

  private static limite(v: number | undefined): number {
    const n = v ?? LIMITE_PADRAO_POR_MINUTO;
    if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new ErroValidacao('limitePorMinuto deve ser inteiro entre 1 e 10000.');
    return n;
  }

  async criar(ator: Ator, d: { parceiro: string; organizacao: string; escopos: string[]; limitePorMinuto?: number; validadeDias?: number }) {
    const parceiro = d.parceiro.trim();
    if (parceiro.length < 3 || parceiro.length > 80) throw new ErroValidacao('Nome do parceiro deve ter entre 3 e 80 caracteres.');
    const escopos = ChaveApiServico.escopos(d.escopos);
    const limitePorMinuto = ChaveApiServico.limite(d.limitePorMinuto);
    if (d.validadeDias !== undefined && (!Number.isInteger(d.validadeDias) || d.validadeDias < 1 || d.validadeDias > 3650)) {
      throw new ErroValidacao('validadeDias deve ser inteiro entre 1 e 3650.');
    }
    const expiraEm = d.validadeDias ? new Date(this.relogio().getTime() + d.validadeDias * 86_400_000) : null;
    const prefixo = prefixoAleatorio();
    const segredo = randomBytes(32).toString('base64url');

    return this.uow.executar(async (r) => {
      const org = await OrganizacaoServico.buscar(r, d.organizacao);
      if (!org.ativa) throw new ErroNegocio(`Organização ${org.codigo} está inativa.`);
      const c = await r.chaves.criar({
        prefixo, segredoHash: sha256(segredo), parceiro, organizacaoId: org.id, escopos, limitePorMinuto, expiraEm, criadoPor: ator.nome,
      });
      await r.auditoria.registrar(ator.nome, 'CHAVE_CRIAR', `Chave ${prefixo} para "${parceiro}" (${org.codigo}): ${escopos.join(', ')}, ${limitePorMinuto}/min`);
      return {
        ...chaveApiDTO(c),
        chave: `gc_${prefixo}_${segredo}`,
        aviso: 'Guarde esta chave agora: ela não será exibida novamente (o servidor guarda apenas o hash).',
      };
    });
  }

  async listar(f: { organizacao?: string }) {
    const r = this.uow.leitura;
    const organizacaoId = f.organizacao ? (await OrganizacaoServico.buscar(r, f.organizacao)).id : undefined;
    return (await r.chaves.listar({ organizacaoId })).map(chaveApiDTO);
  }

  async alterar(ator: Ator, prefixo: string, d: { ativa?: boolean; escopos?: string[]; limitePorMinuto?: number; versao?: number }) {
    const data: { ativa?: boolean; escopos?: EscopoApi[]; limitePorMinuto?: number } = {};
    if (d.ativa !== undefined) data.ativa = d.ativa;
    if (d.escopos !== undefined) data.escopos = ChaveApiServico.escopos(d.escopos);
    if (d.limitePorMinuto !== undefined) data.limitePorMinuto = ChaveApiServico.limite(d.limitePorMinuto);
    if (!Object.keys(data).length) throw new ErroValidacao('Nada para alterar: informe ativa, escopos e/ou limitePorMinuto.');
    const salvo = await this.uow.executar(async (r) => {
      const c = await r.chaves.buscarPorPrefixo(prefixo);
      if (!c) throw new ErroNaoEncontrado(`Chave ${prefixo} não encontrada.`);
      conferirVersao(d.versao, c.versao, 'Chave de API');
      const s = await r.chaves.atualizar(c.id, c.versao, data);
      await r.auditoria.registrar(ator.nome, d.ativa === false ? 'CHAVE_REVOGAR' : 'CHAVE_ALTERAR', `Chave ${prefixo}: ${JSON.stringify(data)}`);
      return s;
    });
    this.cache.delete(prefixo);
    return chaveApiDTO(salvo);
  }

  revogar(ator: Ator, prefixo: string) { return this.alterar(ator, prefixo, { ativa: false }); }

  // Mesma mensagem para chave ausente, malformada, inexistente, errada, revogada ou expirada:
  // quem testa chaves não descobre qual parte acertou.
  async autenticar(bruta: string | undefined): Promise<Parceiro> {
    const m = bruta ? FORMATO.exec(bruta.trim()) : null;
    if (!m) throw new ErroAutenticacao('Chave de API ausente ou inválida. Envie o cabeçalho X-API-Key.');
    const [, prefixo, segredo] = m;
    const agora = this.relogio();

    let entrada = this.cache.get(prefixo);
    if (!entrada || entrada.ate < agora.getTime()) {
      const c = await this.uow.leitura.chaves.buscarPorPrefixo(prefixo);
      if (!c || !c.ativa || !c.organizacao.ativa) {
        this.cache.delete(prefixo);
        throw new ErroAutenticacao('Chave de API ausente ou inválida. Envie o cabeçalho X-API-Key.');
      }
      entrada = {
        hash: c.segredoHash, expiraEm: c.expiraEm, ate: agora.getTime() + CACHE_MS,
        parceiro: {
          chaveId: c.id, prefixo, parceiro: c.parceiro, organizacaoId: c.organizacaoId, organizacaoCodigo: c.organizacao.codigo,
          escopos: c.escopos, limitePorMinuto: c.limitePorMinuto,
        },
      };
      this.cache.set(prefixo, entrada);
    }
    // comparação em tempo constante: o tempo de resposta não revela quantos caracteres do hash bateram
    const ok = timingSafeEqual(Buffer.from(sha256(segredo), 'hex'), Buffer.from(entrada.hash, 'hex'));
    if (!ok || (entrada.expiraEm && entrada.expiraEm <= agora)) {
      throw new ErroAutenticacao('Chave de API ausente ou inválida. Envie o cabeçalho X-API-Key.');
    }
    this.registrarUso(entrada.parceiro.chaveId, agora);
    return entrada.parceiro;
  }

  // grava "último uso" no máximo uma vez por minuto por chave, fora do caminho da resposta
  private registrarUso(chaveId: string, agora: Date): void {
    const ultimo = this.ultimoUsoGravado.get(chaveId) ?? 0;
    if (agora.getTime() - ultimo < 60_000) return;
    this.ultimoUsoGravado.set(chaveId, agora.getTime());
    this.uow.leitura.chaves.registrarUso(chaveId, agora).catch(() => undefined);
  }
}
