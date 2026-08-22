-- ============================================================
-- APAC-IA SALES — CRM: consultores, funil de vendas e EVO
--
-- Rode este SQL no Supabase SQL Editor, DEPOIS do 001.
-- É IDEMPOTENTE: pode ser reexecutado sem erro.
--
-- ⚠️ O projeto está com auto-expose de tabelas DESLIGADO. Toda
-- tabela criada aqui precisa do GRANT explícito do bloco 9 —
-- sem ele a API responde PGRST205 ("not found in schema cache"),
-- que parece migration não aplicada e não é.
-- ============================================================

-- ────────────────────────────────────────
-- 0. Tipos ENUM
-- ────────────────────────────────────────

-- Etapas do funil.
--
-- São etapas NOSSAS, derivadas de fatos registrados (mensagem recebida,
-- handoff aberto, webhook do EVO), não de alguém marcar à mão. A decisão
-- veio de um dado: nos 50 prospects mais recentes do EVO, `currentStep`
-- está null em 100% e `temperature` vazio em 100% — espelhar o EVO seria
-- espelhar campo em branco.
--
-- A ordem da declaração é a ordem do funil: enums do Postgres comparam e
-- ordenam pela posição, então ORDER BY stage já sai na ordem certa.
DO $$ BEGIN
  CREATE TYPE crm_stage AS ENUM (
    'novo',                   -- entrou e ainda não houve troca
    'em_conversa',            -- conversando com a Leia
    'aguardando_consultor',   -- handoff aberto, ninguém assumiu
    'com_consultor',          -- consultor assumiu
    'experimental_agendada',  -- aula experimental marcada no EVO
    'experimental_realizada', -- compareceu
    'ganho',                  -- venda registrada
    'perdido'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE crm_role AS ENUM ('consultor', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE crm_sync_status AS ENUM ('pendente', 'sincronizado', 'erro');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ────────────────────────────────────────
-- 1. Consultores (login do painel)
--
-- Senha em scrypt (crypto nativo do Node — sem dependência nova).
-- O formato do hash é "scrypt$N$r$p$salt$derivada", tudo em base64url,
-- para o algoritmo poder mudar sem migration.
--
-- Por que login por pessoa e não senha única: o painel escreve venda
-- em produção no EVO. Sem autor, a tabela de funil não sabe dizer quem
-- agendou, quem vendeu, nem de quem é o lead.
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          crm_role NOT NULL DEFAULT 'consultor',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  evo_id_employee BIGINT,          -- vínculo opcional com o funcionário no EVO
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_users_email ON crm_users (lower(email));

-- ────────────────────────────────────────
-- 2. Leads — a linha do funil
--
-- Tabela deliberadamente DESNORMALIZADA: experimental, venda e último
-- contato ficam em colunas próprias em vez de serem derivados de
-- crm_lead_events a cada consulta. A tabela do funil é a tela mais
-- aberta do painel e precisa responder com um SELECT só; o histórico
-- fiel de como se chegou aqui está em crm_lead_events.
--
-- contact_id é NULLABLE de propósito: nem todo lead nasce no WhatsApp
-- (o consultor cadastra quem chegou na recepção direto no painel).
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_leads (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Identidade
  contact_id      BIGINT REFERENCES wa_contacts(id) ON DELETE SET NULL,
  full_name       TEXT,
  birth_date      DATE,
  email           TEXT,
  phone           TEXT,                  -- normalizado com DDI, como wa_contacts.phone

  -- Vínculo com o EVO
  evo_id_prospect BIGINT,
  evo_id_member   BIGINT,                -- preenchido na conversão
  evo_sync        crm_sync_status NOT NULL DEFAULT 'pendente',
  evo_sync_error  TEXT,
  evo_synced_at   TIMESTAMPTZ,

  -- Funil
  stage           crm_stage NOT NULL DEFAULT 'novo',
  stage_since     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  owner_user_id   BIGINT REFERENCES crm_users(id) ON DELETE SET NULL,
  source          TEXT DEFAULT 'whatsapp',   -- whatsapp | painel | evo | web-test
  interest        TEXT,                      -- modalidade em texto, como a pessoa disse
  evo_interests   INT[] DEFAULT '{}',        -- ids de /api/v2/prospects/interests
  lost_reason     TEXT,

  -- Fatos que a tabela do funil mostra em coluna
  experimental_at       TIMESTAMPTZ,
  experimental_status   TEXT,            -- agendada | realizada | faltou | cancelada
  experimental_activity TEXT,
  sale_at         TIMESTAMPTZ,
  sale_value      NUMERIC(10,2),
  evo_id_sale     BIGINT,

  -- Atividade
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  next_action_at   TIMESTAMPTZ,          -- follow-up combinado
  next_action_note TEXT,

  notes           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_leads_stage    ON crm_leads (stage, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_leads_owner    ON crm_leads (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_crm_leads_contact  ON crm_leads (contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_leads_prospect ON crm_leads (evo_id_prospect);
CREATE INDEX IF NOT EXISTS idx_crm_leads_member   ON crm_leads (evo_id_member);
CREATE INDEX IF NOT EXISTS idx_crm_leads_phone    ON crm_leads (phone);
CREATE INDEX IF NOT EXISTS idx_crm_leads_next     ON crm_leads (next_action_at) WHERE next_action_at IS NOT NULL;

-- Um contato do WhatsApp tem no máximo UM lead aberto. Fechado (ganho ou
-- perdido) pode ter vários ao longo do tempo — quem cancelou ano passado e
-- voltou é lead novo, não reabertura do antigo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_leads_contato_aberto
  ON crm_leads (contact_id)
  WHERE contact_id IS NOT NULL AND stage NOT IN ('ganho', 'perdido');

-- Mesma ideia para o prospect do EVO: não duplicar cadastro lá.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_leads_evo_prospect
  ON crm_leads (evo_id_prospect)
  WHERE evo_id_prospect IS NOT NULL;

-- ────────────────────────────────────────
-- 3. Eventos do lead — o razão do funil
--
-- Toda mudança de etapa, escrita no EVO e ação de consultor vira uma
-- linha aqui. É o que responde "por que este lead está nesta etapa" e
-- "quem fez o quê", que a linha desnormalizada de crm_leads não guarda.
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_lead_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id       BIGINT NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,           -- stage_change | evo_prospect_created | experimental | sale | followup | note
  stage_from    crm_stage,
  stage_to      crm_stage,
  actor         TEXT,                    -- 'leia' | 'user:<id>' | 'evo-webhook' | 'sistema'
  actor_user_id BIGINT REFERENCES crm_users(id) ON DELETE SET NULL,
  summary       TEXT,
  payload       JSONB DEFAULT '{}',
  occurred_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_events_lead ON crm_lead_events (lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_events_type ON crm_lead_events (type, occurred_at DESC);

-- ────────────────────────────────────────
-- 4. Webhooks recebidos do EVO — cru, antes de interpretar
--
-- O EVO manda um envelope enxuto:
--   { IdW12, IdBranch, IdRecord, EventType, ApiCallback }
-- O dado de verdade está atrás do ApiCallback, que precisa ser buscado.
-- Guardar o cru separado do processamento permite reprocessar sem
-- depender de o EVO reenviar.
--
-- ⚠️ O EVO NÃO tem evento de mudança de etapa/status de prospect. Os
-- eventos existentes são NewSale, CreateMember, CreateMembership,
-- ActivityEnroll, TransferProspect e afins. "O consultor mexeu no
-- prospect" só se descobre por polling — ver crm_evo_poll_state.
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_evo_webhook_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type   TEXT NOT NULL,
  id_w12       BIGINT,
  id_branch    INT,
  id_record    BIGINT,
  api_callback TEXT,
  payload      JSONB NOT NULL DEFAULT '{}',   -- envelope recebido
  detail       JSONB,                          -- o que veio do ApiCallback
  lead_id      BIGINT REFERENCES crm_leads(id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ,
  error        TEXT,
  attempts     INT DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_evo_wh_pendentes ON crm_evo_webhook_events (created_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_evo_wh_tipo      ON crm_evo_webhook_events (event_type, created_at DESC);

-- Descarta reentrega do mesmo evento (o EVO reenvia em caso de timeout).
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_evo_wh_dedupe
  ON crm_evo_webhook_events (event_type, id_record, id_branch)
  WHERE id_record IS NOT NULL;

-- ────────────────────────────────────────
-- 5. Estado do poller do EVO
--
-- Preenche o buraco do webhook: varre GET /api/v1/prospects em janela
-- de data para achar o que mudou sem evento (etapa, conversão feita
-- pelo consultor dentro do EVO, aula marcada na recepção).
-- Uma linha por recurso vigiado.
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_evo_poll_state (
  resource     TEXT PRIMARY KEY,         -- 'prospects' | 'sales'
  last_run_at  TIMESTAMPTZ,
  last_cursor  TEXT,                     -- data/hora até onde já leu
  last_error   TEXT,
  runs         BIGINT DEFAULT 0,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────
-- 6. Triggers de updated_at
-- (update_updated_at() já existe, criada na migration 001)
-- ────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_crm_users_updated ON crm_users;
CREATE TRIGGER trg_crm_users_updated
  BEFORE UPDATE ON crm_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_crm_leads_updated ON crm_leads;
CREATE TRIGGER trg_crm_leads_updated
  BEFORE UPDATE ON crm_leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ────────────────────────────────────────
-- 7. stage_since acompanha a mudança de etapa
--
-- Sem isso o "há quanto tempo este lead está parado nesta etapa" — a
-- coluna que faz a tabela do funil ser útil — teria de ser calculada
-- lendo o histórico de eventos a cada linha.
-- ────────────────────────────────────────
CREATE OR REPLACE FUNCTION crm_touch_stage_since()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.stage_since = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_crm_leads_stage ON crm_leads;
CREATE TRIGGER trg_crm_leads_stage
  BEFORE UPDATE ON crm_leads
  FOR EACH ROW EXECUTE FUNCTION crm_touch_stage_since();

-- ────────────────────────────────────────
-- 8. Row Level Security
--
-- Mesmo desenho da 001: RLS ligado SEM policies bloqueia anon e
-- authenticated por completo. O backend usa service_role, que ignora
-- RLS por design. crm_users guarda hash de senha; crm_leads guarda
-- nome, telefone e data de nascimento de cliente.
-- ────────────────────────────────────────
ALTER TABLE crm_users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_leads              ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_lead_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_evo_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_evo_poll_state     ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────
-- 9. Privilégios para a API (PostgREST)
--
-- ⚠️ Sem este bloco a API responde PGRST205 para estas tabelas mesmo
-- elas existindo no banco — o auto-expose deste projeto está desligado.
-- Só service_role recebe grant; anon e authenticated ficam sem nada.
-- ────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  crm_users,
  crm_leads,
  crm_lead_events,
  crm_evo_webhook_events,
  crm_evo_poll_state
TO service_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ────────────────────────────────────────
-- 10. Recarrega o schema cache do PostgREST
-- ────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- 11. Conferência — deve retornar 5 linhas, todas com rls_habilitado = true
-- ────────────────────────────────────────
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables
WHERE schemaname = 'public' AND tablename LIKE 'crm_%'
ORDER BY tablename;
