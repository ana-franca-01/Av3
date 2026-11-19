-- Regras de integridade das tabelas da AV3 (mesma filosofia da AV2: o serviço valida, o banco é a última barreira).

ALTER TABLE equipamentos
  ADD CONSTRAINT ck_equipamentos_valor_recuperado CHECK (valor_recuperado IS NULL OR valor_recuperado >= 0),
  -- só existe valor realizado depois que o equipamento teve destino com retorno financeiro
  ADD CONSTRAINT ck_equipamentos_recuperado_status CHECK (valor_recuperado IS NULL OR status IN ('REUTILIZADO', 'RECICLADO'));

ALTER TABLE relatorios_analiticos
  ADD CONSTRAINT ck_relatorios_amostras CHECK (amostras >= 0),
  ADD CONSTRAINT ck_relatorios_duracao CHECK (duracao_ms >= 0),
  ADD CONSTRAINT ck_relatorios_resultado CHECK (jsonb_typeof(resultado) = 'object');

ALTER TABLE previsoes_vida_util
  ADD CONSTRAINT ck_previsoes_metodo CHECK (metodo IN ('MQO', 'HOLT', 'DEPRECIACAO')),
  ADD CONSTRAINT ck_previsoes_amostras CHECK (amostras >= 0),
  ADD CONSTRAINT ck_previsoes_vida CHECK (vida_util_anos IS NULL OR vida_util_anos > 0);

ALTER TABLE chaves_api
  ADD CONSTRAINT ck_chaves_prefixo CHECK (prefixo ~ '^[a-z0-9]{8,12}$'),
  ADD CONSTRAINT ck_chaves_hash CHECK (segredo_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ck_chaves_limite CHECK (limite_por_minuto BETWEEN 1 AND 10000),
  ADD CONSTRAINT ck_chaves_escopos CHECK (cardinality(escopos) >= 1),
  ADD CONSTRAINT ck_chaves_versao CHECK (versao >= 1);

ALTER TABLE tarefas_relatorio
  ADD CONSTRAINT ck_tarefas_tentativas CHECK (tentativas >= 0),
  ADD CONSTRAINT ck_tarefas_concluida CHECK (status <> 'CONCLUIDA' OR concluido_em IS NOT NULL),
  -- relatório analítico completo é aninhado demais pra uma tabela CSV
  ADD CONSTRAINT ck_tarefas_formato CHECK (tipo <> 'ANALITICO_COMPLETO' OR formato = 'JSON');

-- Relatórios e previsões são histórico: podem ser consultados e comparados, mas não reescritos.
CREATE TRIGGER trg_relatorios_analiticos_imutavel
  BEFORE UPDATE ON relatorios_analiticos
  FOR EACH ROW EXECUTE FUNCTION fn_bloquear_alteracao();

CREATE TRIGGER trg_previsoes_vida_util_imutavel
  BEFORE UPDATE ON previsoes_vida_util
  FOR EACH ROW EXECUTE FUNCTION fn_bloquear_alteracao();
