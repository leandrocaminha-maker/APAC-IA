-- ============================================================
-- APAC-IA SALES — a inscrição do aluno no acompanhamento (etapa A5)
--
-- Rode no SQL Editor do Supabase. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose está DESLIGADO: sem o GRANT do bloco final a API responde
-- PGRST205 e parece migration não aplicada.
--
-- O aluno ativa o acompanhamento mandando "ATIVAR <código>" ao WhatsApp da
-- academia (D2, §5.1 do PLANO_ACOMPANHAMENTO.md do Prescrev). O código vem
-- na ficha; o número de quem mandou fica aqui.
--
-- Situação:
--   ativa      o número é o do cadastro (ou a equipe confirmou): recebe
--   pendente   o número é diferente do cadastro — o código está impresso, e
--              quem pegar o papel não pode passar a receber o acompanhamento
--              de outra pessoa. Espera a confirmação no card do Prescrev.
--   pausada    o aluno pediu pausa (PAUSAR ACOMPANHAMENTO, ou a Leia) —
--              `pausado_ate` quando ele disse até quando
--   encerrada  SAIR, outro número assumiu, ou o professor encerrou
--
-- Um aluno tem no máximo uma inscrição ativa ou pausada; um número, no
-- máximo uma que não esteja encerrada.
-- ============================================================

CREATE TABLE IF NOT EXISTS acomp_inscricoes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id            UUID NOT NULL,            -- prescrev.clients.id
  phone                 TEXT NOT NULL,
  contact_id            BIGINT REFERENCES wa_contacts(id) ON DELETE SET NULL,
  codigo                TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('ativa', 'pendente', 'pausada', 'encerrada')),
  ativado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmado_em         TIMESTAMPTZ,
  confirmado_por        TEXT,
  pausado_ate           DATE,
  encerrado_em          TIMESTAMPTZ,
  motivo_encerramento   TEXT,
  historico             JSONB NOT NULL DEFAULT '[]',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_acomp_inscricao_cliente
  ON acomp_inscricoes (cliente_id) WHERE status IN ('ativa', 'pausada');
CREATE UNIQUE INDEX IF NOT EXISTS uq_acomp_inscricao_phone
  ON acomp_inscricoes (phone) WHERE status IN ('ativa', 'pendente', 'pausada');
CREATE INDEX IF NOT EXISTS idx_acomp_inscricao_cliente ON acomp_inscricoes (cliente_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_acomp_inscricoes_updated ON acomp_inscricoes;
CREATE TRIGGER trg_acomp_inscricoes_updated
  BEFORE UPDATE ON acomp_inscricoes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE acomp_inscricoes IS
  'Inscrição do aluno no acompanhamento: o número que mandou ATIVAR <código>. Pendente quando o número difere '
  'do cadastro, até a equipe confirmar no Prescrev.';

ALTER TABLE acomp_inscricoes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON acomp_inscricoes TO service_role;

NOTIFY pgrst, 'reload schema';

-- Conferência — 1 linha, rls_habilitado = true
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables WHERE schemaname = 'public' AND tablename = 'acomp_inscricoes';
