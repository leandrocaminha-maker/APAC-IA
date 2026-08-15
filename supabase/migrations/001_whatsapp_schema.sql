-- ============================================================
-- APAC-IA SALES — WhatsApp + IA Schema
-- Rode este SQL no Supabase SQL Editor.
--
-- Este script é IDEMPOTENTE: pode ser executado quantas vezes
-- for necessário sem dar erro (útil se uma execução anterior
-- falhou no meio e sofreu rollback).
-- ============================================================

-- ────────────────────────────────────────
-- 0. Tipos ENUM (criados só se não existirem)
-- ────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE conversation_status AS ENUM ('active', 'paused', 'human', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE message_status AS ENUM ('pending', 'sent', 'delivered', 'read', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE queue_status AS ENUM ('pending', 'processing', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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
-- Usado pelo carregamento de histórico do agente (últimas N da conversa)
CREATE INDEX IF NOT EXISTS idx_wa_msg_conv_created ON wa_messages (conversation_id, created_at DESC);
-- Usado pela atualização de status vinda do webhook
CREATE INDEX IF NOT EXISTS idx_wa_msg_evo_id ON wa_messages (evolution_msg_id);

-- ────────────────────────────────────────
-- 4. Fila de mensagens (apps irmãos enfileiram aqui)
-- ────────────────────────────────────────
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

DROP TRIGGER IF EXISTS trg_wa_contacts_updated ON wa_contacts;
CREATE TRIGGER trg_wa_contacts_updated
  BEFORE UPDATE ON wa_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_wa_prompts_updated ON wa_ai_prompts;
CREATE TRIGGER trg_wa_prompts_updated
  BEFORE UPDATE ON wa_ai_prompts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ────────────────────────────────────────
-- 8. Row Level Security
--
-- Estas tabelas guardam telefone, nome e histórico de conversa
-- de clientes. O projeto Supabase é o mesmo do AQUAP, cuja anon
-- key é pública (vai no bundle do Next.js) — sem RLS qualquer
-- pessoa com essa key leria tudo.
--
-- Habilitamos RLS SEM criar policies: isso bloqueia anon e
-- authenticated por completo. O backend APAC-IA SALES usa a
-- service_role key, que ignora RLS por design.
-- ────────────────────────────────────────
ALTER TABLE wa_contacts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_message_queue  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_ai_prompts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_human_handoffs ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────
-- 8b. Privilégios para a API (PostgREST)
--
-- O PostgREST só inclui no schema cache as tabelas em que os roles da API
-- têm privilégio. Sem estes GRANTs a API responde PGRST205
-- ("Could not find the table ... in the schema cache") mesmo com as tabelas
-- existindo no banco — dá para confirmar em pg_tables e ainda assim a API
-- não enxergar.
--
-- Concedemos APENAS para service_role, que é o role usado pelo backend
-- APAC-IA SALES. anon e authenticated ficam sem grant nenhum: além do RLS
-- acima, não têm sequer permissão de tabela.
-- ────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  wa_contacts,
  wa_conversations,
  wa_messages,
  wa_message_queue,
  wa_ai_prompts,
  wa_human_handoffs
TO service_role;

-- Sequences das colunas GENERATED ALWAYS AS IDENTITY (necessário p/ INSERT)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ────────────────────────────────────────
-- 9. Seed: prompt base de vendas
--
-- Este é apenas um BOOTSTRAP seguro para o banco não nascer vazio.
-- O prompt real e completo vive em src/prompts/vendas.md e é carregado
-- por cima deste — manter o texto completo aqui faria as duas versões
-- divergirem na primeira edição.
--
-- Preços, planos e horários NÃO entram no prompt: vêm dos arquivos em
-- src/prompts/knowledge/, anexados ao contexto a cada resposta.
-- ────────────────────────────────────────
INSERT INTO wa_ai_prompts (slug, title, system_prompt) VALUES (
  'vendas',
  'Consultor de Vendas AP Academia',
  E'Você é a Leia, consultora virtual da AP Academia — uma academia completa, com musculação, aulas coletivas, atividades aquáticas, Pilates Fit Studio e Escola de Natação Infantil e Bebês.\n\nATENÇÃO: este é um prompt provisório. O prompt completo está em src/prompts/vendas.md e precisa ser carregado neste registro.\n\nRegras mínimas enquanto isso:\n1. NUNCA invente preços, horários ou regras. Tudo o que você pode afirmar está na BASE DE CONHECIMENTO abaixo. Se não estiver lá, use transferir_para_humano.\n2. Escreva para WhatsApp: negrito com um asterisco só (*assim*), nunca ** ou tabelas.\n3. Mensagens curtas, de 2 a 4 linhas. Uma pergunta por mensagem.\n4. Assunto financeiro, app FITI, afastamento, cancelamento ou reclamação: transfira imediatamente sem tentar resolver.'
) ON CONFLICT (slug) DO NOTHING;

-- ────────────────────────────────────────
-- 10. Recarrega o cache de schema do PostgREST
--
-- Sem isso a API do Supabase pode continuar respondendo
-- "Could not find the table ... in the schema cache" mesmo
-- com as tabelas já criadas.
-- ────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- 11. Conferência — deve retornar 6 linhas
-- ────────────────────────────────────────
SELECT tablename,
       rowsecurity AS rls_habilitado
FROM pg_tables
WHERE schemaname = 'public' AND tablename LIKE 'wa_%'
ORDER BY tablename;
