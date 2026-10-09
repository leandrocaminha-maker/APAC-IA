-- ============================================================
-- APAC-IA SALES — a ponte: professor e aluno pelo número da academia (A5d)
--
-- Rode no SQL Editor do Supabase. É IDEMPOTENTE. Aplicar ANTES do deploy:
-- o código novo grava `aluno_phone` no encaminhamento e lê as duas tabelas.
--
-- ⚠️ Auto-expose está DESLIGADO: sem os GRANTs a API responde PGRST205 e
-- parece migration não aplicada.
--
-- Pedido do responsável em 09/10/2026: alguns professores não querem dar o
-- número pessoal ao aluno. O professor responde no WhatsApp dele, ao número
-- da academia, CITANDO o briefing (ou uma mensagem do aluno repassada); o
-- APAC repassa ao aluno pelo número da academia, assinado com o nome dele, e
-- a resposta do aluno volta ao professor do mesmo jeito. Ninguém vê o número
-- de ninguém. Detalhe na A5d do PLANO_ACOMPANHAMENTO.md do Prescrev.
--
-- acomp_pontes      uma conversa professor ↔ aluno. Uma aberta por aluno; a
--                   resposta do aluno vai a quem escreveu por último. Fecha
--                   no "2" do encaminhamento ou depois de 72 h sem mensagem.
-- acomp_ponte_fila  o que o aluno mandou e ainda vai ao professor: na hora
--                   (com os balões agrupados), ou no começo do turno dele —
--                   mensagem à equipe só no horário de trabalho.
-- ============================================================

-- O número do aluno, que até aqui só aparecia no texto do briefing (wa.me).
ALTER TABLE acomp_encaminhamentos ADD COLUMN IF NOT EXISTS aluno_phone TEXT;

CREATE TABLE IF NOT EXISTS acomp_pontes (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aluno_phone             TEXT NOT NULL,
  aluno                   TEXT NOT NULL,            -- primeiro nome
  cliente_id              UUID,                     -- prescrev.clients.id; nulo no teste
  encaminhamento_id       UUID REFERENCES acomp_encaminhamentos(id) ON DELETE SET NULL,
  teste                   BOOLEAN NOT NULL DEFAULT FALSE,
  -- quem escreveu por último: é a ele que a resposta do aluno vai
  professor_profile_id    UUID NOT NULL,
  professor_nome          TEXT NOT NULL,
  professor_phone         TEXT NOT NULL,
  aberta_em               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultima_em               TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- nos dois sentidos
  ultima_do_professor_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fechada_em              TIMESTAMPTZ,
  motivo_fechamento       TEXT,
  historico               JSONB NOT NULL DEFAULT '[]',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_acomp_ponte_aberta ON acomp_pontes (aluno_phone) WHERE fechada_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_acomp_ponte_encaminhamento ON acomp_pontes (encaminhamento_id);

DROP TRIGGER IF EXISTS trg_acomp_pontes_updated ON acomp_pontes;
CREATE TRIGGER trg_acomp_pontes_updated
  BEFORE UPDATE ON acomp_pontes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS acomp_ponte_fila (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ponte_id          UUID NOT NULL REFERENCES acomp_pontes(id) ON DELETE CASCADE,
  wa_message_id     BIGINT REFERENCES wa_messages(id) ON DELETE SET NULL,  -- a mensagem do aluno
  evolution_msg_id  TEXT,              -- para baixar a mídia
  tipo              TEXT NOT NULL,     -- text, audio, image, video, document
  texto             TEXT,
  enviar_em         TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'entregue', 'falhou')),
  entregue_em       TIMESTAMPTZ,
  erro              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_acomp_ponte_fila_pendente ON acomp_ponte_fila (enviar_em) WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS idx_acomp_ponte_fila_ponte ON acomp_ponte_fila (ponte_id);

COMMENT ON TABLE acomp_pontes IS
  'Conversa professor ↔ aluno pelo número da academia (A5d): o professor cita o briefing, o APAC repassa assinado. '
  'Uma aberta por aluno; fecha no "2" ou com 72 h sem mensagem.';
COMMENT ON TABLE acomp_ponte_fila IS
  'Mensagens do aluno a caminho do professor da ponte: na hora, ou no começo do turno dele.';

ALTER TABLE acomp_pontes ENABLE ROW LEVEL SECURITY;
ALTER TABLE acomp_ponte_fila ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON acomp_pontes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON acomp_ponte_fila TO service_role;
-- A identidade da fila precisa da sequence (como na 001 e na 005)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';

-- Conferência — 2 linhas, rls_habilitado = true; e a coluna nova
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('acomp_pontes', 'acomp_ponte_fila');
SELECT column_name FROM information_schema.columns
WHERE table_name = 'acomp_encaminhamentos' AND column_name = 'aluno_phone';
