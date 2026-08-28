-- ============================================================
-- APAC-IA SALES — Marcadores de controle dos workers
--
-- Rode no SQL Editor do Supabase. É IDEMPOTENTE.
--
-- ⚠️ Auto-expose está DESLIGADO: sem o GRANT do bloco final a API responde
-- PGRST205 e parece migration não aplicada.
--
-- POR QUE ESTA TABELA EXISTE
--
-- O relógio da varredura de silêncio vivia em memória (`ultimaVarredura`),
-- e memória zera no boot. Consequência medida em 28/08/2026: três deploys
-- no mesmo dia dispararam três varreduras, e o teto de "15 por hora" virou
-- "15 por deploy" — 45 mensagens em vez de 15.
--
-- Não é caso de tabela própria por worker. É um marcador: uma chave, um
-- instante, e a possibilidade de guardar contexto junto. Uma tabela
-- chave-valor pequena serve a este e aos próximos — o do monitor de
-- conexão, por exemplo, se um dia ele precisar sobreviver a restart.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm_controle (
  chave      TEXT PRIMARY KEY,
  valor      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE crm_controle IS
  'Marcadores de worker que precisam sobreviver a restart. Uma linha por chave.';

DROP TRIGGER IF EXISTS trg_crm_controle_updated ON crm_controle;
CREATE TRIGGER trg_crm_controle_updated
  BEFORE UPDATE ON crm_controle
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE crm_controle ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_controle TO service_role;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────
-- Conferência — 1 linha, rls_habilitado = true
-- ────────────────────────────────────────
SELECT tablename, rowsecurity AS rls_habilitado
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'crm_controle';
