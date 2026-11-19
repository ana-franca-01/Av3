-- Vida útil: previsão gravada por equipamento (permite medir previsão × realização no nível do equipamento)
-- e novo método FALHAS (idade média em que o tipo chega a SUCATA).

CREATE TABLE "previsoes_equipamento" (
    "id" BIGSERIAL NOT NULL,
    "relatorio_id" BIGINT NOT NULL,
    "equipamento_id" UUID NOT NULL,
    "tipo" "TipoEquipamento" NOT NULL,
    "estado" "EstadoFisico" NOT NULL,
    "metodo" VARCHAR(20) NOT NULL,
    "idade_anos" DECIMAL(6,2),
    "vida_remanescente_anos" DECIMAL(6,2) NOT NULL,
    "data_prevista_inservivel" DATE NOT NULL,
    "gerado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "previsoes_equipamento_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "previsoes_equipamento_equipamento_id_gerado_em_idx" ON "previsoes_equipamento"("equipamento_id", "gerado_em");

ALTER TABLE "previsoes_equipamento" ADD CONSTRAINT "previsoes_equipamento_relatorio_id_fkey" FOREIGN KEY ("relatorio_id") REFERENCES "relatorios_analiticos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "previsoes_equipamento" ADD CONSTRAINT "previsoes_equipamento_equipamento_id_fkey" FOREIGN KEY ("equipamento_id") REFERENCES "equipamentos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE previsoes_equipamento
  ADD CONSTRAINT ck_previsoes_equip_metodo CHECK (metodo IN ('MQO', 'HOLT', 'FALHAS', 'DEPRECIACAO')),
  ADD CONSTRAINT ck_previsoes_equip_restante CHECK (vida_remanescente_anos >= 0);

ALTER TABLE previsoes_vida_util DROP CONSTRAINT ck_previsoes_metodo;
ALTER TABLE previsoes_vida_util ADD CONSTRAINT ck_previsoes_metodo CHECK (metodo IN ('MQO', 'HOLT', 'FALHAS', 'DEPRECIACAO'));

CREATE TRIGGER trg_previsoes_equipamento_imutavel
  BEFORE UPDATE ON previsoes_equipamento
  FOR EACH ROW EXECUTE FUNCTION fn_bloquear_alteracao();
