-- ============================================================
-- APAC-IA SALES — os avisos da avaliação física
--
-- Rode no SQL Editor do Supabase. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose está DESLIGADO: sem o GRANT do bloco final a API responde
-- PGRST205 e parece migration não aplicada.
--
-- 03/11/2026, decisão do responsável. Três mensagens a quem comprou a
-- avaliação física (o serviço "AF E CONSULTORIA" do EVO):
--
--   venda      na compra (webhook NewSale): o link do questionário e o preparo
--   tres_dias  3 dias antes (automação 1 do CRM do EVO): o horário e o preparo,
--              e o link só se o questionário ainda não chegou ao Prescrev
--   vespera    24 h antes (automação 2, ou a 1 já a deixa marcada): o horário,
--              o preparo e até quando se desmarca sem a taxa (12 h antes)
--
-- Uma linha por aviso. `referencia` é o que o torna único: a venda
-- (`venda:<idSale>`) ou a sessão da agenda (`idActivitieSession`) — a sessão
-- remarcada é outra sessão, e ganha avisos novos; os da antiga caem na hora
-- de sair, quando a sessão não está mais na agenda.
--
-- Situação:
--   pendente   espera a hora (`previsto_para`)
--   enviado    saiu ao WhatsApp
--   simulado   chegou à hora com o envio desligado: `texto` é o que sairia
--   cancelado  não sai mais, e `motivo` diz por quê
--   falhou     deu erro 3 vezes
-- ============================================================

CREATE TABLE IF NOT EXISTS aval_avisos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_member       INTEGER NOT NULL,
  etapa           TEXT NOT NULL CHECK (etapa IN ('venda', 'tres_dias', 'vespera')),
  referencia      TEXT NOT NULL,
  id_sale         INTEGER,
  id_sessao       INTEGER,                 -- idActivitieSession do EVO
  sessao_em       TIMESTAMPTZ,
  professor       TEXT,
  nome            TEXT,
  phone           TEXT,
  email           TEXT,
  genero          TEXT CHECK (genero IN ('F', 'M') OR genero IS NULL),
  previsto_para   TIMESTAMPTZ NOT NULL,
  prazo           TIMESTAMPTZ NOT NULL,    -- depois disto não sai mais
  status          TEXT NOT NULL DEFAULT 'pendente'
                    CHECK (status IN ('pendente', 'enviado', 'simulado', 'cancelado', 'falhou')),
  questionario    BOOLEAN,                 -- o Prescrev já tinha a resposta, na hora do envio
  texto           TEXT,
  motivo          TEXT,
  tentativas      SMALLINT NOT NULL DEFAULT 0,
  evento_id       BIGINT,                  -- crm_evo_webhook_events.id que criou o aviso
  enviado_em      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_aval_aviso ON aval_avisos (id_member, etapa, referencia);
CREATE INDEX IF NOT EXISTS idx_aval_aviso_pendente ON aval_avisos (previsto_para) WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS idx_aval_aviso_membro ON aval_avisos (id_member, created_at DESC);

DROP TRIGGER IF EXISTS trg_aval_avisos_updated ON aval_avisos;
CREATE TRIGGER trg_aval_avisos_updated
  BEFORE UPDATE ON aval_avisos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE aval_avisos IS
  'Avisos da avaliação física pelo WhatsApp: na compra, 3 dias antes e na véspera. Uma linha por aviso.';

ALTER TABLE aval_avisos ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON aval_avisos TO service_role;
