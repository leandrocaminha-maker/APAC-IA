-- ============================================================
-- APAC-IA SALES — Follow-up de venda
--
-- Rode no SQL Editor do Supabase, DEPOIS da 002. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose de tabelas está DESLIGADO neste projeto: sem o GRANT
-- do bloco final a API responde PGRST205 e parece migration não aplicada.
-- ============================================================

-- ────────────────────────────────────────
-- Tipos
-- ────────────────────────────────────────

-- Cada tipo é uma INTENÇÃO, não um texto.
--
-- O texto é gerado na hora do envio, porque depende de coisas que só se
-- sabem naquele momento: se a pessoa compareceu à aula, o que já foi
-- conversado, em que etapa o lead está. Guardar a frase pronta no
-- agendamento produziria "como foi a aula?" para quem faltou.
DO $$ BEGIN
  CREATE TYPE crm_followup_tipo AS ENUM (
    'ae_lembrete_24h',   -- 24h antes da aula experimental: confirmar e incentivar
    'ae_pos_aula',       -- 4h depois: consulta presença e pede feedback
    'sondagem_1',        -- 1ª retomada: o que falta para decidir
    'sondagem_2'         -- 2ª e última; depois disso o lead é dado como perdido
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE crm_followup_status AS ENUM (
    'pendente',
    'enviado',
    'cancelado',   -- o lead converteu, foi perdido, ou o motivo deixou de existir
    'falhou'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ────────────────────────────────────────
-- Tabela
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_followups (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id       BIGINT NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  tipo          crm_followup_tipo NOT NULL,
  status        crm_followup_status NOT NULL DEFAULT 'pendente',

  -- Já ajustado para a janela de contato ativo (9h–20h30). Quem agenda é
  -- que empurra; o worker não precisa saber da regra.
  scheduled_for TIMESTAMPTZ NOT NULL,

  -- Contexto de quando foi agendado: horário da aula, atividade, rodada.
  contexto      JSONB DEFAULT '{}',

  -- O que foi efetivamente enviado, para auditoria e para a próxima
  -- rodada não repetir o mesmo argumento.
  mensagem      TEXT,
  presenca      TEXT,                  -- presente | falta | falta_justificada | desconhecida
  erro          TEXT,
  tentativas    INT NOT NULL DEFAULT 0,

  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- A consulta do worker: o que venceu e ainda está de pé.
CREATE INDEX IF NOT EXISTS idx_crm_followups_vencidos
  ON crm_followups (scheduled_for)
  WHERE status = 'pendente';

CREATE INDEX IF NOT EXISTS idx_crm_followups_lead ON crm_followups (lead_id, tipo);

-- Um follow-up de cada tipo por lead, enquanto pendente.
--
-- Sem isto, reagendar a aula experimental (ou uma corrida entre duas
-- mensagens) criaria dois lembretes das mesmas 24h, e a pessoa receberia
-- a mesma cobrança duas vezes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_followups_pendente
  ON crm_followups (lead_id, tipo)
  WHERE status = 'pendente';

DROP TRIGGER IF EXISTS trg_crm_followups_updated ON crm_followups;
CREATE TRIGGER trg_crm_followups_updated
  BEFORE UPDATE ON crm_followups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ────────────────────────────────────────
-- RLS e privilégios
-- ────────────────────────────────────────
ALTER TABLE crm_followups ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_followups TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- Conferência — deve retornar 1 linha, com rls_habilitado = true
-- ────────────────────────────────────────
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'crm_followups';
