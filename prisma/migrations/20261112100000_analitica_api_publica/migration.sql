-- CreateEnum
CREATE TYPE "CategoriaAnalise" AS ENUM ('EFICIENCIA', 'RENTABILIDADE', 'VIDA_UTIL');

-- CreateEnum
CREATE TYPE "OrigemAnalise" AS ENUM ('AGENDADA', 'SOB_DEMANDA', 'PARCEIRO');

-- CreateEnum
CREATE TYPE "EscopoApi" AS ENUM ('RASTREIO_LER', 'LOTE_LER', 'LOTE_ESCREVER', 'ANALITICA_LER', 'RELATORIO_GERAR');

-- CreateEnum
CREATE TYPE "TipoRelatorio" AS ENUM ('PREVISAO_ATIVOS', 'ANALITICO_COMPLETO');

-- CreateEnum
CREATE TYPE "FormatoRelatorio" AS ENUM ('JSON', 'CSV');

-- CreateEnum
CREATE TYPE "StatusTarefa" AS ENUM ('PENDENTE', 'PROCESSANDO', 'CONCLUIDA', 'FALHOU');

-- AlterTable
ALTER TABLE "equipamentos" ADD COLUMN     "marca" VARCHAR(40),
ADD COLUMN     "modelo" VARCHAR(60),
ADD COLUMN     "valor_recuperado" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "relatorios_analiticos" (
    "id" BIGSERIAL NOT NULL,
    "categoria" "CategoriaAnalise" NOT NULL,
    "origem" "OrigemAnalise" NOT NULL,
    "organizacao_id" UUID,
    "gerado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gerado_por" VARCHAR(32) NOT NULL,
    "amostras" INTEGER NOT NULL,
    "duracao_ms" INTEGER NOT NULL,
    "parametros" JSONB NOT NULL DEFAULT '{}',
    "resultado" JSONB NOT NULL,

    CONSTRAINT "relatorios_analiticos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "previsoes_vida_util" (
    "id" BIGSERIAL NOT NULL,
    "relatorio_id" BIGINT NOT NULL,
    "tipo" "TipoEquipamento" NOT NULL,
    "metodo" VARCHAR(20) NOT NULL,
    "intercepto" DECIMAL(12,6),
    "inclinacao" DECIMAL(12,6),
    "r2" DECIMAL(7,6),
    "amostras" INTEGER NOT NULL,
    "vida_util_anos" DECIMAL(8,2),
    "gerado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "previsoes_vida_util_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execucoes_agendadas" (
    "chave" VARCHAR(80) NOT NULL,
    "instancia" VARCHAR(80) NOT NULL,
    "iniciado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluido_em" TIMESTAMPTZ(3),
    "erro" VARCHAR(500),

    CONSTRAINT "execucoes_agendadas_pkey" PRIMARY KEY ("chave")
);

-- CreateTable
CREATE TABLE "chaves_api" (
    "id" UUID NOT NULL,
    "prefixo" VARCHAR(12) NOT NULL,
    "segredo_hash" CHAR(64) NOT NULL,
    "parceiro" VARCHAR(80) NOT NULL,
    "organizacao_id" UUID NOT NULL,
    "escopos" "EscopoApi"[],
    "limite_por_minuto" INTEGER NOT NULL DEFAULT 60,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "expira_em" TIMESTAMPTZ(3),
    "ultimo_uso_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criado_por" VARCHAR(32) NOT NULL,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "versao" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "chaves_api_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tarefas_relatorio" (
    "id" UUID NOT NULL,
    "chave_api_id" UUID,
    "organizacao_id" UUID,
    "solicitante" VARCHAR(32) NOT NULL,
    "tipo" "TipoRelatorio" NOT NULL,
    "formato" "FormatoRelatorio" NOT NULL,
    "status" "StatusTarefa" NOT NULL DEFAULT 'PENDENTE',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "erro" VARCHAR(500),
    "conteudo" TEXT,
    "tamanho_bytes" INTEGER,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "iniciado_em" TIMESTAMPTZ(3),
    "concluido_em" TIMESTAMPTZ(3),
    "expira_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tarefas_relatorio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "relatorios_analiticos_categoria_gerado_em_idx" ON "relatorios_analiticos"("categoria", "gerado_em");

-- CreateIndex
CREATE INDEX "relatorios_analiticos_organizacao_id_categoria_gerado_em_idx" ON "relatorios_analiticos"("organizacao_id", "categoria", "gerado_em");

-- CreateIndex
CREATE INDEX "previsoes_vida_util_tipo_gerado_em_idx" ON "previsoes_vida_util"("tipo", "gerado_em");

-- CreateIndex
CREATE UNIQUE INDEX "chaves_api_prefixo_key" ON "chaves_api"("prefixo");

-- CreateIndex
CREATE INDEX "chaves_api_organizacao_id_idx" ON "chaves_api"("organizacao_id");

-- CreateIndex
CREATE INDEX "tarefas_relatorio_status_criado_em_idx" ON "tarefas_relatorio"("status", "criado_em");

-- CreateIndex
CREATE INDEX "tarefas_relatorio_chave_api_id_criado_em_idx" ON "tarefas_relatorio"("chave_api_id", "criado_em");

-- CreateIndex
CREATE INDEX "tarefas_relatorio_expira_em_idx" ON "tarefas_relatorio"("expira_em");

-- CreateIndex
CREATE INDEX "equipamentos_tipo_marca_idx" ON "equipamentos"("tipo", "marca");

-- AddForeignKey
ALTER TABLE "relatorios_analiticos" ADD CONSTRAINT "relatorios_analiticos_organizacao_id_fkey" FOREIGN KEY ("organizacao_id") REFERENCES "organizacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previsoes_vida_util" ADD CONSTRAINT "previsoes_vida_util_relatorio_id_fkey" FOREIGN KEY ("relatorio_id") REFERENCES "relatorios_analiticos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chaves_api" ADD CONSTRAINT "chaves_api_organizacao_id_fkey" FOREIGN KEY ("organizacao_id") REFERENCES "organizacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tarefas_relatorio" ADD CONSTRAINT "tarefas_relatorio_chave_api_id_fkey" FOREIGN KEY ("chave_api_id") REFERENCES "chaves_api"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

