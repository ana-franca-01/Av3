import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as ss from 'simple-statistics';
import {
  AnaliseEficiencia, AnaliseRentabilidade, AnaliseVidaUtil, ContextoAnalise, EquipamentoAnalitico,
} from '../../src/analitica/analises';
import { cruzamento, descrever, regressaoLinear, suavizacaoHolt } from '../../src/analitica/estatistica';
import { ErroDefinitivo, FilaMemoria } from '../../src/fila/fila';
import { paraCsv } from '../../src/servicos/tarefa.servico';

const AGORA = new Date(Date.UTC(2026, 10, 12, 12));
const ctx = (extra: Partial<ContextoAnalise> = {}): ContextoAnalise => ({ agora: AGORA, fonteDepreciacao: () => undefined, previsoesAnteriores: [], ...extra });
const dia = (n: number) => new Date(AGORA.getTime() - n * 86_400_000);
const silencioso = { info() {}, warn() {}, error() {} };

function equip(p: Partial<EquipamentoAnalitico>): EquipamentoAnalitico {
  return {
    id: p.codigo ?? 'EQ-1', codigo: 'EQ-1', tipo: 'COMPUTADOR', marca: null, modelo: null, estado: 'BOM', status: 'RECEBIDO',
    valorAquisicao: null, anoFabricacao: null, valorRecuperado: null, triagemResponsavel: null, triagemEm: null,
    dataEntradaLote: dia(10), movimentos: [], ...p,
  };
}

describe('estatística', () => {
  it('MQO exato numa reta perfeita', () => {
    const r = regressaoLinear([[0, 4], [2, 3], [4, 2], [6, 1]])!;
    assert.equal(r.intercepto, 4);
    assert.equal(r.inclinacao, -0.5);
    assert.equal(r.r2, 1);
    assert.equal(cruzamento(r, 0), 8);
  });

  it('MQO manual confere com a simple-statistics em dados com ruído', () => {
    const pts: Array<[number, number]> = [[1, 3.9], [2, 3.4], [3, 3.1], [5, 1.8], [7, 1.2], [8, 0.4]];
    const r = regressaoLinear(pts)!;
    const ref = ss.linearRegression(pts);
    assert.ok(Math.abs(r.inclinacao - ref.m) < 1e-12);
    assert.ok(Math.abs(r.intercepto - ref.b) < 1e-12);
    assert.ok(Math.abs(r.r2 - ss.rSquared(pts, ss.linearRegressionLine(ref))) < 1e-12);
  });

  it('casos degenerados: poucos pontos, x constante, reta crescente', () => {
    assert.equal(regressaoLinear([[1, 1]]), null);
    assert.equal(regressaoLinear([[2, 1], [2, 3]]), null);
    assert.equal(cruzamento({ intercepto: 1, inclinacao: 0.2 }), null);
  });

  it('Holt acompanha a tendência de uma série decrescente', () => {
    const h = suavizacaoHolt([4, 3, 2, 1, 0])!;
    assert.ok(h.tendencia < -0.8 && h.tendencia > -1.2, String(h.tendencia));
    assert.equal(suavizacaoHolt([1, 2]), null);
  });

  it('descritiva', () => {
    const d = descrever([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.equal(d.media, 5);
    assert.equal(d.mediana, 4.5);
    assert.equal(descrever([]).media, null);
  });
});

describe('análise de eficiência', () => {
  it('tempo entrada → triagem por operador, etapas e parados', () => {
    const mov = (ts: Date, statusPara: EquipamentoAnalitico['status']) => ({ ts, statusPara, estadoPara: 'BOM' as const });
    const r = new AnaliseEficiencia(7).calcular([
      equip({ codigo: 'A', dataEntradaLote: dia(10), triagemEm: dia(8), triagemResponsavel: 'ana', status: 'TRIADO',
        movimentos: [mov(dia(10), 'RECEBIDO'), mov(dia(9), 'EM_TRIAGEM'), mov(dia(8), 'TRIADO')] }),
      equip({ codigo: 'B', dataEntradaLote: dia(10), triagemEm: dia(6), triagemResponsavel: 'bruno', status: 'TRIADO',
        movimentos: [mov(dia(10), 'RECEBIDO'), mov(dia(7), 'EM_TRIAGEM'), mov(dia(6), 'TRIADO')] }),
      equip({ codigo: 'C', movimentos: [mov(dia(20), 'RECEBIDO')] }),
    ], ctx());
    assert.equal(r.entradaAteTriagem.media, 3);
    assert.deepEqual(r.porOperador.map((o) => o.operador), ['ana', 'bruno']);
    assert.equal(r.gargalo?.status, 'RECEBIDO'); // média de 2 dias parado em RECEBIDO
    assert.equal(r.parados.total, 2); // C (RECEBIDO há 20 dias) e A (TRIADO há 8); B está há só 6
    assert.ok(r.parados.itens.some((p) => p.codigo === 'C'));
  });
});

describe('análise de rentabilidade', () => {
  it('estimativa polimórfica, agrupamento por marca e acurácia contra o realizado', () => {
    const r = new AnaliseRentabilidade().calcular([
      // 2 anos × 20% = 40% depreciado → 2400 × 0,7 (BOM) = 1680 > 60 de materiais → REUSO
      equip({ codigo: 'A', marca: 'DELL', modelo: 'X', valorAquisicao: 4000, anoFabricacao: 2024, status: 'REUTILIZADO', valorRecuperado: 1500 }),
      // sem valor de aquisição: só materiais
      equip({ codigo: 'B', tipo: 'SERVIDOR', estado: 'SUCATA' }),
    ], ctx());
    const pc = r.porTipo.find((t) => t.tipo === 'COMPUTADOR')!;
    assert.equal(pc.valorMedioEstimado, 1680);
    assert.equal(pc.rotaPredominante, 'REUSO');
    assert.equal(r.porTipo.find((t) => t.tipo === 'SERVIDOR')!.valorMedioEstimado, 250);
    assert.equal(r.porMarcaModelo[0].marca, 'DELL');
    assert.equal(r.acuraciaEstimativa.comparacoes, 1);
    assert.equal(r.acuraciaEstimativa.erroMedioAbsoluto, 180);
    assert.deepEqual(r.prioridade.map((p) => p.codigo), ['B']); // A já foi destinado
  });
});

describe('análise de vida útil', () => {
  const a = new AnaliseVidaUtil();

  it('MQO quando há dados e o modelo explica bem', () => {
    const pts: Array<[number, number]> = [[0, 4], [1, 3.5], [2, 3], [4, 2], [6, 1], [8, 0]];
    const m = a.modelar('COMPUTADOR', pts, () => undefined);
    assert.equal(m.metodo, 'MQO');
    assert.equal(m.vidaUtilAnos, 8);
  });

  it('Holt quando há poucas observações mas tendência clara', () => {
    const m = a.modelar('MONITOR', [[0.5, 4], [1.5, 3], [2.5, 2], [3.5, 1]], () => undefined);
    assert.equal(m.metodo, 'HOLT');
    assert.ok(m.vidaUtilAnos! > 3.5 && m.vidaUtilAnos! < 6, String(m.vidaUtilAnos));
  });

  it('cai na vida útil contábil sem histórico', () => {
    const m = a.modelar('TELECOM', [], (t) => (t === 'TELECOM' ? 12.5 : undefined));
    assert.equal(m.metodo, 'DEPRECIACAO');
    assert.equal(m.vidaUtilAnos, 8);
  });

  it('remanescente parte do estado atual com a taxa do tipo', () => {
    // 6 computadores observados em idades diferentes, perdendo 0,5 ponto por ano
    const hist = [0, 1, 2, 4, 6, 8].map((idade, i) => equip({
      codigo: `H${i}`, anoFabricacao: 2026 - idade, status: 'DESCARTADO', estado: 'SUCATA',
      movimentos: [{ ts: new Date(Date.UTC(2026, 6, 1)), statusPara: 'RECEBIDO', estadoPara: (['EXCELENTE', 'BOM', 'BOM', 'REGULAR', 'RUIM', 'SUCATA'] as const)[i] }],
    }));
    const ativo = equip({ codigo: 'ATIVO', anoFabricacao: 2018, estado: 'BOM' });
    const r = a.calcular([...hist, ativo], ctx());
    const m = r.modelos[0];
    assert.equal(m.metodo, 'MQO');
    const linha = r.equipamentosAtivos.find((e) => e.codigo === 'ATIVO')!;
    assert.equal(linha.vidaRemanescenteAnos, Math.round((3 / -m.inclinacao!) * 100) / 100);
    assert.match(linha.dataPrevistaInservivel!, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('histórico de falhas: curva por faixa de idade e idade média até SUCATA', () => {
    const ts = new Date(Date.UTC(2026, 6, 1));
    const f = AnaliseVidaUtil.historicoFalhas([
      equip({ codigo: 'A', anoFabricacao: 2025, movimentos: [{ ts, statusPara: 'RECEBIDO', estadoPara: 'BOM' }] }),
      equip({ codigo: 'B', anoFabricacao: 2018, movimentos: [{ ts, statusPara: 'RECEBIDO', estadoPara: 'SUCATA' }] }),
      equip({ codigo: 'C', anoFabricacao: 2016, movimentos: [{ ts, statusPara: 'RECEBIDO', estadoPara: 'RUIM' }] }),
    ]);
    assert.deepEqual(f.curva.map((c) => [c.faixa, c.emFalhaPct]), [['0-2', 0], ['6-8', 100], ['9-11', 100]]);
    assert.equal(f.equipamentosInserviveis, 1);
    assert.equal(f.idadeMediaAteInservivelAnos, 8);
  });

  it('sem tendência de desgaste, usa a idade média de quem virou SUCATA (método FALHAS)', () => {
    const m = a.modelar('SERVIDOR', [[5, 0], [5, 0]], () => undefined,
      { curva: [], equipamentosInserviveis: 3, idadeMediaAteInservivelAnos: 7.5 });
    assert.equal(m.metodo, 'FALHAS');
    assert.equal(m.vidaUtilAnos, 7.5);
    assert.equal(m.vidaUtilContabilAnos, 5); // 20% ao ano
  });

  it('valida a data prevista de cada equipamento contra a data em que virou SUCATA', () => {
    const v = AnaliseVidaUtil.validarEquipamentos([
      equip({ codigo: 'A', movimentos: [{ ts: new Date(Date.UTC(2026, 5, 1)), statusPara: 'TRIADO', estadoPara: 'SUCATA' }] }),
      equip({ codigo: 'B', movimentos: [{ ts: new Date(Date.UTC(2026, 5, 1)), statusPara: 'TRIADO', estadoPara: 'RUIM' }] }),
    ], [
      { codigo: 'A', dataPrevista: new Date(Date.UTC(2025, 5, 1)), geradoEm: new Date(Date.UTC(2024, 0, 1)) },
      // previsão mais recente antes da realização é a que vale
      { codigo: 'A', dataPrevista: new Date(Date.UTC(2026, 11, 1)), geradoEm: new Date(Date.UTC(2025, 0, 1)) },
      { codigo: 'B', dataPrevista: new Date(Date.UTC(2026, 0, 1)), geradoEm: new Date(Date.UTC(2025, 0, 1)) },
    ]);
    assert.equal(v.comparacoes, 1); // B não virou SUCATA
    assert.equal(v.itens[0].dataPrevista, '2026-12-01');
    assert.equal(v.viesAnos, -0.5); // virou SUCATA ~6 meses antes do previsto
    assert.equal(v.dentroDeUmAnoPct, 100);
  });

  it('valida previsões antigas contra quem virou SUCATA depois', () => {
    const v = AnaliseVidaUtil.validar([
      equip({ anoFabricacao: 2020, movimentos: [{ ts: new Date(Date.UTC(2026, 6, 1)), statusPara: 'TRIADO', estadoPara: 'SUCATA' }] }),
    ], [{ tipo: 'COMPUTADOR', vidaUtilAnos: 5, geradoEm: new Date(Date.UTC(2025, 0, 1)) }]);
    assert.equal(v.comparacoes, 1);
    assert.equal(v.erroMedioAbsolutoAnos, 1); // viveu 6, previsto 5
  });
});

describe('CSV', () => {
  it('escapa vírgula, aspas e quebra de linha (RFC 4180)', () => {
    assert.equal(paraCsv(['a', 'b'], [['x,y', 'diz "oi"'], [null, 'l1\nl2']]), 'a,b\r\n"x,y","diz ""oi"""\r\n,"l1\nl2"\r\n');
  });
});

describe('fila em memória: política de retry', () => {
  it('falha transitória é repetida com backoff até dar certo', async () => {
    const fila = new FilaMemoria({ tentativas: 3, atrasoBaseMs: 5 }, 1, silencioso);
    const vistas: Array<[number, boolean]> = [];
    await new Promise<void>((ok) => {
      fila.iniciarWorker(async (_id, t, ultima) => {
        vistas.push([t, ultima]);
        if (t < 3) throw new Error('banco ocupado');
        ok();
      });
      void fila.publicar('t1');
    });
    await fila.fechar();
    assert.deepEqual(vistas, [[1, false], [2, false], [3, true]]);
  });

  it('erro definitivo não é repetido; publicar duas vezes não duplica', async () => {
    const fila = new FilaMemoria({ tentativas: 3, atrasoBaseMs: 5 }, 1, silencioso);
    let chamadas = 0;
    fila.iniciarWorker(async () => { chamadas++; throw new ErroDefinitivo('regra de negócio'); });
    await fila.publicar('t2');
    await fila.publicar('t2');
    await new Promise((r) => setTimeout(r, 60));
    await fila.fechar();
    assert.equal(chamadas, 1);
  });
});
