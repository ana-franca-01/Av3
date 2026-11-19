// Esquemas de resposta da API pública. Servem à documentação OpenAPI (exemplos e códigos de erro por rota)
// e ao serializador do Fastify. Os objetos aceitam campos extras (additionalProperties) pra que a documentação
// nunca corte um campo que o serviço devolve.

const dataHora = { type: 'string', format: 'date-time' };
const aberto = (properties: object, exemplo?: object) => ({
  type: 'object', additionalProperties: true, properties, ...(exemplo ? { examples: [exemplo] } : {}),
});

const EX_EQUIP = {
  codigo: 'EQ-000001', codigoBarrasInterno: 'GC000000014', lote: 'LT-000001', tipo: 'COMPUTADOR', descricao: 'Desktop Dell OptiPlex 7010',
  serie: 'DL7010-001', marca: 'DELL', modelo: 'OptiPlex 7010', estado: 'BOM', status: 'REUTILIZADO', valorAquisicao: 4200, anoFabricacao: 2019,
};
const EX_LOTE = { codigo: 'LT-000001', organizacao: 'BR001', notaFiscal: '100234', transportadora: 'TransRápida', dataEntrada: '2026-10-03', totalEquipamentos: 4 };
const EX_TAREFA = {
  id: '5b0c1d7e-4a8f-4e5b-9a51-0f3c2e7d9b11', tipo: 'PREVISAO_ATIVOS', formato: 'CSV', status: 'PENDENTE', tentativas: 0, erro: null,
  criadoEm: '2026-11-12T10:00:00.000Z', concluidoEm: null, expiraEm: '2026-11-15T10:00:00.000Z',
  links: { status: '/api/v1/public/relatorios/5b0c1d7e-4a8f-4e5b-9a51-0f3c2e7d9b11' },
};

export const erro = (descricao: string, codigo: string, mensagem: string) => ({
  description: descricao,
  type: 'object',
  properties: { erro: { type: 'string' }, mensagem: { type: 'string' }, detalhes: {} },
  examples: [{ erro: codigo, mensagem }],
});

// erros que qualquer rota pública pode devolver
export const errosComuns = {
  401: erro('Chave ausente, malformada, revogada ou expirada', 'GC-AUTH', 'Chave de API ausente ou inválida. Envie o cabeçalho X-API-Key.'),
  403: erro('A chave não tem o escopo exigido pela rota', 'GC-PERM', 'A chave abc123defg não tem o escopo "LOTE_ESCREVER".'),
  429: erro('Limite de requisições por minuto da chave excedido (veja os cabeçalhos x-ratelimit-*)', 'GC-TAXA', 'Limite de 60 requisições por minuto excedido. Tente novamente em 42 seconds.'),
  500: erro('Erro inesperado (detalhe só no log do servidor)', 'GC-SYS', 'Erro interno. A operação não foi concluída.'),
};

const naoEncontrado = (o: string) => erro(`${o} inexistente ou de outra organização`, 'GC-404', `${o} "EQ-000999" não encontrado.`);

const equipamento = aberto({
  codigo: { type: 'string' }, codigoBarrasInterno: { type: 'string' }, lote: { type: 'string' }, tipo: { type: 'string' },
  descricao: { type: 'string' }, marca: { type: ['string', 'null'] }, modelo: { type: ['string', 'null'] },
  estado: { type: 'string' }, status: { type: 'string' }, criadoEm: dataHora, atualizadoEm: dataHora,
}, EX_EQUIP);

const paginado = (item: object, exemplo: object) => ({
  type: 'object', additionalProperties: true,
  properties: { itens: { type: 'array', items: item }, total: { type: 'integer' }, pagina: { type: 'integer' }, tamanho: { type: 'integer' } },
  examples: [{ itens: [exemplo], total: 1, pagina: 1, tamanho: 20 }],
});

export const respQuemSou = {
  200: aberto({ parceiro: { type: 'string' }, prefixo: { type: 'string' }, organizacao: { type: 'string' }, escopos: { type: 'array', items: { type: 'string' } }, limitePorMinuto: { type: 'integer' } },
    { parceiro: 'Cooperativa Recicla Vale', prefixo: 'k3m9q2xv7a', organizacao: 'BR001', escopos: ['RASTREIO_LER', 'LOTE_LER'], limitePorMinuto: 60 }),
  ...errosComuns,
};

export const respEquipamentos = {
  200: paginado(equipamento, EX_EQUIP),
  400: erro('Filtro inválido', 'GC-VAL', 'Requisição inválida: querystring/status must be equal to one of the allowed values'),
  ...errosComuns,
};

export const respRastreio = {
  200: aberto({
    equipamento,
    movimentacoes: {
      type: 'array',
      items: aberto({ id: { type: 'string' }, ts: dataHora, ator: { type: 'string' }, tipo: { type: 'string' }, statusDe: { type: ['string', 'null'] }, statusPara: { type: 'string' } }),
    },
  }, {
    equipamento: EX_EQUIP,
    movimentacoes: [
      { id: '1', ts: '2026-10-03T13:02:11.000Z', ator: 'almox', tipo: 'REGISTRO', statusDe: null, statusPara: 'RECEBIDO', estadoDe: null, estadoPara: 'BOM' },
      { id: '9', ts: '2026-10-04T09:40:00.000Z', ator: 'almox', tipo: 'TRIAGEM', statusDe: 'EM_TRIAGEM', statusPara: 'TRIADO', estadoDe: 'BOM', estadoPara: 'BOM' },
    ],
  }),
  404: naoEncontrado('Equipamento'),
  ...errosComuns,
};

const lote = aberto({ codigo: { type: 'string' }, organizacao: { type: 'string' }, notaFiscal: { type: 'string' }, transportadora: { type: 'string' }, dataEntrada: { type: 'string' } },
  EX_LOTE);

export const respLotes = { 200: paginado(lote, EX_LOTE), ...errosComuns };
export const respLote = { 200: lote, 404: naoEncontrado('Lote'), ...errosComuns };
export const respCriarLote = {
  201: lote,
  400: erro('Corpo inválido (nota fiscal, data fora da janela de 90 dias, equipamento inválido…)', 'GC-VAL', 'Data de entrada futura não é permitida.'),
  409: erro('Nota fiscal já usada pela organização ou número de série repetido', 'GC-CONF', 'Já existe lote da organização BR001 com a nota fiscal 45120.'),
  422: erro('Organização sem contrato vigente na data de entrada', 'GC-NEG', 'Organização BR001 não possui contrato de coleta vigente em 2026-11-10.'),
  ...errosComuns,
};

export const respAnalise = {
  200: aberto({ categoria: { type: 'string' }, organizacao: { type: 'string' }, geradoEm: dataHora, amostras: { type: 'integer' }, resultado: aberto({}) }, {
    categoria: 'VIDA_UTIL', organizacao: 'BR001', geradoEm: '2026-11-12T10:00:00.000Z', amostras: 48,
    resultado: {
      modelos: [{ tipo: 'COMPUTADOR', metodo: 'MQO', intercepto: 4.21, inclinacao: -0.38, r2: 0.62, amostras: 31, vidaUtilAnos: 11.08 }],
      equipamentosAtivos: [{ codigo: 'EQ-000003', tipo: 'MONITOR', estado: 'BOM', idadeAnos: 4.36, vidaRemanescenteAnos: 6.1, dataPrevistaInservivel: '2032-12-18', metodo: 'MQO' }],
    },
  }),
  400: erro('Categoria inexistente', 'GC-VAL', 'Categoria inválido "X". Valores aceitos: EFICIENCIA, RENTABILIDADE, VIDA_UTIL.'),
  ...errosComuns,
};

const tarefa = aberto({
  id: { type: 'string', format: 'uuid' }, tipo: { type: 'string' }, formato: { type: 'string' }, status: { type: 'string' },
  tentativas: { type: 'integer' }, erro: { type: ['string', 'null'] }, criadoEm: dataHora, concluidoEm: { ...dataHora, type: ['string', 'null'] },
  expiraEm: dataHora, links: aberto({ status: { type: 'string' }, download: { type: 'string' } }),
}, EX_TAREFA);

export const respSolicitar = {
  202: { ...tarefa, description: 'Aceito para processamento. Consulte links.status até status = CONCLUIDA.' },
  400: erro('Tipo/formato inválido', 'GC-VAL', 'ANALITICO_COMPLETO só é gerado em JSON (o conteúdo é aninhado demais para uma tabela CSV).'),
  503: erro('Fila de processamento fora do ar', 'GC-INDISP', 'Fila de processamento indisponível no momento. Tente novamente em instantes.'),
  ...errosComuns,
};
export const respTarefa = { 200: tarefa, 404: naoEncontrado('Tarefa'), ...errosComuns };
export const respTarefas = { 200: paginado(tarefa, EX_TAREFA), ...errosComuns };
// sem esquema para o 200 de propósito: o corpo é o arquivo (CSV ou JSON) e não pode passar pelo serializador
export const respDownload = {
  404: naoEncontrado('Tarefa'),
  409: erro('Ainda em processamento', 'GC-CONF', 'Relatório ainda em processamento (status PROCESSANDO).'),
  410: erro('Arquivo expirado (RELATORIO_VALIDADE_HORAS)', 'GC-EXPIRADO', 'O arquivo do relatório expirou em 2026-11-15T10:00:00.000Z. Solicite um novo.'),
  422: erro('A geração falhou após todas as tentativas', 'GC-NEG', 'A geração do relatório falhou: ...'),
  ...errosComuns,
};
