-- ============================================================
-- APAC-IA SALES — o relatório em PDF no WhatsApp do aluno
--
-- Rode no SQL Editor do Supabase. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose está DESLIGADO: sem o GRANT do bloco final a API responde
-- PGRST205 e parece migration não aplicada.
--
-- 30/10/2026, decisão do responsável: o Relatório 1 e o relatório completo
-- vão em PDF a quem aceitou o acompanhamento e ATIVOU o código — o
-- Relatório 1 assim que a pessoa ativa, o completo quando é gerado, e a
-- versão corrigida quando o relatório é reaberto e gerado de novo.
--
-- O Prescrev publica o PDF (a migration 054 de lá) e o lista pela rota
-- assinada /api/acompanhamento/relatorios; daqui sai o envio
-- (src/services/acompanhamento/relatorios.js). Esta tabela é o que já saiu:
-- uma linha por versão publicada (`relatorio_id`, o id do Prescrev), para
-- nenhuma versão sair duas vezes, e para a seguinte ir como "corrigida" só
-- a quem recebeu a anterior.
--
-- Situação:
--   enviado      saiu ao número da inscrição ativa
--   falhou       o envio deu erro; tenta de novo no ciclo seguinte, até 3
--   substituido  saiu versão mais nova antes desta: esta não sai mais
-- ============================================================

CREATE TABLE IF NOT EXISTS acomp_relatorios (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relatorio_id   UUID NOT NULL,            -- prescrev.report_pdfs.id
  cliente_id     UUID NOT NULL,            -- prescrev.clients.id
  tipo           TEXT NOT NULL CHECK (tipo IN ('inicial', 'completo')),
  versao         TIMESTAMPTZ NOT NULL,     -- o gerado_em do relatório no Prescrev
  phone          TEXT,
  status         TEXT NOT NULL CHECK (status IN ('enviado', 'falhou', 'substituido')),
  corrigido      BOOLEAN NOT NULL DEFAULT false,
  tentativas     SMALLINT NOT NULL DEFAULT 0,
  ultimo_erro    TEXT,
  enviado_em     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_acomp_relatorio ON acomp_relatorios (relatorio_id);
CREATE INDEX IF NOT EXISTS idx_acomp_relatorio_cliente ON acomp_relatorios (cliente_id, tipo);

DROP TRIGGER IF EXISTS trg_acomp_relatorios_updated ON acomp_relatorios;
CREATE TRIGGER trg_acomp_relatorios_updated
  BEFORE UPDATE ON acomp_relatorios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE acomp_relatorios IS
  'O relatório em PDF (Relatório 1 e completo, do Prescrev) enviado ao WhatsApp de quem ativou o acompanhamento: '
  'uma linha por versão publicada.';

ALTER TABLE acomp_relatorios ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON acomp_relatorios TO service_role;
