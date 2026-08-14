-- ============================================================
-- APAC-IA SALES — WhatsApp + IA Schema
-- Rode este SQL no Supabase SQL Editor
-- ============================================================

-- ────────────────────────────────────────
-- 1. Contatos (vincula telefone → membro EVO)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_contacts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,               -- 5511999999999 (com DDI)
  phone_local   TEXT,                                -- 11999999999 (sem DDI)
  name          TEXT,
  evo_member_id BIGINT,                              -- idMember na API EVO
  is_prospect   BOOLEAN DEFAULT TRUE,
  tags          TEXT[] DEFAULT '{}',
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_contacts_phone ON wa_contacts (phone);
CREATE INDEX IF NOT EXISTS idx_wa_contacts_evo ON wa_contacts (evo_member_id);

-- ────────────────────────────────────────
-- 2. Conversas (sessões de atendimento)
-- ────────────────────────────────────────
CREATE TYPE conversation_status AS ENUM ('active', 'paused', 'human', 'closed');

CREATE TABLE IF NOT EXISTS wa_conversations (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id    BIGINT NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  status        conversation_status DEFAULT 'active',
  channel       TEXT DEFAULT 'whatsapp',
  assigned_to   TEXT,                                -- nome/id do consultor humano
  ai_enabled    BOOLEAN DEFAULT TRUE,
  context       JSONB DEFAULT '{}',                  -- dados adicionais p/ IA
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  last_message  TIMESTAMPTZ DEFAULT NOW(),
  closed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_conv_contact ON wa_conversations (contact_id);
CREATE INDEX IF NOT EXISTS idx_wa_conv_status ON wa_conversations (status);

-- ────────────────────────────────────────
-- 3. Mensagens (histórico completo)
-- ────────────────────────────────────────
CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE message_status AS ENUM ('pending', 'sent', 'delivered', 'read', 'failed');

CREATE TABLE IF NOT EXISTS wa_messages (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT REFERENCES wa_conversations(id) ON DELETE SET NULL,
  contact_id      BIGINT NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  direction       message_direction NOT NULL,
  status          message_status DEFAULT 'pending',
  content_type    TEXT DEFAULT 'text',               -- text, image, document, audio, button
  content         TEXT NOT NULL,
  media_url       TEXT,
  metadata        JSONB DEFAULT '{}',                -- dados do Evolution, IDs etc.
  sent_by         TEXT DEFAULT 'bot',                -- 'bot', 'human:nome', 'app:aquap'
  evolution_msg_id TEXT,                             -- ID da msg na Evolution API
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_msg_conv ON wa_messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_wa_msg_contact ON wa_messages (contact_id);
CREATE INDEX IF NOT EXISTS idx_wa_msg_created ON wa_messages (created_at DESC);

-- ────────────────────────────────────────
-- 4. Fila de mensagens (apps irmãos enfileiram aqui)
-- ────────────────────────────────────────
CREATE TYPE queue_status AS ENUM ('pending', 'processing', 'sent', 'failed');

CREATE TABLE IF NOT EXISTS wa_message_queue (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone         TEXT NOT NULL,
  content_type  TEXT DEFAULT 'text',
  content       TEXT NOT NULL,
  media_url     TEXT,
  source_app    TEXT NOT NULL,                       -- 'aquap', 'pagtos_ap', 'nfse'
  status        queue_status DEFAULT 'pending',
  attempts      INT DEFAULT 0,
  max_attempts  INT DEFAULT 3,
  error         TEXT,
  scheduled_for TIMESTAMPTZ DEFAULT NOW(),           -- agendamento futuro
  processed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_queue_status ON wa_message_queue (status, scheduled_for);

-- ────────────────────────────────────────
-- 5. Prompts de IA (editáveis sem deploy)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_ai_prompts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,                  -- 'vendas', 'atendimento', 'cobranca'
  title       TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  is_active   BOOLEAN DEFAULT TRUE,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────
-- 6. Transferências para humano (handoffs)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_human_handoffs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
  contact_id      BIGINT NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  reason          TEXT,
  assigned_to     TEXT,
  resolved        BOOLEAN DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_handoff_conv ON wa_human_handoffs (conversation_id);

-- ────────────────────────────────────────
-- 7. Trigger para updated_at automático
-- ────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_wa_contacts_updated
  BEFORE UPDATE ON wa_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_wa_prompts_updated
  BEFORE UPDATE ON wa_ai_prompts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ────────────────────────────────────────
-- 8. Seed: prompt base de vendas
-- ────────────────────────────────────────
INSERT INTO wa_ai_prompts (slug, title, system_prompt) VALUES (
  'vendas',
  'Consultor de Vendas AP Academia',
  E'Você é a Ana, consultora virtual da AP Academia de Natação e Hidroginástica.\n\nSua missão é atender potenciais clientes com simpatia, profissionalismo e objetividade.\n\n## Sobre a AP Academia\n- Academia de natação e hidroginástica em São Paulo\n- Modalidades: Natação Infantil (3-12 anos), Natação Adulto, Hidroginástica, Natação para Bebês\n- Estrutura: piscina aquecida, vestiários, recepção\n- Diferenciais: metodologia própria de ensino, avaliações periódicas de nível, turmas reduzidas\n\n## Regras de Atendimento\n1. Sempre cumprimente o cliente pelo nome quando disponível\n2. Seja breve e objetiva — mensagens curtas no WhatsApp\n3. Use emojis com moderação (máximo 2 por mensagem)\n4. NUNCA invente preços — use a ferramenta buscar_planos para consultar valores atualizados\n5. NUNCA invente horários — use a ferramenta buscar_horarios para consultar a grade\n6. Ofereça AULA EXPERIMENTAL gratuita como próximo passo\n7. Se o cliente demonstrar interesse, cadastre como prospect no sistema\n8. Se a conversa ficar complexa (reclamação, negociação especial, assunto financeiro), transfira para um consultor humano\n9. Não responda sobre assuntos fora do escopo da academia\n10. Horário de atendimento: seg-sex 6h-21h, sáb 8h-13h\n\n## Tom de Voz\n- Profissional mas acolhedor\n- Usa \"você\" (nunca \"tu\")\n- Evita gírias mas não é formal demais\n- Demonstra entusiasmo genuíno pela natação e seus benefícios'
) ON CONFLICT (slug) DO NOTHING;
