import {
  Auditoria, ChaveApi, Contrato, Equipamento, Lote, Movimentacao, Organizacao, Parametro, RelatorioAnalitico, TarefaRelatorio, Usuario,
} from '@prisma/client';
import { dateISO } from '../dominio/datas';
import { ValidadorCNPJ } from '../dominio/validadores';


const num = (d: { toNumber(): number } | null): number | null => (d === null ? null : d.toNumber());

export const usuarioDTO = (u: Usuario) => ({
  nome: u.nome, papel: u.papel, ativo: u.ativo, criadoEm: u.criadoEm, atualizadoEm: u.atualizadoEm, versao: u.versao,
});

export const parametroDTO = (p: Pick<Parametro, 'chave' | 'atualizadoPor' | 'versao'> & { valor: { toNumber(): number } | number; atualizadoEm: Date | null }) => ({
  chave: p.chave, valor: typeof p.valor === 'number' ? p.valor : p.valor.toNumber(),
  atualizadoEm: p.atualizadoEm, atualizadoPor: p.atualizadoPor, versao: p.versao,
});

export const contratoDTO = (c: Contrato) => ({
  numero: c.numero, inicio: dateISO(c.inicio), fim: dateISO(c.fim), prazoArmazenamentoDias: c.prazoArmazenamentoDias,
  descricao: c.descricao, clausulas: c.clausulas, criadoEm: c.criadoEm, atualizadoEm: c.atualizadoEm, versao: c.versao,
});

export const organizacaoDTO = (o: Organizacao & { contrato: Contrato | null; _count?: { lotes: number } }) => ({
  codigo: o.codigo, cnpj: o.cnpj, cnpjFormatado: ValidadorCNPJ.formatar(o.cnpj), nome: o.nome, tipo: o.tipo, ativa: o.ativa,
  contrato: o.contrato ? contratoDTO(o.contrato) : null, totalLotes: o._count?.lotes,
  criadoEm: o.criadoEm, criadoPor: o.criadoPor, versao: o.versao,
});

export const equipamentoDTO = (e: Equipamento & { lote: { codigo: string } }) => ({
  codigo: e.codigo, codigoBarrasInterno: e.codigoBarrasInterno, lote: e.lote.codigo, tipo: e.tipo,
  descricao: e.descricao, serie: e.serie, marca: e.marca, modelo: e.modelo, estado: e.estado, status: e.status,
  valorAquisicao: num(e.valorAquisicao), anoFabricacao: e.anoFabricacao, valorRecuperado: num(e.valorRecuperado),
  triagem: e.triagemClasse
    ? { classe: e.triagemClasse, responsavel: e.triagemResponsavel, em: e.triagemEm, observacao: e.triagemObservacao }
    : null,
  criadoEm: e.criadoEm, criadoPor: e.criadoPor, atualizadoEm: e.atualizadoEm, versao: e.versao,
});

export const loteDTO = (l: Lote & { organizacao: { codigo: string }; _count?: { equipamentos: number } }) => ({
  codigo: l.codigo, organizacao: l.organizacao.codigo, notaFiscal: l.notaFiscal, transportadora: l.transportadora,
  dataEntrada: dateISO(l.dataEntrada), totalEquipamentos: l._count?.equipamentos,
  criadoEm: l.criadoEm, criadoPor: l.criadoPor, versao: l.versao,
});

export const movimentacaoDTO = (m: Movimentacao) => ({
  id: m.id.toString(), ts: m.ts, ator: m.ator, tipo: m.tipo, statusDe: m.statusDe, statusPara: m.statusPara,
  estadoDe: m.estadoDe, estadoPara: m.estadoPara, justificativa: m.justificativa, observacao: m.observacao,
});

export const auditoriaDTO = (a: Auditoria) => ({ id: a.id.toString(), ts: a.ts, ator: a.ator, operacao: a.operacao, resumo: a.resumo });

// ---------------------------------------------------------------- AV3

// o hash do segredo nunca sai da API; o segredo em claro só aparece uma vez, na criação
export const chaveApiDTO = (c: ChaveApi & { organizacao: { codigo: string } }) => ({
  prefixo: c.prefixo, parceiro: c.parceiro, organizacao: c.organizacao.codigo, escopos: c.escopos,
  limitePorMinuto: c.limitePorMinuto, ativa: c.ativa, expiraEm: c.expiraEm, ultimoUsoEm: c.ultimoUsoEm,
  criadoEm: c.criadoEm, criadoPor: c.criadoPor, versao: c.versao,
});

export const relatorioAnaliticoDTO = (r: Omit<RelatorioAnalitico, 'resultado'> & { resultado?: unknown; organizacao: { codigo: string } | null }) => ({
  id: r.id.toString(), categoria: r.categoria, origem: r.origem, organizacao: r.organizacao?.codigo ?? null,
  geradoEm: r.geradoEm, geradoPor: r.geradoPor, amostras: r.amostras, duracaoMs: r.duracaoMs, parametros: r.parametros,
  ...(r.resultado !== undefined ? { resultado: r.resultado } : {}),
});

export const tarefaDTO = (t: Omit<TarefaRelatorio, 'conteudo'>, base: string) => ({
  id: t.id, tipo: t.tipo, formato: t.formato, status: t.status, tentativas: t.tentativas, erro: t.erro,
  tamanhoBytes: t.tamanhoBytes, criadoEm: t.criadoEm, iniciadoEm: t.iniciadoEm, concluidoEm: t.concluidoEm, expiraEm: t.expiraEm,
  links: {
    status: `${base}/${t.id}`,
    ...(t.status === 'CONCLUIDA' ? { download: `${base}/${t.id}/download` } : {}),
  },
});
