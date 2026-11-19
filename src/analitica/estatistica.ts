import * as ss from 'simple-statistics';

// Funções estatísticas puras (sem banco, sem HTTP): é aqui que mora a matemática da camada analítica.
// Medidas descritivas vêm da simple-statistics; a regressão por mínimos quadrados e a suavização de Holt
// estão implementadas à mão porque precisamos do R² e do comportamento em casos degenerados sob controle.

export interface Descritiva {
  n: number;
  media: number | null;
  mediana: number | null;
  desvioPadrao: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
  // desvio / média: compara dispersão entre grupos de escalas diferentes (ex.: operadores)
  coeficienteVariacao: number | null;
}

export const arred = (v: number, casas = 2): number => {
  const f = 10 ** casas;
  return Math.round(v * f) / f;
};

export function descrever(valores: number[], casas = 2): Descritiva {
  const n = valores.length;
  if (n === 0) return { n, media: null, mediana: null, desvioPadrao: null, p90: null, min: null, max: null, coeficienteVariacao: null };
  const media = ss.mean(valores);
  // desvio amostral precisa de 2+ pontos
  const desvio = n > 1 ? ss.sampleStandardDeviation(valores) : 0;
  return {
    n,
    media: arred(media, casas),
    mediana: arred(ss.median(valores), casas),
    desvioPadrao: arred(desvio, casas),
    p90: arred(ss.quantile(valores, 0.9), casas),
    min: arred(ss.min(valores), casas),
    max: arred(ss.max(valores), casas),
    coeficienteVariacao: media === 0 ? null : arred(desvio / media, 4),
  };
}

export interface Regressao { intercepto: number; inclinacao: number; r2: number; n: number }

// Mínimos quadrados ordinários para y = a + b·x.
// b = Σ(x - x̄)(y - ȳ) / Σ(x - x̄)²,  a = ȳ - b·x̄,  R² = 1 - SQres / SQtot.
export function regressaoLinear(pontos: ReadonlyArray<readonly [number, number]>): Regressao | null {
  const n = pontos.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of pontos) { sx += x; sy += y; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pontos) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return null; // todos os x iguais: reta indefinida
  const b = sxy / sxx;
  const a = my - b * mx;
  let sqres = 0;
  for (const [x, y] of pontos) sqres += (y - (a + b * x)) ** 2;
  // y constante: a reta horizontal explica tudo
  const r2 = syy === 0 ? 1 : Math.max(0, 1 - sqres / syy);
  return { intercepto: a, inclinacao: b, r2, n };
}

// Valor de x em que a reta cruza y = alvo. Só faz sentido para reta decrescente (o equipamento se degrada).
export function cruzamento(r: Pick<Regressao, 'intercepto' | 'inclinacao'>, alvo = 0): number | null {
  if (r.inclinacao >= 0) return null;
  return (alvo - r.intercepto) / r.inclinacao;
}

export interface Holt { nivel: number; tendencia: number; n: number }

// Suavização exponencial dupla (Holt): acompanha nível e tendência de uma série ordenada, dando mais peso
// às observações recentes. Usada quando a reta de MQO explica pouco (R² baixo), mas a série tem direção.
export function suavizacaoHolt(serie: number[], alfa = 0.5, beta = 0.3): Holt | null {
  if (serie.length < 3) return null;
  if (alfa <= 0 || alfa > 1 || beta <= 0 || beta > 1) throw new RangeError('alfa e beta devem estar em (0, 1].');
  let nivel = serie[0];
  let tendencia = serie[1] - serie[0];
  for (let i = 1; i < serie.length; i++) {
    const anterior = nivel;
    nivel = alfa * serie[i] + (1 - alfa) * (nivel + tendencia);
    tendencia = beta * (nivel - anterior) + (1 - beta) * tendencia;
  }
  return { nivel, tendencia, n: serie.length };
}

// Agrupa por chave preservando a ordem de primeira aparição.
export function agrupar<T, K extends string>(itens: Iterable<T>, chave: (t: T) => K | null): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const i of itens) {
    const k = chave(i);
    if (k === null) continue;
    const g = m.get(k);
    if (g) g.push(i); else m.set(k, [i]);
  }
  return m;
}

export const ANO_MS = 365.25 * 86_400_000;
export const DIA_MS = 86_400_000;
