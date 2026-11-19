import { EstadoFisico, TipoEquipamento } from './tipos';
export interface DadosFinanceiros { valorAquisicao: number | null; anoFabricacao: number | null }


export type FonteDepreciacao = (tipo: TipoEquipamento) => number | undefined;

export interface AvaliacaoFinanceira {
  depreciacaoAnualPct: number;
  idadeAnos: number | null;
  valorAquisicao: number | null;
  valorResidual: number | null;
}

// Quanto do valor residual dá pra recuperar revendendo/reaproveitando, conforme o estado físico.
export const FATOR_RECUPERACAO: Record<EstadoFisico, number> = { EXCELENTE: 0.9, BOM: 0.7, REGULAR: 0.45, RUIM: 0.2, SUCATA: 0 };

export interface EstimativaRecuperacao {
  valorResidual: number | null;
  valorReuso: number | null;
  valorMateriais: number;
  valorEstimado: number;
  rota: 'REUSO' | 'MATERIAIS';
}

export abstract class Equipamento {
  constructor(readonly dados: DadosFinanceiros) {}
  abstract readonly tipo: TipoEquipamento;
  abstract depreciacaoAnualPadrao(): number; // % ao ano
  abstract materiaisRecuperaveis(): string[];
  // R$ médio obtido vendendo os materiais de uma unidade como sucata (piso da recuperação)
  abstract valorMateriaisPadrao(): number;

  coeficienteDepreciacao(fonte: FonteDepreciacao): number {
    return fonte(this.tipo) ?? this.depreciacaoAnualPadrao();
  }

  // depreciação linear desde o ano de fabricação; nunca fica negativo
  avaliar(fonte: FonteDepreciacao, anoReferencia: number): AvaliacaoFinanceira {
    const pct = this.coeficienteDepreciacao(fonte);
    const { valorAquisicao, anoFabricacao } = this.dados;
    const idade = anoFabricacao === null ? null : Math.max(0, anoReferencia - anoFabricacao);
    let residual: number | null = null;
    if (valorAquisicao !== null && idade !== null) {
      const fator = Math.max(0, 1 - (pct / 100) * idade);
      residual = Math.round(valorAquisicao * fator * 100) / 100;
    }
    return { depreciacaoAnualPct: pct, idadeAnos: idade, valorAquisicao, valorResidual: residual };
  }

  // O que vale mais: revender (residual × fator do estado) ou desmontar e vender os materiais.
  estimarRecuperacao(fonte: FonteDepreciacao, anoReferencia: number, estado: EstadoFisico): EstimativaRecuperacao {
    const { valorResidual } = this.avaliar(fonte, anoReferencia);
    const reuso = valorResidual === null ? null : Math.round(valorResidual * FATOR_RECUPERACAO[estado] * 100) / 100;
    const materiais = this.valorMateriaisPadrao();
    const rota = reuso !== null && reuso > materiais ? 'REUSO' : 'MATERIAIS';
    return { valorResidual, valorReuso: reuso, valorMateriais: materiais, valorEstimado: rota === 'REUSO' ? reuso! : materiais, rota };
  }
}

export class Computador extends Equipamento {
  readonly tipo = 'COMPUTADOR' as const;
  depreciacaoAnualPadrao(): number { return 20; }
  materiaisRecuperaveis(): string[] { return ['ouro (placas)', 'cobre', 'alumínio', 'terras raras (HDD)']; }
  valorMateriaisPadrao(): number { return 60; }
}
export class Servidor extends Equipamento {
  readonly tipo = 'SERVIDOR' as const;
  depreciacaoAnualPadrao(): number { return 20; }
  materiaisRecuperaveis(): string[] { return ['ouro', 'prata', 'cobre', 'paládio', 'terras raras']; }
  valorMateriaisPadrao(): number { return 250; }
}
export class Monitor extends Equipamento {
  readonly tipo = 'MONITOR' as const;
  depreciacaoAnualPadrao(): number { return 20; }
  materiaisRecuperaveis(): string[] { return ['vidro', 'cobre', 'plástico', 'índio (telas)']; }
  valorMateriaisPadrao(): number { return 25; }
}
export class EquipamentoTelecom extends Equipamento {
  readonly tipo = 'TELECOM' as const;
  depreciacaoAnualPadrao(): number { return 10; }
  materiaisRecuperaveis(): string[] { return ['cobre', 'ouro (conectores)', 'alumínio']; }
  valorMateriaisPadrao(): number { return 80; }
}
export class Periferico extends Equipamento {
  readonly tipo = 'PERIFERICO' as const;
  depreciacaoAnualPadrao(): number { return 20; }
  materiaisRecuperaveis(): string[] { return ['plástico', 'cobre']; }
  valorMateriaisPadrao(): number { return 5; }
}
export class EquipamentoGenerico extends Equipamento {
  readonly tipo = 'OUTRO' as const;
  depreciacaoAnualPadrao(): number { return 10; }
  materiaisRecuperaveis(): string[] { return ['metais diversos']; }
  valorMateriaisPadrao(): number { return 15; }
}

export class FabricaEquipamento {
  static criar(tipo: TipoEquipamento, dados: DadosFinanceiros): Equipamento {
    switch (tipo) {
      case 'COMPUTADOR': return new Computador(dados);
      case 'SERVIDOR': return new Servidor(dados);
      case 'MONITOR': return new Monitor(dados);
      case 'TELECOM': return new EquipamentoTelecom(dados);
      case 'PERIFERICO': return new Periferico(dados);
      default: return new EquipamentoGenerico(dados);
    }
  }

 
  static codigoBarras(sequencia: number): string {
    const digitos = String(sequencia).padStart(8, '0');
    let soma = 0;
    for (let i = 0; i < digitos.length; i++) soma += +digitos[i] * (i % 2 === 0 ? 3 : 1);
    return `GC${digitos}${(10 - (soma % 10)) % 10}`;
  }
}
