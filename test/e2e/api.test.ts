import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { construirApp } from '../../src/app';
import { carregarArquivoEnv, lerAmbiente } from '../../src/config/ambiente';
import { formatarISO, hojeCivil } from '../../src/dominio/datas';


carregarArquivoEnv();
process.env.DATABASE_URL = process.env.DATABASE_URL_TESTE;
process.env.BCRYPT_CUSTO = '4';
// fila em memória e sem agendador, a não ser que se peça para testar com Redis (TESTE_COM_REDIS=1)
if (process.env.TESTE_COM_REDIS !== '1') process.env.REDIS_URL = '';
process.env.ANALITICA_CRON = '';
// a jornada faz dezenas de logins do mesmo IP; os limites por IP/login são testados num app à parte
process.env.RATE_LIMIT_LOGIN_POR_MINUTO = '1000';
process.env.RATE_LIMIT_IP_POR_MINUTO = '100000';

const I = '/api/v1/internal';
const A = '/api/v1/admin';
const SENHA_ADMIN = 'Admin@Teste2026';
const SENHA = 'Usuario@Teste2026';
const CNPJ_A = '11222333000181';
const CNPJ_B = '12ABC34501DE35';
const hoje = formatarISO(hojeCivil(new Date()));
const daquiA = (dias: number) => { const d = new Date(); d.setDate(d.getDate() + dias); return formatarISO(hojeCivil(d)); };

let app: FastifyInstance;
let prisma: PrismaClient;
const tokens: Record<string, string> = {};

type Opcoes = { token?: string; chave?: string; body?: unknown };
async function chamar(metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, o: Opcoes = {}) {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.chave) headers['x-api-key'] = o.chave;
  const r = await app.inject({ method: metodo, url, headers, ...(o.body !== undefined ? { payload: o.body as object } : {}) });
  const json = String(r.headers['content-type'] ?? '').includes('json');
  return { status: r.statusCode, corpo: r.body && json ? r.json() : null, texto: r.body, headers: r.headers };
}
const login = async (usuario: string, senha: string) => chamar('POST', `${I}/auth/login`, { body: { usuario, senha } });

before(async () => {
  prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  await prisma.usuario.create({ data: { nome: 'admin', papel: 'ADMIN', senhaHash: await bcrypt.hash(SENHA_ADMIN, 4) } });
  app = await construirApp({ ambiente: lerAmbiente(), prisma, logger: false });
  await app.ready();
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

describe('autenticação e autorização', () => {
  it('health é público e confirma o banco', async () => {
    const r = await chamar('GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.corpo.banco, 'ok');
  });

  it('login devolve JWT; rotas protegidas exigem o token', async () => {
    const r = await login('admin', SENHA_ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.corpo.papel, 'ADMIN');
    tokens.admin = r.corpo.token;
    assert.equal((await chamar('GET', `${I}/organizacoes`)).status, 401);
    assert.equal((await chamar('GET', `${I}/organizacoes`, { token: 'x.y.z' })).status, 401);
    assert.equal((await chamar('GET', `${I}/auth/me`, { token: tokens.admin })).corpo.nome, 'admin');
  });

  it('admin cria um usuário de cada papel; senha fraca é recusada', async () => {
    assert.equal((await chamar('POST', `${A}/usuarios`, { token: tokens.admin, body: { nome: 'fraco', papel: 'AUDITOR', senha: 'abcdefghij' } })).status, 400);
    for (const [nome, papel] of [['cad', 'CADASTRO'], ['almox', 'ALMOXARIFADO'], ['auditor', 'AUDITOR']]) {
      const r = await chamar('POST', `${A}/usuarios`, { token: tokens.admin, body: { nome, papel, senha: SENHA } });
      assert.equal(r.status, 201, JSON.stringify(r.corpo));
      assert.equal(r.corpo.senhaHash, undefined); // hash nunca sai da API
      tokens[nome] = (await login(nome, SENHA)).corpo.token;
    }
    assert.equal((await chamar('POST', `${A}/usuarios`, { token: tokens.admin, body: { nome: 'cad', papel: 'CADASTRO', senha: SENHA } })).status, 409);
  });

  it('papel sem permissão recebe 403 e a tentativa é auditada', async () => {
    const r = await chamar('POST', `${I}/organizacoes`, { token: tokens.auditor, body: { cnpj: CNPJ_A, nome: 'Qualquer', tipo: 'VAREJO' } });
    assert.equal(r.status, 403);
    assert.equal((await chamar('GET', `${A}/usuarios`, { token: tokens.almox })).status, 403);
    await new Promise((res) => setTimeout(res, 50)); // a auditoria do 403 é assíncrona
    const aud = await chamar('GET', `${I}/relatorios/auditoria?operacao=ACESSO_NEGADO`, { token: tokens.auditor });
    assert.ok(aud.corpo.total >= 2);
  });

  it('5 senhas erradas bloqueiam a conta com mensagem genérica', async () => {
    await chamar('POST', `${A}/usuarios`, { token: tokens.admin, body: { nome: 'vitima', papel: 'AUDITOR', senha: SENHA } });
    for (let i = 0; i < 5; i++) {
      const r = await login('vitima', 'Errada@123456');
      assert.equal(r.status, 401);
      assert.equal(r.corpo.mensagem, 'Usuário ou senha inválidos.');
    }
    assert.equal((await login('vitima', SENHA)).status, 429); 
    assert.equal((await login('naoexiste', SENHA)).status, 401);
    
    assert.equal((await chamar('PUT', `${A}/usuarios/vitima/senha`, { token: tokens.admin, body: { senha: 'Nova@Senha2026' } })).status, 200);
    assert.equal((await login('vitima', 'Nova@Senha2026')).status, 200);
  });

  it('não dá pra desativar o último admin nem a própria conta', async () => {
    const r = await chamar('PATCH', `${A}/usuarios/admin/ativo`, { token: tokens.admin, body: { ativo: false } });
    assert.equal(r.status, 422);
  });
});

describe('cadastro, lotes e regras de negócio', () => {
  it('organização: CNPJ validado e único (inclusive alfanumérico)', async () => {
    assert.equal((await chamar('POST', `${I}/organizacoes`, { token: tokens.cad, body: { cnpj: '11222333000182', nome: 'DV Errado', tipo: 'VAREJO' } })).status, 400);
    const a = await chamar('POST', `${I}/organizacoes`, { token: tokens.cad, body: { cnpj: '11.222.333/0001-81', nome: 'Magazine Verde', tipo: 'VAREJO' } });
    assert.equal(a.status, 201);
    assert.equal(a.corpo.codigo, 'BR001');
    assert.equal((await chamar('POST', `${I}/organizacoes`, { token: tokens.cad, body: { cnpj: CNPJ_A, nome: 'Duplicada', tipo: 'VAREJO' } })).status, 409);
    const b = await chamar('POST', `${I}/organizacoes`, { token: tokens.cad, body: { cnpj: CNPJ_B, nome: 'Universidade Alfa', tipo: 'UNIVERSIDADE' } });
    assert.equal(b.status, 201);
  });

  it('lote exige contrato vigente', async () => {
    const r = await chamar('POST', `${I}/lotes`, { token: tokens.almox, body: { organizacao: 'BR001', notaFiscal: '123', transportadora: 'TransRápida' } });
    assert.equal(r.status, 422);
    assert.match(r.corpo.mensagem, /contrato/);
  });

  it('contrato 1—0..1: PUT cria e depois substitui com versão', async () => {
    const corpo = { inicio: daquiA(-30), fim: daquiA(365), prazoArmazenamentoDias: 180, clausulas: [{ titulo: 'Coleta', texto: 'Mensal' }] };
    const c1 = await chamar('PUT', `${I}/organizacoes/BR001/contrato`, { token: tokens.cad, body: corpo });
    assert.equal(c1.status, 200);
    assert.equal(c1.corpo.versao, 1);
    assert.deepEqual(c1.corpo.clausulas, [{ titulo: 'Coleta', texto: 'Mensal' }]);
    const c2 = await chamar('PUT', `${I}/organizacoes/BR001/contrato`, { token: tokens.cad, body: { ...corpo, prazoArmazenamentoDias: 90, versao: 1 } });
    assert.equal(c2.corpo.versao, 2);
    assert.equal(c2.corpo.numero, c1.corpo.numero);
    assert.equal((await chamar('PUT', `${I}/organizacoes/BR001/contrato`, { token: tokens.cad, body: { ...corpo, versao: 1 } })).status, 409);
    assert.equal((await chamar('PUT', `${I}/organizacoes/BR001/contrato`, { token: tokens.cad, body: { ...corpo, fim: daquiA(-60) } })).status, 400);
  });

  it('lote com data futura ou anterior a 90 dias é recusado', async () => {
    const base = { organizacao: 'BR001', transportadora: 'TransRápida' };
    assert.equal((await chamar('POST', `${I}/lotes`, { token: tokens.almox, body: { ...base, notaFiscal: '1', dataEntrada: daquiA(1) } })).status, 400);
    assert.equal((await chamar('POST', `${I}/lotes`, { token: tokens.almox, body: { ...base, notaFiscal: '1', dataEntrada: daquiA(-91) } })).status, 400);
  });

  it('lote + equipamentos numa transação só: um item inválido desfaz tudo', async () => {
    const r = await chamar('POST', `${I}/lotes`, {
      token: tokens.almox,
      body: {
        organizacao: 'BR001', notaFiscal: '777', transportadora: 'TransRápida',
        equipamentos: [
          { tipo: 'COMPUTADOR', descricao: 'Desktop A', serie: 'DUP-001' },
          { tipo: 'MONITOR', descricao: 'Monitor B', serie: 'DUP-001' },
        ],
      },
    });
    assert.equal(r.status, 409);
    assert.match(r.corpo.mensagem, /Equipamento #2/);
    assert.equal(await prisma.lote.count({ where: { notaFiscal: '777' } }), 0);
    assert.equal(await prisma.equipamento.count({ where: { serie: 'DUP-001' } }), 0);
  });

  it('lote válido com equipamentos; NF única por organização', async () => {
    const r = await chamar('POST', `${I}/lotes`, {
      token: tokens.almox,
      body: {
        organizacao: 'br001', notaFiscal: '100234', transportadora: 'TransRápida', dataEntrada: hoje,
        equipamentos: [
          { tipo: 'COMPUTADOR', descricao: 'Desktop Dell', serie: 'dl-001', estado: 'BOM', valorAquisicao: 4000, anoFabricacao: 2022 },
          { tipo: 'SERVIDOR', descricao: 'Servidor HP', serie: 'hp-001', estado: 'EXCELENTE' },
        ],
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    assert.equal(r.corpo.totalEquipamentos, 2);
    assert.match(r.corpo.equipamentos[0].codigoBarrasInterno, /^GC\d{9}$/);
    assert.equal(r.corpo.equipamentos[0].serie, 'DL-001');
    const dup = await chamar('POST', `${I}/lotes`, { token: tokens.almox, body: { organizacao: 'BR001', notaFiscal: '100234', transportadora: 'Outra' } });
    assert.equal(dup.status, 409);
  });
});

describe('ciclo de vida do equipamento', () => {
  let eq: string;
  let srv: string;

  before(async () => {
    const lista = await chamar('GET', `${I}/equipamentos?status=RECEBIDO`, { token: tokens.auditor });
    eq = lista.corpo.itens.find((e: { tipo: string }) => e.tipo === 'COMPUTADOR').codigo;
    srv = lista.corpo.itens.find((e: { tipo: string }) => e.tipo === 'SERVIDOR').codigo;
  });

  it('não pula etapas: RECEBIDO não vai direto pra desmonte', async () => {
    const r = await chamar('POST', `${I}/equipamentos/${eq}/status`, { token: tokens.almox, body: { status: 'EM_DESMONTE' } });
    assert.equal(r.status, 400);
  });

  it('triagem só em EM_TRIAGEM e queda de 2+ categorias exige justificativa', async () => {
    assert.equal((await chamar('POST', `${I}/equipamentos/${eq}/triagem`, { token: tokens.almox, body: { estado: 'BOM', classe: 'RECICLAVEL' } })).status, 422);
    assert.equal((await chamar('POST', `${I}/equipamentos/${eq}/status`, { token: tokens.almox, body: { status: 'EM_TRIAGEM' } })).status, 200);
    const sem = await chamar('POST', `${I}/equipamentos/${eq}/triagem`, { token: tokens.almox, body: { estado: 'SUCATA', classe: 'RECICLAVEL' } });
    assert.equal(sem.status, 400);
    const com = await chamar('POST', `${I}/equipamentos/${eq}/triagem`, {
      token: tokens.almox, body: { estado: 'RUIM', classe: 'RECICLAVEL', justificativa: 'Gabinete amassado e placa oxidada' },
    });
    assert.equal(com.status, 200);
    assert.equal(com.corpo.status, 'TRIADO');
    assert.equal(com.corpo.triagem.responsavel, 'almox');
  });

  it('desmonte e destino final; status final não muda mais', async () => {
    assert.equal((await chamar('POST', `${I}/equipamentos/${eq}/status`, { token: tokens.almox, body: { status: 'EM_DESMONTE' } })).status, 200);
    assert.equal((await chamar('POST', `${I}/equipamentos/${eq}/status`, { token: tokens.almox, body: { status: 'RECICLADO' } })).status, 200);
    assert.equal((await chamar('POST', `${I}/equipamentos/${eq}/estado`, { token: tokens.almox, body: { estado: 'SUCATA' } })).status, 422);
  });

  it('rastreabilidade registra cada passo, em ordem', async () => {
    const r = await chamar('GET', `${I}/equipamentos/${eq}/movimentacoes`, { token: tokens.auditor });
    assert.deepEqual(r.corpo.map((m: { statusPara: string }) => m.statusPara), ['RECEBIDO', 'EM_TRIAGEM', 'TRIADO', 'EM_DESMONTE', 'RECICLADO']);
    assert.equal(r.corpo[2].justificativa, 'Gabinete amassado e placa oxidada');
  });

  it('detalhe calcula depreciação pelo parâmetro global (polimorfismo)', async () => {
    assert.equal((await chamar('PUT', `${A}/parametros/depreciacao.COMPUTADOR`, { token: tokens.almox, body: { valor: 25 } })).status, 403);
    assert.equal((await chamar('PUT', `${A}/parametros/depreciacao.COMPUTADOR`, { token: tokens.admin, body: { valor: 25 } })).status, 200);
    const r = await chamar('GET', `${I}/equipamentos/${eq}`, { token: tokens.auditor });
    assert.equal(r.corpo.avaliacao.depreciacaoAnualPct, 25);
    const idade = new Date().getFullYear() - 2022;
    assert.equal(r.corpo.avaliacao.valorResidual, Math.max(0, 4000 * (1 - 0.25 * idade)));
    assert.ok(r.corpo.materiaisRecuperaveis.length > 0);
    const b = await chamar('GET', `${I}/equipamentos/barras/${r.corpo.codigoBarrasInterno}`, { token: tokens.auditor });
    assert.equal(b.corpo.codigo, eq);
  });

  it('versionamento otimista: versão velha recebe 409', async () => {
    const atual = (await chamar('GET', `${I}/equipamentos/${srv}`, { token: tokens.almox })).corpo;
    const ok = await chamar('POST', `${I}/equipamentos/${srv}/estado`, { token: tokens.almox, body: { estado: 'BOM', versao: atual.versao } });
    assert.equal(ok.status, 200);
    assert.equal(ok.corpo.versao, atual.versao + 1);
    const velha = await chamar('POST', `${I}/equipamentos/${srv}/estado`, { token: tokens.almox, body: { estado: 'REGULAR', versao: atual.versao } });
    assert.equal(velha.status, 409);
    assert.equal(velha.corpo.erro, 'GC-VERSAO');
  });

  it('concorrência: duas requisições simultâneas sobre a mesma versão — só uma grava', async () => {
    const atual = (await chamar('GET', `${I}/equipamentos/${srv}`, { token: tokens.almox })).corpo;
    const corpo = { status: 'EM_TRIAGEM', versao: atual.versao };
    const rs = await Promise.all([1, 2, 3].map(() => chamar('POST', `${I}/equipamentos/${srv}/status`, { token: tokens.almox, body: corpo })));
    const status = rs.map((r) => r.status).sort();
    assert.deepEqual(status.filter((s) => s === 200).length, 1, JSON.stringify(rs));
    assert.ok(status.filter((s) => s !== 200).every((s) => s === 409 || s === 400));
    const movs = (await chamar('GET', `${I}/equipamentos/${srv}/movimentacoes`, { token: tokens.auditor })).corpo;
    assert.equal(movs.filter((m: { statusPara: string }) => m.statusPara === 'EM_TRIAGEM').length, 1); // nada duplicado
  });
});

describe('barreiras no banco (constraints e triggers)', () => {
  it('movimentações são imutáveis mesmo por SQL direto', async () => {
    await assert.rejects(prisma.$executeRaw`UPDATE movimentacoes SET ator = 'hacker'`, /GC-IMUTAVEL/);
    await assert.rejects(prisma.$executeRaw`DELETE FROM auditoria`, /GC-IMUTAVEL/);
  });

  it('trigger impede pular etapa da máquina de estados fora da API', async () => {
    const e = await prisma.equipamento.findFirstOrThrow({ where: { status: 'RECEBIDO' } }).catch(() => null);
    const alvo = e ?? (await prisma.equipamento.findFirstOrThrow({ where: { status: 'EM_TRIAGEM' } }));
    await assert.rejects(prisma.equipamento.update({ where: { id: alvo.id }, data: { status: 'RECICLADO' } }));
  });

  it('CHECK impede passar da triagem sem dados de triagem', async () => {
    const e = await prisma.equipamento.findFirstOrThrow({ where: { status: 'EM_TRIAGEM' } });
    await assert.rejects(prisma.equipamento.update({ where: { id: e.id }, data: { status: 'TRIADO' } }), /ck_equipamentos_triagem|check/i);
  });

  it('relatório resumo agrega por status e valor', async () => {
    const r = await chamar('GET', `${I}/relatorios/resumo`, { token: tokens.auditor });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.totalEquipamentos, 2);
    assert.equal(r.corpo.porStatus.RECICLADO, 1);
  });

  it('erros de validação de esquema viram 400 padronizado', async () => {
    const r = await chamar('POST', `${I}/organizacoes`, { token: tokens.cad, body: { cnpj: CNPJ_A, nome: 'X Corp', tipo: 'NAVE_ESPACIAL' } });
    assert.equal(r.status, 400);
    assert.equal(r.corpo.erro, 'GC-VAL');
    assert.equal((await chamar('GET', `${I}/rota-que-nao-existe`, { token: tokens.admin })).status, 404);
  });
});

// ---------------------------------------------------------------- AV3

const P = '/api/v1/public';
const chaves: Record<string, string> = {};

async function esperarTarefa(chave: string, id: string, limiteMs = 10_000) {
  const fim = Date.now() + limiteMs;
  for (;;) {
    const r = await chamar('GET', `${P}/relatorios/${id}`, { chave });
    if (r.corpo.status === 'CONCLUIDA' || r.corpo.status === 'FALHOU' || Date.now() > fim) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
}

describe('AV3: camada analítica', () => {
  it('catálogo e permissões: CADASTRO não lê analítica', async () => {
    const r = await chamar('GET', `${I}/analitica`, { token: tokens.auditor });
    assert.equal(r.status, 200);
    assert.deepEqual(r.corpo.map((c: { categoria: string }) => c.categoria).sort(), ['EFICIENCIA', 'RENTABILIDADE', 'VIDA_UTIL']);
    assert.equal((await chamar('GET', `${I}/analitica/eficiencia`, { token: tokens.cad })).status, 403);
  });

  it('eficiência: tempo entrada → triagem, por operador e por etapa', async () => {
    const r = await chamar('GET', `${I}/analitica/eficiencia`, { token: tokens.auditor });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.ok(r.corpo.resultado.entradaAteTriagem.n >= 1);
    assert.ok(r.corpo.resultado.porOperador.some((o: { operador: string }) => o.operador === 'almox'));
    assert.ok(r.corpo.resultado.etapas.length >= 1);
    assert.equal(r.corpo.id, null); // GET calcula na hora, não grava
  });

  it('rentabilidade por organização e vida útil com previsão por equipamento ativo', async () => {
    const rent = await chamar('GET', `${I}/analitica/rentabilidade?organizacao=BR001`, { token: tokens.auditor });
    assert.equal(rent.status, 200);
    assert.equal(rent.corpo.organizacao, 'BR001');
    assert.ok(rent.corpo.resultado.porTipo.some((t: { tipo: string }) => t.tipo === 'COMPUTADOR'));
    const vida = await chamar('GET', `${I}/analitica/vida-util`, { token: tokens.auditor });
    assert.equal(vida.status, 200);
    assert.ok(vida.corpo.resultado.modelos.length >= 1);
    assert.ok(vida.corpo.resultado.equipamentosAtivos.every((e: { status: string }) => !['RECICLADO', 'REUTILIZADO', 'DESCARTADO'].includes(e.status)));
  });

  it('execução sob demanda grava histórico (relatório + previsões) e só admin executa', async () => {
    assert.equal((await chamar('POST', `${A}/analitica/executar`, { token: tokens.auditor, body: {} })).status, 403);
    const r = await chamar('POST', `${A}/analitica/executar`, { token: tokens.admin, body: {} });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    assert.equal(r.corpo.length, 3);
    const hist = await chamar('GET', `${I}/analitica/historico?categoria=VIDA_UTIL`, { token: tokens.auditor });
    assert.ok(hist.corpo.total >= 1);
    const id = hist.corpo.itens[0].id;
    const det = await chamar('GET', `${I}/analitica/historico/${id}`, { token: tokens.auditor });
    assert.ok(Array.isArray(det.corpo.resultado.modelos));
    assert.ok(await prisma.previsaoVidaUtil.count() >= 1);
    // previsão por equipamento ativo gravada, para comparar depois com a data real em que ele virar SUCATA
    const ativos = det.corpo.resultado.equipamentosAtivos.filter((e: { dataPrevistaInservivel: string | null }) => e.dataPrevistaInservivel).length;
    assert.equal(await prisma.previsaoEquipamento.count({ where: { relatorioId: BigInt(id) } }), ativos);
    assert.ok(det.corpo.resultado.modelos.every((m: { vidaUtilContabilAnos: unknown; falhas: { curva: unknown[] } }) => 'vidaUtilContabilAnos' in m && Array.isArray(m.falhas.curva)));
    assert.ok('validacaoPorEquipamento' in det.corpo.resultado);
  });

  it('histórico analítico é imutável no banco', async () => {
    await assert.rejects(prisma.$executeRaw`UPDATE relatorios_analiticos SET amostras = 0`, /GC-IMUTAVEL/);
  });

  it('agendador: tarefa agendada grava as 3 análises e a janela só roda uma vez', async () => {
    const resumo = await app.greencode.agendador.rodarAnalises();
    assert.match(resumo, /EFICIENCIA#\d+/);
    const repo = app.greencode.uow.leitura.execucoes;
    assert.equal(await repo.reservar('teste:janela', 'a'), true);
    assert.equal(await repo.reservar('teste:janela', 'b'), false);
  });

  it('valor recuperado só na destinação com retorno', async () => {
    const lista = await chamar('GET', `${I}/equipamentos?status=EM_TRIAGEM`, { token: tokens.almox });
    const cod = lista.corpo.itens[0]?.codigo;
    if (!cod) return;
    const r = await chamar('POST', `${I}/equipamentos/${cod}/status`, { token: tokens.almox, body: { status: 'DESCARTADO', valorRecuperado: 10 } });
    assert.equal(r.status, 400);
  });
});

describe('AV3: API pública', () => {
  it('admin emite chaves; o segredo aparece só uma vez', async () => {
    const corpo = { parceiro: 'Cooperativa Recicla Vale', organizacao: 'BR001', escopos: ['RASTREIO_LER', 'LOTE_LER', 'LOTE_ESCREVER', 'ANALITICA_LER', 'RELATORIO_GERAR'], limitePorMinuto: 1000 };
    assert.equal((await chamar('POST', `${A}/chaves`, { token: tokens.almox, body: corpo })).status, 403);
    const r = await chamar('POST', `${A}/chaves`, { token: tokens.admin, body: corpo });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    assert.match(r.corpo.chave, /^gc_[a-z2-7]{10}_[A-Za-z0-9_-]{43}$/);
    chaves.total = r.corpo.chave;
    chaves.limitada = (await chamar('POST', `${A}/chaves`, { token: tokens.admin, body: { parceiro: 'Painel Auditoria', organizacao: 'BR001', escopos: ['RASTREIO_LER'], limitePorMinuto: 3 } })).corpo.chave;
    chaves.outraOrg = (await chamar('POST', `${A}/chaves`, { token: tokens.admin, body: { parceiro: 'Parceiro da BR002', organizacao: 'BR002', escopos: ['RASTREIO_LER', 'RELATORIO_GERAR'] } })).corpo.chave;
    const lista = await chamar('GET', `${A}/chaves`, { token: tokens.admin });
    assert.equal(lista.corpo.length, 3);
    assert.ok(lista.corpo.every((c: object) => !('chave' in c) && !('segredoHash' in c)));
  });

  it('sem chave, chave malformada, segredo errado ou JWT → 401', async () => {
    assert.equal((await chamar('GET', `${P}/me`)).status, 401);
    assert.equal((await chamar('GET', `${P}/me`, { chave: 'qualquer-coisa' })).status, 401);
    const adulterada = chaves.total.slice(0, -4) + 'AAAA';
    assert.equal((await chamar('GET', `${P}/me`, { chave: adulterada })).status, 401);
    assert.equal((await chamar('GET', `${P}/me`, { token: tokens.admin })).status, 401);
  });

  it('chave válida: versão e limite nos cabeçalhos', async () => {
    const r = await chamar('GET', `${P}/me`, { chave: chaves.total });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.organizacao, 'BR001');
    assert.equal(r.headers['x-api-version'], '1.0.0');
    assert.equal(r.headers['x-ratelimit-limit'], '1000');
  });

  it('dados recortados pela organização da chave (outra org recebe 404)', async () => {
    const minha = await chamar('GET', `${P}/equipamentos`, { chave: chaves.total });
    assert.equal(minha.status, 200);
    assert.ok(minha.corpo.total >= 2);
    const cod = minha.corpo.itens[0].codigo;
    assert.equal((await chamar('GET', `${P}/equipamentos`, { chave: chaves.outraOrg })).corpo.total, 0);
    const rast = await chamar('GET', `${P}/equipamentos/${cod}/rastreabilidade`, { chave: chaves.total });
    assert.equal(rast.status, 200);
    assert.ok(rast.corpo.movimentacoes.length >= 1);
    assert.equal((await chamar('GET', `${P}/equipamentos/${cod}/rastreabilidade`, { chave: chaves.outraOrg })).status, 404);
  });

  it('escopo ausente → 403', async () => {
    assert.equal((await chamar('GET', `${P}/lotes`, { chave: chaves.limitada })).status, 403);
  });

  it('parceiro submete lote; a organização vem da chave e o ator é a chave', async () => {
    const r = await chamar('POST', `${P}/lotes`, {
      chave: chaves.total,
      body: { notaFiscal: '555', transportadora: 'TransRápida', equipamentos: [{ tipo: 'MONITOR', descricao: 'Monitor Samsung 27', marca: 'samsung', modelo: 'S27', estado: 'BOM', valorAquisicao: 1500, anoFabricacao: 2023 }] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    assert.equal(r.corpo.organizacao, 'BR001');
    assert.equal(r.corpo.equipamentos[0].marca, 'SAMSUNG');
    assert.match(r.corpo.criadoPor, /^api:[a-z2-7]{10}$/);
    const proibido = await chamar('POST', `${P}/lotes`, { chave: chaves.total, body: { organizacao: 'BR002', notaFiscal: '556', transportadora: 'X Log' } });
    assert.equal(proibido.status, 400); // campo organizacao nem existe no contrato público
  });

  it('analítica pública calculada para a organização da chave', async () => {
    const r = await chamar('GET', `${P}/analitica/rentabilidade`, { chave: chaves.total });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.organizacao, 'BR001');
  });

  it('rate limit por chave: estoura em 429 GC-TAXA', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await chamar('GET', `${P}/equipamentos`, { chave: chaves.limitada })).status, 200);
    const r = await chamar('GET', `${P}/equipamentos`, { chave: chaves.limitada });
    assert.equal(r.status, 429);
    assert.equal(r.corpo.erro, 'GC-TAXA');
    // a cota é da chave: outra chave segue atendida
    assert.equal((await chamar('GET', `${P}/equipamentos`, { chave: chaves.total })).status, 200);
  });

  it('relatório assíncrono: 202 → polling → download CSV', async () => {
    const r = await chamar('POST', `${P}/relatorios`, { chave: chaves.total, body: { tipo: 'PREVISAO_ATIVOS', formato: 'CSV' } });
    assert.equal(r.status, 202, JSON.stringify(r.corpo));
    assert.equal(r.headers.location, `${P}/relatorios/${r.corpo.id}`);
    const fim = await esperarTarefa(chaves.total, r.corpo.id);
    assert.equal(fim.corpo.status, 'CONCLUIDA', JSON.stringify(fim.corpo));
    assert.ok(fim.corpo.links.download);
    const d = await chamar('GET', `${P}/relatorios/${r.corpo.id}/download`, { chave: chaves.total });
    assert.equal(d.status, 200);
    assert.match(String(d.headers['content-type']), /text\/csv/);
    assert.match(String(d.headers['content-disposition']), /attachment/);
    assert.ok(d.texto.startsWith('codigo,tipo,marca,modelo,estado,status'));
    assert.equal((await chamar('GET', `${P}/relatorios/${r.corpo.id}`, { chave: chaves.outraOrg })).status, 404);
  });

  it('relatório analítico completo em JSON; CSV recusado', async () => {
    assert.equal((await chamar('POST', `${P}/relatorios`, { chave: chaves.total, body: { tipo: 'ANALITICO_COMPLETO', formato: 'CSV' } })).status, 400);
    const r = await chamar('POST', `${P}/relatorios`, { chave: chaves.total, body: { tipo: 'ANALITICO_COMPLETO' } });
    assert.equal(r.status, 202);
    assert.equal((await esperarTarefa(chaves.total, r.corpo.id)).corpo.status, 'CONCLUIDA');
    const d = await chamar('GET', `${P}/relatorios/${r.corpo.id}/download`, { chave: chaves.total });
    const json = JSON.parse(d.texto);
    assert.deepEqual(Object.keys(json.relatorios).sort(), ['EFICIENCIA', 'RENTABILIDADE', 'VIDA_UTIL']);
    assert.equal(json.organizacao, 'BR001');
  });

  it('download de tarefa pendente → 409; expirada → 410', async () => {
    const chave = await prisma.chaveApi.findFirstOrThrow({ where: { parceiro: 'Cooperativa Recicla Vale' } });
    const base = { chaveApiId: chave.id, organizacaoId: chave.organizacaoId, solicitante: 'teste', tipo: 'PREVISAO_ATIVOS' as const, formato: 'JSON' as const };
    const pend = await prisma.tarefaRelatorio.create({ data: { ...base, expiraEm: new Date(Date.now() + 3_600_000) } });
    assert.equal((await chamar('GET', `${P}/relatorios/${pend.id}/download`, { chave: chaves.total })).status, 409);
    const venc = await prisma.tarefaRelatorio.create({ data: { ...base, status: 'CONCLUIDA', conteudo: '{}', concluidoEm: new Date(), expiraEm: new Date(Date.now() - 1000) } });
    assert.equal((await chamar('GET', `${P}/relatorios/${venc.id}/download`, { chave: chaves.total })).status, 410);
  });

  it('revogação vale na hora', async () => {
    const prefixo = chaves.limitada.split('_')[1];
    assert.equal((await chamar('DELETE', `${A}/chaves/${prefixo}`, { token: tokens.admin })).status, 200);
    assert.equal((await chamar('GET', `${P}/me`, { chave: chaves.limitada })).status, 401);
  });

  it('OpenAPI documenta a API pública com chave e exemplos', async () => {
    const r = await chamar('GET', '/docs/json');
    assert.equal(r.status, 200);
    assert.ok(r.corpo.paths['/api/v1/public/relatorios']);
    assert.ok(r.corpo.paths['/api/v1/internal/analitica/{categoria}']);
    assert.equal(r.corpo.components.securitySchemes.apiKey.name, 'X-API-Key');
  });
});

describe('AV3: rate limit em camadas (IP e login)', () => {
  let app2: FastifyInstance;
  before(async () => {
    app2 = await construirApp({ ambiente: { ...lerAmbiente(), rateLimitLoginPorMinuto: 3, rateLimitIpPorMinuto: 8 }, prisma, logger: false });
    await app2.ready();
  });
  after(async () => { await app2?.close(); });

  // com Redis os contadores sobrevivem 60 s entre execuções: cada execução usa uma faixa de IPs nova
  const faixa = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const ip = (n: number) => `${faixa}.${n}`;

  const ir = (url: string, o: { metodo?: 'GET' | 'POST'; ip?: string; body?: object; chave?: string } = {}) => app2.inject({
    method: o.metodo ?? 'GET', url, remoteAddress: o.ip ?? ip(1),
    headers: o.chave ? { 'x-api-key': o.chave } : {}, ...(o.body ? { payload: o.body } : {}),
  });

  it('login: 4ª tentativa do mesmo IP em 1 minuto → 429, mesmo com senha certa', async () => {
    const body = { usuario: 'admin', senha: 'Errada@123456' };
    for (let i = 0; i < 3; i++) assert.equal((await ir(`${I}/auth/login`, { metodo: 'POST', ip: ip(7), body })).statusCode, 401);
    const r = await ir(`${I}/auth/login`, { metodo: 'POST', ip: ip(7), body: { usuario: 'admin', senha: SENHA_ADMIN } });
    assert.equal(r.statusCode, 429);
    assert.equal(r.json().detalhes.camada, 'login');
    assert.ok(r.headers['retry-after']);
    // outro IP não é afetado
    assert.equal((await ir(`${I}/auth/login`, { metodo: 'POST', ip: ip(8), body: { usuario: 'admin', senha: SENHA_ADMIN } })).statusCode, 200);
  });

  it('IP: requisições sem chave (ou com chave inventada) também são limitadas', async () => {
    const st: number[] = [];
    for (let i = 0; i < 9; i++) st.push((await ir(`${P}/me`, { ip: ip(9), chave: `gc_aaaaaaaaaa_${'x'.repeat(43)}` })).statusCode);
    assert.deepEqual(st.slice(0, 8), Array(8).fill(401));
    assert.equal(st[8], 429);
  });

  it('health fica fora do limite por IP', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await ir('/health', { ip: ip(10) })).statusCode, 200);
  });
});
